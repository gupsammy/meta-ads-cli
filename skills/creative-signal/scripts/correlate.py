#!/usr/bin/env python3
"""Attribute → hook-rate / hold-rate correlation with explicit confidence (spec §9, §10).

Reads the store (per-ad hook/hold over a window + cached creative tags), tests every
attribute against each metric, and writes signals.json. Stdlib only — Mann-Whitney U,
Cohen's d and Benjamini-Hochberg are implemented here; no scipy/numpy.

Method (one observation = one ad, unweighted; ads below --min-impressions are excluded):
  categorical attribute  with (attr == value) vs rest, one test per value
                         (a two-valued attribute is tested once — the other side is its mirror)
  numeric attribute      median split: (attr >= median) vs rest   [open Q §16 → resolved: median]
  per test               n_group, n_rest, means, lift_pct, Cohen's d (pooled), two-sided
                         Mann-Whitney U p (normal approx, tie + continuity correction),
                         BH q-value across all tests in the run
  confidence             strong       both n ≥ 20, |d| ≥ 0.5, p < 0.05
                         directional  both n ≥ 8, lift and d agree in sign, p < 0.20
                         anecdotal    anything else that clears the minimum group size (3)

Honesty rules baked in: hook/hold are proxies, v1 makes NO revenue claim (Shopify seam is a
stub); the run block carries n_tests and every signal carries q_value so the brief can state
multiple-comparison risk; missing values are "attribute absent", never zero.

Usage:
    python3 correlate.py --since YYYY-MM-DD --until YYYY-MM-DD [-o signals.json]
                         [--min-impressions 1000] [--label last_14d] [--db PATH]
    python3 correlate.py --window last_14d [--today YYYY-MM-DD] ...
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_shopify  # noqa: E402
import store  # noqa: E402

CORRELATE_VERSION = 1
METRICS = ("hook_rate", "hold_rate")
MIN_IMPRESSIONS = 1000       # below this a single day's noise dominates the rate
MIN_GROUP = 3                # smaller than this there is nothing to report, even anecdotally
# Free text / identifiers / lists — shown per ad, never correlated.
NON_ATTRIBUTES = {
    "transcript", "hook_text", "cta_text", "cut_times", "width", "height", "aspect_value",
    "deterministic_version", "audio_analysis_warnings",
}
WINDOWS = {"last_7d": 7, "last_14d": 14, "last_30d": 30}


# ── stats (stdlib) ────────────────────────────────────────────────────────────
def mann_whitney_p(a: list[float], b: list[float]) -> float | None:
    """Two-sided Mann-Whitney U, normal approximation with tie correction and continuity
    correction. Adequate for n ≥ 8 per group; below that the result is flagged anecdotal
    anyway, so an exact table is not worth the code."""
    n1, n2 = len(a), len(b)
    if n1 == 0 or n2 == 0:
        return None
    pooled = sorted([(v, 0) for v in a] + [(v, 1) for v in b], key=lambda t: t[0])
    n = n1 + n2
    ranks = [0.0] * n
    tie_term = 0.0
    i = 0
    while i < n:
        j = i
        while j + 1 < n and pooled[j + 1][0] == pooled[i][0]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[k] = r
        t = j - i + 1
        if t > 1:
            tie_term += t ** 3 - t
        i = j + 1
    r1 = sum(rank for rank, (_, g) in zip(ranks, pooled) if g == 0)
    u1 = r1 - n1 * (n1 + 1) / 2
    u = min(u1, n1 * n2 - u1)
    mu = n1 * n2 / 2
    sigma_sq = n1 * n2 / 12 * ((n + 1) - tie_term / (n * (n - 1)))
    if sigma_sq <= 0:
        return 1.0
    z = max(0.0, (abs(u - mu) - 0.5) / math.sqrt(sigma_sq))
    return min(1.0, math.erfc(z / math.sqrt(2)))


def cohens_d(a: list[float], b: list[float]) -> float | None:
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        return None
    v1, v2 = statistics.variance(a), statistics.variance(b)
    pooled = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    if pooled == 0:
        return 0.0 if statistics.fmean(a) == statistics.fmean(b) else None
    return (statistics.fmean(a) - statistics.fmean(b)) / pooled


def benjamini_hochberg(p_values: list[float]) -> list[float]:
    """BH-adjusted q-values, same order as input. Monotone, clamped to 1."""
    m = len(p_values)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: p_values[i])
    q = [0.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        running = min(running, p_values[i] * m / rank)
        q[i] = min(1.0, running)
    return q


def confidence(n_group: int, n_rest: int, d: float | None, p: float | None, lift: float | None) -> str:
    if d is None or p is None:
        return "anecdotal"
    if n_group >= 20 and n_rest >= 20 and abs(d) >= 0.5 and p < 0.05:
        return "strong"
    same_sign = lift is not None and (lift == 0 or (lift > 0) == (d > 0))
    if n_group >= 8 and n_rest >= 8 and same_sign and p < 0.20:
        return "directional"
    return "anecdotal"


# ── attribute → tests ─────────────────────────────────────────────────────────
def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and not (isinstance(v, float) and math.isnan(v))


def _splits(attr: str, values: list) -> list[tuple[str, list[bool]]]:
    """Return [(label, mask)] where mask[i] is True for the 'with' group."""
    present = [v for v in values if v is not None]
    if len(present) < 2 * MIN_GROUP:
        return []
    if all(_is_num(v) for v in present):
        med = statistics.median(present)
        mask = [v is not None and v >= med for v in values]
        n_with = sum(mask)
        if n_with == len(present) or n_with == 0:
            return []  # constant (or everything at the median) — no split
        return [(f"{attr}>={med:g}", mask)]
    distinct = sorted({str(v).lower() if isinstance(v, bool) else str(v) for v in present})
    if len(distinct) < 2:
        return []
    if len(distinct) == 2:  # one test; the other value is the mirror image
        keep = "true" if "true" in distinct else distinct[0]
        distinct = [keep]
    out = []
    for val in distinct:
        mask = [v is not None and (str(v).lower() if isinstance(v, bool) else str(v)) == val for v in values]
        out.append((f"{attr}={val}", mask))
    return out


def compute_signals(ads: list[dict]) -> tuple[list[dict], int]:
    """ads: [{ad_id, hook_rate, hold_rate, attributes:{…}}] already filtered to eligible ads.
    Returns (signals sorted by confidence then |effect|, n_tests)."""
    attrs = sorted({k for a in ads for k in (a.get("attributes") or {}) if k not in NON_ATTRIBUTES})
    raw = []
    for metric in METRICS:
        rows = [a for a in ads if a.get(metric) is not None]
        for attr in attrs:
            values = [(a.get("attributes") or {}).get(attr) for a in rows]
            for label, mask in _splits(attr, values):
                with_ = [a[metric] for a, m, v in zip(rows, mask, values) if m and v is not None]
                without = [a[metric] for a, m, v in zip(rows, mask, values) if not m and v is not None]
                if len(with_) < MIN_GROUP or len(without) < MIN_GROUP:
                    continue
                mw, mo = statistics.fmean(with_), statistics.fmean(without)
                lift = (mw - mo) / mo if mo else None
                d = cohens_d(with_, without)
                p = mann_whitney_p(with_, without)
                raw.append({
                    "attribute": label, "metric": metric,
                    "n_group": len(with_), "n_rest": len(without),
                    "mean_with": round(mw, 4), "mean_without": round(mo, 4),
                    "lift_pct": round(lift, 4) if lift is not None else None,
                    "effect_size": round(d, 3) if d is not None else None,
                    "p_value": round(p, 4) if p is not None else None,
                    "confidence": confidence(len(with_), len(without), d, p, lift),
                })
    qs = benjamini_hochberg([s["p_value"] if s["p_value"] is not None else 1.0 for s in raw])
    for s, q in zip(raw, qs):
        s["q_value"] = round(q, 4)
    rank = {"strong": 0, "directional": 1, "anecdotal": 2}
    raw.sort(key=lambda s: (rank[s["confidence"]], -(abs(s["effect_size"]) if s["effect_size"] is not None else 0)))
    return raw, len(raw)


# ── assemble from the store ───────────────────────────────────────────────────
def _attributes_from_tags(t: dict | None) -> dict | None:
    if not t:
        return None
    out: dict = {}
    det = t.get("deterministic")
    if isinstance(det, dict):
        feats: dict = det["features"] if isinstance(det.get("features"), dict) else det
        out.update(feats)
        if "audio_analysis" in det:
            out["audio_analysis"] = det["audio_analysis"]
    tags = t.get("tags")
    if isinstance(tags, dict):
        out.update({k: v for k, v in tags.items() if k != "tag_failed"})
    return out or None


def build_ads(conn, since: str, until: str, min_impressions: int = MIN_IMPRESSIONS) -> tuple[list[dict], dict]:
    """Per-ad rows for signals.json + counters for warnings."""
    counts = {"total": 0, "no_video_view": 0, "untagged": 0, "below_min": 0, "partial_retention": 0, "eligible": 0}
    out = []
    for a in store.aggregate_ads(conn, since, until):
        counts["total"] += 1
        flags = []
        attrs = _attributes_from_tags(store.get_tags(conn, a["asset_hash"])) if a.get("asset_hash") else None
        if attrs is None:
            flags.append("untagged"); counts["untagged"] += 1
        if a["hook_rate"] is None:
            flags.append("no_video_view"); counts["no_video_view"] += 1
        elif a["hold_rate"] is None:
            flags.append("partial_retention"); counts["partial_retention"] += 1
        if (a["impressions"] or 0) < min_impressions:
            flags.append("below_min_impressions"); counts["below_min"] += 1
        eligible = attrs is not None and a["hook_rate"] is not None and "below_min_impressions" not in flags
        if eligible:
            counts["eligible"] += 1
        out.append({
            "ad_id": a["ad_id"], "ad_name": a["ad_name"], "campaign_name": a["campaign_name"],
            "impressions": a["impressions"], "video_view": a["video_view"], "thruplay": a["thruplay"],
            "hook_rate": a["hook_rate"], "hold_rate": a["hold_rate"],
            "attributes": attrs or {}, "flags": flags, "eligible": eligible,
        })
    return out, counts


def run(conn, since: str, until: str, *, label: str | None = None, min_impressions: int = MIN_IMPRESSIONS,
        account_id: str | None = None, model: str = "gemini-3.1-flash-lite") -> dict:
    ads, c = build_ads(conn, since, until, min_impressions)
    eligible = [a for a in ads if a["eligible"]]
    signals, n_tests = compute_signals(eligible)
    shop = fetch_shopify.fetch(since, until)
    warnings = []
    if c["no_video_view"]:
        warnings.append(f"{c['no_video_view']} ads have no video_view (image/metadata-only) — excluded from hook/hold")
    if c["untagged"]:
        warnings.append(f"{c['untagged']} ads untagged (no cached creative tags) — excluded from correlation")
    if c["below_min"]:
        warnings.append(f"{c['below_min']} ads below min_impressions={min_impressions} — excluded")
    if c["partial_retention"]:
        warnings.append(f"{c['partial_retention']} video ads lack hold_rate (retention fields not fetched for the full window)")
    if c["eligible"] < 20:
        warnings.append(f"only {c['eligible']} eligible ads — nothing can reach 'strong'; treat every signal as a hypothesis")
    warnings.append(f"{n_tests} attribute×metric tests in this run — p_value is per-test, q_value is Benjamini-Hochberg "
                    f"adjusted; hook/hold-rate are proxies and v1 makes no revenue or ROAS claim")
    return {
        "run": {
            "correlate_version": CORRELATE_VERSION, "window": label or f"{since}..{until}",
            "since": since, "until": until, "account_id": account_id,
            "n_ads": c["total"], "n_eligible": c["eligible"], "n_tests": n_tests,
            "min_impressions": min_impressions, "model": model, "shopify_enabled": bool(shop.get("enabled")),
            "confidence_rules": {"strong": "both n>=20, |d|>=0.5, p<0.05",
                                 "directional": "both n>=8, sign-consistent, p<0.20", "anecdotal": "otherwise"},
        },
        "ads": ads,
        "signals": signals,
        "warnings": warnings,
    }


def window_dates(window: str, today: str | None = None) -> tuple[str, str]:
    if window not in WINDOWS:
        raise ValueError(f"window must be one of {sorted(WINDOWS)}")
    t = date.fromisoformat(today) if today else date.today()
    until = t - timedelta(days=1)  # Meta's presets end yesterday; today is partial
    since = until - timedelta(days=WINDOWS[window] - 1)
    return since.isoformat(), until.isoformat()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since"); ap.add_argument("--until")
    ap.add_argument("--window", choices=sorted(WINDOWS), help="preset instead of --since/--until (ends yesterday)")
    ap.add_argument("--today", default=None, help="override today for --window (tests / replays)")
    ap.add_argument("--label", default=None, help="window label recorded in run.window")
    ap.add_argument("--min-impressions", type=int, default=MIN_IMPRESSIONS)
    ap.add_argument("--account-id", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("-o", "--out", default=None, help="write signals.json here (default stdout)")
    a = ap.parse_args(argv)
    try:
        if a.window:
            since, until = window_dates(a.window, a.today)
            label = a.label or a.window
        elif a.since and a.until:
            since, until, label = a.since, a.until, a.label
        else:
            raise ValueError("pass --window or both --since and --until")
        if since > until:
            raise ValueError("--since must be on or before --until")
        conn = store.connect(a.db)
        result = run(conn, since, until, label=label, min_impressions=a.min_impressions, account_id=a.account_id)
    except (ValueError, OSError, store.sqlite3.Error) as e:
        print(f"[correlate] error: {e}", file=sys.stderr)
        return 1
    text = json.dumps(result, indent=2)
    if a.out:
        Path(a.out).write_text(text + "\n", encoding="utf-8")
        r = result["run"]
        print(f"[correlate] wrote {a.out} · {r['n_eligible']}/{r['n_ads']} ads eligible · {r['n_tests']} tests · "
              f"{sum(s['confidence'] == 'strong' for s in result['signals'])} strong", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
