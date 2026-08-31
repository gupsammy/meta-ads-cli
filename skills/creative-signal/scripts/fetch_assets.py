"""creative-signal asset fetcher (spec §4.4, §4.5, §6): native videos for untagged ads.

The CLI side is `meta-ads intel fetch-daily --keep-video`, which re-downloads EVERY current
ad video and atomically replaces ~/.meta-ads-intel/creatives/ (a snapshot, not an archive).
That is why this script exists separately from sync.py: it runs only when the store has ads
that still need an asset, and the durable artefact it produces is the `ads.asset_hash` +
`ads.video_path` pair, not the file. tag_gemini / deterministic should run right after.

The CLI emits no asset hash; the skill computes sha256(video.mp4) as the tag-cache key
(several ads can share one creative) and stores `creative_id` from creatives-master.json
beside it.

What each ad ends up with after a run:
  video ad in snapshot   asset_hash = sha256(video), video_path set          → tag candidates
  image ad in snapshot   asset_hash = sha256(image.png), video_path NULL     → v1 tags video only
  not in snapshot        asset_hash = "unavailable", video_path NULL         → deleted / over the
                         500-ad cap; a re-fetch would not help, so it is no longer a candidate.
                         `--recheck` clears these sentinels first (e.g. after ads reactivate).

CLI:
  fetch_assets.py                 fetch only if some ad needs an asset (or has a stale path)
  fetch_assets.py --force         fetch even if nothing needs it
  fetch_assets.py --recheck       also retry ads previously marked unavailable
  fetch_assets.py --dry-run       report candidates, no CLI call, no writes
  fetch_assets.py --register-only skip the CLI; (re)hash whatever the creatives dir holds now
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
import sync  # noqa: E402

UNAVAILABLE = "unavailable"
WINDOW_DAYS = 7          # metrics window the --keep-video pull also ingests (idempotent with sync)
DEFAULT_DATA_DIR = Path.home() / ".meta-ads-intel" / "data"


def data_dir() -> Path:
    return Path(os.environ.get("META_ADS_DATA_DIR") or DEFAULT_DATA_DIR)


def creatives_dir(dd: Path | None = None) -> Path:
    # Mirrors creatives.ts: path.join(path.dirname(dataDir), 'creatives')
    return (dd or data_dir()).parent / "creatives"


def sha256_file(path: str | os.PathLike) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(cdir: Path) -> list[dict]:
    p = cdir / "manifest.json"
    if not p.is_file():
        return []
    data = json.loads(p.read_text())
    return data if isinstance(data, list) else []


def load_creative_lookup(dd: Path) -> dict[str, str | None]:
    """ad_id → creative_id from creatives-master.json ({data:[{id, creative_id}]} or a list)."""
    p = dd / "creatives-master.json"
    if not p.is_file():
        return {}
    raw = json.loads(p.read_text())
    rows = raw.get("data", []) if isinstance(raw, dict) else raw
    return {str(r["id"]): r.get("creative_id") for r in rows if isinstance(r, dict) and r.get("id")}


# ── candidates ──────────────────────────────────────────────────────────────────
def needs_asset(conn, *, recheck: bool = False) -> list[dict]:
    """Ads a fresh snapshot could help: no asset yet, a previously-unavailable one when
    rechecking, or a video path that no longer exists on disk (snapshot replaced since)."""
    out = []
    for ad in store.untagged_ads(conn):
        h, vp = ad.get("asset_hash"), ad.get("video_path")
        if h is None:
            out.append(ad)
        elif h == UNAVAILABLE:
            if recheck:
                out.append(ad)
        elif vp and not Path(vp).is_file():
            out.append(ad)
    return out


# ── register the snapshot into the store ────────────────────────────────────────
@dataclass
class RegisterResult:
    registered: list[str] = field(default_factory=list)   # ad_ids with a video hash
    image_ads: list[str] = field(default_factory=list)    # hashed image, no video
    unavailable: list[str] = field(default_factory=list)  # candidates absent from the snapshot
    unknown_ads: int = 0                                  # in snapshot, not in the roster (no delivery yet)
    distinct_videos: int = 0


def register_assets(conn, manifest: list[dict], lookup: dict[str, str | None],
                    candidates: list[dict]) -> RegisterResult:
    res = RegisterResult()
    roster = {r["ad_id"] for r in conn.execute("SELECT ad_id FROM ads")}
    seen: set[str] = set()
    hashes: set[str] = set()
    with conn:  # one transaction for the whole snapshot (up to 500 ads), not one commit per row
        for entry in manifest:
            ad_id = str(entry.get("ad_id") or "")
            if not ad_id:
                continue
            seen.add(ad_id)
            if ad_id not in roster:
                res.unknown_ads += 1
                continue
            vp = entry.get("video_path")
            if vp and Path(vp).is_file():
                h = sha256_file(vp)
                store.set_ad_asset_nocommit(conn, ad_id, lookup.get(ad_id), h, str(vp))
                res.registered.append(ad_id)
                hashes.add(h)
                continue
            adir = entry.get("artifacts_dir")
            img = Path(adir) / "image.png" if adir else None
            if img and img.is_file():
                store.set_ad_asset_nocommit(conn, ad_id, lookup.get(ad_id), sha256_file(img), None)
                res.image_ads.append(ad_id)
        for ad in candidates:
            if ad["ad_id"] not in seen:
                store.set_ad_asset_nocommit(conn, ad["ad_id"], ad.get("creative_id"), UNAVAILABLE, None)
                res.unavailable.append(ad["ad_id"])
    res.distinct_videos = len(hashes)
    return res


# ── orchestration ───────────────────────────────────────────────────────────────
@dataclass
class FetchAssetsResult:
    candidates: int
    fetched: bool
    window: tuple[str, str] | None = None
    cli: dict | None = None            # fetch-daily's `creatives` summary + row count
    ingested_rows: int = 0
    register: RegisterResult | None = None
    warnings: list[str] = field(default_factory=list)
    dry_run: bool = False

    def to_dict(self) -> dict:
        r = self.register
        return {
            "candidates": self.candidates, "fetched": self.fetched, "window": self.window,
            "cli": self.cli, "ingested_rows": self.ingested_rows,
            "registered": len(r.registered) if r else 0,
            "distinct_videos": r.distinct_videos if r else 0,
            "image_ads": len(r.image_ads) if r else 0,
            "unavailable": r.unavailable if r else [],
            "unknown_ads": r.unknown_ads if r else 0,
            "warnings": self.warnings, "dry_run": self.dry_run,
        }


def fetch_assets(conn, *, today: str | None = None, window_days: int = WINDOW_DAYS,
                 force: bool = False, recheck: bool = False, dry_run: bool = False,
                 register_only: bool = False, fetch=sync.run_fetch_daily,
                 dd: Path | None = None) -> FetchAssetsResult:
    dd = dd or data_dir()
    if recheck and not dry_run:
        with conn:
            conn.execute("UPDATE ads SET asset_hash=NULL WHERE asset_hash=?", (UNAVAILABLE,))
    cands = needs_asset(conn, recheck=recheck)
    res = FetchAssetsResult(candidates=len(cands), fetched=False, dry_run=dry_run)
    if not cands and not force and not register_only:
        return res
    if dry_run:
        return res
    if not register_only:
        t = date.fromisoformat(today) if today else date.today()
        since, until = (t - timedelta(days=window_days)).isoformat(), t.isoformat()
        res.window = (since, until)
        result = fetch(since, until, keep_video=True)
        res.fetched = True
        path = result.get("file")
        if path:
            res.ingested_rows = store.ingest_daily_file(conn, path, since, until).rows
        cli = dict(result.get("creatives") or {})
        res.cli = {**cli, "rows": result.get("rows")}
        res.warnings.extend(cli.get("warnings") or [])
        if not cli:
            res.warnings.append("CLI ran without the video step (ffmpeg missing or no current creatives) — nothing to register")
        # roster may have grown (new ads in the window) → recompute before registering
        cands = needs_asset(conn, recheck=False)
    manifest = load_manifest(creatives_dir(dd))
    if not manifest:
        res.warnings.append(f"no manifest at {creatives_dir(dd) / 'manifest.json'}")
    res.register = register_assets(conn, manifest, load_creative_lookup(dd), cands)
    if res.register.unavailable:
        res.warnings.append(f"{len(res.register.unavailable)} ad(s) not in the current creative snapshot "
                            "(deleted or over the 500-ad cap) — marked unavailable; --recheck retries them")
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="creative-signal: fetch native videos for untagged ads")
    ap.add_argument("--db", help="SQLite path (default $CREATIVE_SIGNAL_DB or ~/.meta-ads-intel/creative-signal.db)")
    ap.add_argument("--today", help="YYYY-MM-DD (default: today) — end of the metrics window the pull also ingests")
    ap.add_argument("--window-days", type=int, default=WINDOW_DAYS)
    ap.add_argument("--force", action="store_true", help="fetch even if no ad needs an asset")
    ap.add_argument("--recheck", action="store_true", help="retry ads previously marked unavailable")
    ap.add_argument("--dry-run", action="store_true", help="report candidates; no CLI call, no writes")
    ap.add_argument("--register-only", action="store_true", help="skip the CLI; hash what the creatives dir holds now")
    a = ap.parse_args(argv)
    try:
        if a.today:
            date.fromisoformat(a.today)
        conn = store.connect(a.db)
        res = fetch_assets(conn, today=a.today, window_days=a.window_days, force=a.force,
                           recheck=a.recheck, dry_run=a.dry_run, register_only=a.register_only)
        print(json.dumps(res.to_dict(), indent=2))
        return 0
    except (sync.FetchError, store.sqlite3.Error, ValueError, OSError) as e:
        print(f"fetch_assets: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
