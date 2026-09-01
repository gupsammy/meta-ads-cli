"""creative-signal orchestrator (spec §4.3, §6): one analysis run, end to end.

  1. sync        store.catch_up_window → fetch-daily (trailing 7 d + gap) → store   [--no-sync]
  2. assets      fetch_assets: --keep-video pull ONLY if some ad still needs a video
  3. deterministic  ffmpeg core (+ librosa lane if installed) for videos without features
  4. gemini      tag_gemini: one call per new asset_hash                            [--no-tag]
  5. correlate   attribute → hook/hold signals over --window → signals.json

Every step is idempotent and cached, so re-running is cheap: no new ads → no downloads, no
Gemini calls; only correlate recomputes. Steps 3 and 4 degrade to warnings (a bad video or a
missing GEMINI_API_KEY never blocks the analysis — the ad simply lacks those attributes).

Output dir: --out, else $CREATIVE_SIGNAL_OUT, else ~/.meta-ads-intel/creative-signal/runs/<until>/
  signals.json      correlate output (spec §10) — the agent authors brief.md from this
  run-status.json   per-step summary + warnings (also printed to stdout)

Exit: 0 ok · 1 error · 3 store empty (run backfill.py first).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import correlate  # noqa: E402
import deterministic  # noqa: E402
import fetch_assets  # noqa: E402
import store  # noqa: E402
import sync  # noqa: E402
import tag_gemini  # noqa: E402

EXIT_NEEDS_BACKFILL = sync.EXIT_NEEDS_BACKFILL
DEFAULT_OUT_ROOT = Path.home() / ".meta-ads-intel" / "creative-signal" / "runs"
INTEL_CONFIG = Path.home() / ".meta-ads-intel" / "config.json"


class NeedsBackfill(RuntimeError):
    pass


def out_dir(explicit: str | None, until: str) -> Path:
    root = Path(explicit or os.environ.get("CREATIVE_SIGNAL_OUT") or DEFAULT_OUT_ROOT)
    return root if explicit else root / until


def resolve_account_id(conn, explicit: str | None = None, config_path: Path = INTEL_CONFIG) -> str | None:
    """--account-id → META_ADS_ACCOUNT_ID → ~/.meta-ads-intel/config.json → whatever the store holds."""
    if explicit:
        return explicit
    if os.environ.get("META_ADS_ACCOUNT_ID"):
        return os.environ["META_ADS_ACCOUNT_ID"]
    try:
        v = json.loads(Path(config_path).read_text()).get("account_id")
        if v:
            return str(v)
    except (OSError, ValueError, AttributeError):
        pass
    row = conn.execute("SELECT account_id FROM ad_day_metrics WHERE account_id IS NOT NULL LIMIT 1").fetchone()
    return row[0] if row else None


# ── step 3: deterministic features for videos that lack them ───────────────────
def run_deterministic(conn, *, analyze=deterministic.analyze) -> dict:
    """One ffmpeg pass per new asset_hash. ANY failure (ffmpeg, unreadable file, malformed
    ffprobe JSON, ...) is cached as an empty feature set so the same broken file is not
    re-analysed every run; correlate treats it as attribute-absent. The error text lands in
    the run warnings, so nothing is swallowed silently."""
    out = {"analyzed": 0, "failed": 0, "shared_ads": 0, "warnings": []}
    done: set[str] = set()
    for ad in store.untagged_ads(conn, need="deterministic"):
        h, vp = ad["asset_hash"], ad["video_path"]
        if h in done:
            out["shared_ads"] += 1
            continue
        done.add(h)
        try:
            result = analyze(vp)
            out["analyzed"] += 1
        except Exception as e:  # noqa: BLE001 — per-asset boundary: one bad video must never abort the run
            result = {"deterministic_version": deterministic.DETERMINISTIC_VERSION,
                      "audio_analysis": "none", "features": {}, "failed": True, "warnings": [str(e)]}
            out["failed"] += 1
            out["warnings"].append(f"deterministic failed for ad {ad['ad_id']}: {e}")
        store.upsert_tags(conn, h, creative_id=ad.get("creative_id"), deterministic=result)
    return out


# ── the run ─────────────────────────────────────────────────────────────────────
def run(conn, *, window: str = "last_14d", today: str | None = None, out: str | None = None,
        account_id: str | None = None, no_sync: bool = False, no_tag: bool = False,
        max_tags: int = tag_gemini.DEFAULT_MAX_ADS, min_impressions: int = correlate.MIN_IMPRESSIONS,
        sync_fn=sync.catch_up, assets_fn=fetch_assets.fetch_assets, analyze=deterministic.analyze,
        tag_fn=tag_gemini.tag_untagged, correlate_fn=correlate.run, config_path: Path = INTEL_CONFIG) -> dict:
    since, until = correlate.window_dates(window, today)
    status: dict = {"window": window, "since": since, "until": until, "steps": {}, "warnings": []}

    # 1. sync
    if no_sync:
        status["steps"]["sync"] = {"skipped": True}
        if store.max_date(conn) is None:
            raise NeedsBackfill("store is empty — run backfill.py first (spec §4.2)")
    else:
        res = sync_fn(conn, today)
        if res is None:
            raise NeedsBackfill("store is empty — run backfill.py first (spec §4.2)")
        status["steps"]["sync"] = res.as_dict()

    # 2. assets (downloads only when something needs a video)
    fa = assets_fn(conn, today=today)
    status["steps"]["assets"] = fa.to_dict()
    status["warnings"].extend(fa.warnings)

    # 3. deterministic
    det = run_deterministic(conn, analyze=analyze)
    status["steps"]["deterministic"] = det
    status["warnings"].extend(det["warnings"])

    # 4. gemini
    if no_tag:
        status["steps"]["gemini"] = {"skipped": True}
    else:
        try:
            tg = tag_fn(conn, max_ads=max_tags)
            status["steps"]["gemini"] = tg.to_dict()
            status["warnings"].extend(e["error"] for e in tg.errors)
        except tag_gemini.ApiUnavailable as e:
            status["steps"]["gemini"] = {"skipped": True, "reason": str(e)}
            status["warnings"].append(f"gemini tagging skipped: {e}")

    # 5. correlate
    acct = resolve_account_id(conn, account_id, config_path)
    result = correlate_fn(conn, since, until, label=window, min_impressions=min_impressions, account_id=acct)
    counts = {c: sum(s["confidence"] == c for s in result["signals"]) for c in ("strong", "directional", "anecdotal")}
    r = result["run"]
    status["steps"]["correlate"] = {"n_ads": r["n_ads"], "n_eligible": r["n_eligible"], "n_tests": r["n_tests"], **counts}
    status["warnings"].extend(result["warnings"])

    od = out_dir(out, until)
    od.mkdir(parents=True, exist_ok=True)
    (od / "signals.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    status["out_dir"] = str(od)
    status["signals_file"] = str(od / "signals.json")
    status["account_id"] = acct
    (od / "run-status.json").write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    return status


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--window", default="last_14d", choices=sorted(correlate.WINDOWS))
    ap.add_argument("--today", default=None, help="override today (YYYY-MM-DD); tests / replays")
    ap.add_argument("--out", default=None, help="output dir (default ~/.meta-ads-intel/creative-signal/runs/<until>/)")
    ap.add_argument("--account-id", default=None)
    ap.add_argument("--no-sync", action="store_true", help="analyse the store as-is (offline)")
    ap.add_argument("--no-tag", action="store_true", help="skip Gemini (deterministic features still computed)")
    ap.add_argument("--max-tags", type=int, default=tag_gemini.DEFAULT_MAX_ADS, help="cap Gemini calls this run")
    ap.add_argument("--min-impressions", type=int, default=correlate.MIN_IMPRESSIONS)
    ap.add_argument("--db", default=None)
    a = ap.parse_args(argv)
    old_umask = os.umask(0o077)   # spend data: every file this run writes is private
    try:
        if a.today:
            date.fromisoformat(a.today)
        conn = store.connect(a.db)
        status = run(conn, window=a.window, today=a.today, out=a.out, account_id=a.account_id,
                     no_sync=a.no_sync, no_tag=a.no_tag, max_tags=a.max_tags, min_impressions=a.min_impressions)
    except NeedsBackfill as e:
        print(f"[run] {e}", file=sys.stderr)
        return EXIT_NEEDS_BACKFILL
    except (sync.FetchError, tag_gemini.TagError, store.sqlite3.Error, OSError, ValueError) as e:
        print(f"[run] error: {e}", file=sys.stderr)
        return 1
    finally:
        os.umask(old_umask)
    print(json.dumps(status, indent=2))
    c = status["steps"]["correlate"]
    print(f"[run] {status['signals_file']} · {c['n_eligible']}/{c['n_ads']} ads eligible · "
          f"{c['strong']} strong / {c['directional']} directional / {c['anecdotal']} anecdotal", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
