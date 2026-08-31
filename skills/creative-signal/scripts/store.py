#!/usr/bin/env python3
"""SQLite store for creative-signal (spec §4.1) — fetch history once, then append.

Grain is ad × day. Everything upserts on (ad_id, date), so double-runs, overlapping
backfill chunks and the mandatory trailing-7-day re-fetch are all safe: a re-fetched
day simply overwrites the row with Meta's revised numbers.

Tables
  ad_day_metrics  one row per ad per day; hook/hold inputs (video_view = Meta's 3 s view,
                  thruplay, quartiles) + spend/purchases kept for tier 5 (unused in v1).
  ads             one row per ad ever seen; creative_id / asset_hash / video_path filled
                  by fetch_assets, first_seen/last_seen maintained on ingest.
  creative_tags   tag-once cache keyed by asset_hash (several ads can share one creative).
  fetch_log       every window ingested, for audit + gap reasoning.

Location: $CREATIVE_SIGNAL_DB, else ~/.meta-ads-intel/creative-signal.db (shared home with
meta-ads-intel; NOT the maisonx warehouse). Stdlib only.

CLI (for humans / smoke tests — sync.py and backfill.py import the functions):
    python3 store.py init
    python3 store.py ingest <ads-daily.json> --since YYYY-MM-DD --until YYYY-MM-DD
    python3 store.py status
    python3 store.py gap [--today YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCHEMA_VERSION = 1
DEFAULT_DB = Path.home() / ".meta-ads-intel" / "creative-signal.db"
# Meta keeps revising recent days (delayed conversions, attribution windows). Every
# catch-up re-fetches this many trailing days on top of the gap. Spec §4.3.
TRAILING_DAYS = 7

SCHEMA = """
CREATE TABLE IF NOT EXISTS ad_day_metrics (
  ad_id            TEXT NOT NULL,
  date             TEXT NOT NULL,            -- YYYY-MM-DD (Meta's date_start)
  account_id       TEXT,
  campaign_id      TEXT,
  campaign_name    TEXT,
  adset_id         TEXT,
  adset_name       TEXT,
  ad_name          TEXT,
  impressions      INTEGER NOT NULL DEFAULT 0,
  reach            INTEGER,
  frequency        REAL,
  clicks           INTEGER NOT NULL DEFAULT 0,
  spend            REAL    NOT NULL DEFAULT 0,
  video_view       INTEGER,                  -- Meta 3 s views (hook numerator)
  thruplay         INTEGER,                  -- 15 s-or-complete (hold numerator); NULL pre-0.19 pulls
  p25              INTEGER,
  p50              INTEGER,
  p75              INTEGER,
  p100             INTEGER,
  avg_watch_s      REAL,
  retention_fetched INTEGER NOT NULL DEFAULT 0, -- 1 = the pull requested video_*_watched_actions,
                                                --     so a NULL thruplay on this row means zero
  purchases        INTEGER,                  -- tier 5 only; v1 makes no revenue claim
  purchase_value   REAL,
  quality_ranking  TEXT,
  engagement_rate_ranking TEXT,
  conversion_rate_ranking TEXT,
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (ad_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ad_day_metrics_date ON ad_day_metrics(date);

CREATE TABLE IF NOT EXISTS ads (
  ad_id        TEXT PRIMARY KEY,
  ad_name      TEXT,
  campaign_id  TEXT,
  campaign_name TEXT,
  adset_id     TEXT,
  creative_id  TEXT,
  asset_hash   TEXT,                         -- sha256(video.mp4); tag-cache key
  video_path   TEXT,
  first_seen   TEXT NOT NULL,                -- earliest metrics date
  last_seen    TEXT NOT NULL                 -- latest metrics date
);

CREATE TABLE IF NOT EXISTS creative_tags (
  asset_hash         TEXT PRIMARY KEY,
  creative_id        TEXT,
  tags_json          TEXT,                   -- Gemini output (spec §8)
  deterministic_json TEXT,                   -- deterministic.py output (spec §7)
  tagger_model       TEXT,
  tagged_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  rows         INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL
);
"""

METRIC_COLUMNS = (
    "ad_id", "date", "account_id", "campaign_id", "campaign_name", "adset_id", "adset_name",
    "ad_name", "impressions", "reach", "frequency", "clicks", "spend", "video_view", "thruplay",
    "p25", "p50", "p75", "p100", "avg_watch_s", "retention_fetched", "purchases", "purchase_value",
    "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking",
)
RETENTION_KEYS = (
    "video_thruplay_watched_actions", "video_p25_watched_actions", "video_p50_watched_actions",
    "video_p75_watched_actions", "video_p100_watched_actions", "video_avg_time_watched_actions",
)


# ── connection / schema ───────────────────────────────────────────────────────
def db_path(explicit: str | os.PathLike | None = None) -> Path:
    if explicit:
        return Path(explicit)
    env = os.environ.get("CREATIVE_SIGNAL_DB")
    return Path(env) if env else DEFAULT_DB


def connect(path: str | os.PathLike | None = None) -> sqlite3.Connection:
    p = db_path(path)
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    conn = sqlite3.connect(p)
    try:
        os.chmod(p, 0o600)  # ad spend is sensitive — tighten BEFORE any write, not after schema init
    except OSError:
        pass
    conn.row_factory = sqlite3.Row
    # sync.py / backfill.py ingest while status/gap may read: wait briefly instead of
    # raising "database is locked" on the first overlap.
    conn.execute("PRAGMA busy_timeout = 5000")
    init_schema(conn)
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ── row normalization (pure) ──────────────────────────────────────────────────
def _attr_guard(entries) -> list[dict]:
    """Port of metrics.ts attrGuard: drop per-attribution-window duplicates when the
    plain (windowless) entries exist, else keep whatever came back."""
    raw = entries or []
    plain = [e for e in raw if "action_attribution_window" not in e]
    return plain if plain else raw


def _first(entries, priority: tuple[str, ...]) -> float | None:
    """Port of metrics.ts omniFirst — first matching action_type wins; None if absent."""
    by_type = {e.get("action_type"): e.get("value") for e in _attr_guard(entries)}
    for t in priority:
        if t in by_type and by_type[t] is not None:
            try:
                return float(by_type[t])
            except (TypeError, ValueError):
                return None
    return None


def _retention(entries) -> float | None:
    """video_*_watched_actions arrive as [{action_type:'video_view', value:'N'}]. Prefer
    video_view, else the first entry — Meta has shipped both shapes."""
    v = _first(entries, ("video_view",))
    if v is not None:
        return v
    guarded = _attr_guard(entries)
    val = guarded[0].get("value") if guarded else None
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _int(v) -> int | None:
    return None if v is None else int(round(v))


def _num(v, cast=float):
    if v in (None, ""):
        return None
    try:
        return cast(v)
    except (TypeError, ValueError):
        return None


def has_retention_keys(raw: dict) -> bool:
    return any(k in raw for k in RETENTION_KEYS)


def normalize_row(raw: dict, retention_fetched: bool | None = None) -> dict:
    """Meta ad-level insights row (time_increment=1) → ad_day_metrics column dict.

    `retention_fetched` is provenance, not data: Meta OMITS an action array when its value is
    zero, so a missing thruplay key on one row is ambiguous (zero, or never requested?). The
    ingest batch resolves it — if ANY row in the pull carries a retention key, the fields were
    requested and every NULL in that batch is a true zero. Pass None to fall back to this row
    alone (single-row callers)."""
    actions = raw.get("actions")
    if retention_fetched is None:
        retention_fetched = has_retention_keys(raw)
    return {
        "ad_id": str(raw["ad_id"]),
        "date": raw["date_start"],
        "account_id": raw.get("account_id"),
        "campaign_id": raw.get("campaign_id"),
        "campaign_name": raw.get("campaign_name"),
        "adset_id": raw.get("adset_id"),
        "adset_name": raw.get("adset_name"),
        "ad_name": raw.get("ad_name"),
        "impressions": _num(raw.get("impressions"), int) or 0,
        "reach": _num(raw.get("reach"), int),
        "frequency": _num(raw.get("frequency")),
        "clicks": _num(raw.get("clicks"), int) or 0,
        "spend": _num(raw.get("spend")) or 0.0,
        "video_view": _int(_first(actions, ("video_view",))),
        "thruplay": _int(_retention(raw.get("video_thruplay_watched_actions"))),
        "p25": _int(_retention(raw.get("video_p25_watched_actions"))),
        "p50": _int(_retention(raw.get("video_p50_watched_actions"))),
        "p75": _int(_retention(raw.get("video_p75_watched_actions"))),
        "p100": _int(_retention(raw.get("video_p100_watched_actions"))),
        "avg_watch_s": _retention(raw.get("video_avg_time_watched_actions")),
        "retention_fetched": 1 if retention_fetched else 0,
        "purchases": _int(_first(actions, ("omni_purchase", "purchase"))),
        "purchase_value": _first(raw.get("action_values"), ("omni_purchase", "purchase")),
        "quality_ranking": raw.get("quality_ranking"),
        "engagement_rate_ranking": raw.get("engagement_rate_ranking"),
        "conversion_rate_ranking": raw.get("conversion_rate_ranking"),
    }


# ── writes ────────────────────────────────────────────────────────────────────
@dataclass
class IngestResult:
    rows: int
    new_ad_ids: list[str]
    since: str
    until: str


def upsert_metrics(conn: sqlite3.Connection, rows: list[dict], fetched_at: str | None = None) -> int:
    fetched_at = fetched_at or _now()
    cols = (*METRIC_COLUMNS, "fetched_at")
    placeholders = ",".join("?" * len(cols))
    updates = ",".join(f"{c}=excluded.{c}" for c in cols if c not in ("ad_id", "date"))
    sql = (f"INSERT INTO ad_day_metrics ({','.join(cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT(ad_id, date) DO UPDATE SET {updates}")
    conn.executemany(sql, [tuple(r.get(c) for c in METRIC_COLUMNS) + (fetched_at,) for r in rows])
    return len(rows)


def upsert_ads(conn: sqlite3.Connection, rows: list[dict]) -> list[str]:
    """Maintain the ads roster from metrics rows. Returns ad_ids seen for the first time —
    sync.py uses that list to decide whether a --keep-video pull is needed (spec §4.4)."""
    if not rows:
        return []
    ids = sorted({r["ad_id"] for r in rows})
    existing = set()
    for i in range(0, len(ids), 500):  # SQLite variable limit
        chunk = ids[i:i + 500]
        q = f"SELECT ad_id FROM ads WHERE ad_id IN ({','.join('?' * len(chunk))})"
        existing.update(r[0] for r in conn.execute(q, chunk))
    # One pass: per ad, the newest row supplies naming; min/max date supply the seen range.
    per_ad: dict[str, dict] = {}
    for r in rows:
        cur = per_ad.get(r["ad_id"])
        if cur is None:
            per_ad[r["ad_id"]] = {**r, "first_seen": r["date"], "last_seen": r["date"]}
        else:
            if r["date"] > cur["last_seen"]:
                cur.update(r, last_seen=r["date"])
            cur["first_seen"] = min(cur["first_seen"], r["date"])
    conn.executemany(
        """INSERT INTO ads (ad_id, ad_name, campaign_id, campaign_name, adset_id, first_seen, last_seen)
           VALUES (:ad_id, :ad_name, :campaign_id, :campaign_name, :adset_id, :first_seen, :last_seen)
           ON CONFLICT(ad_id) DO UPDATE SET
             -- naming follows the newest day only: backfill chunks land in any order, and an
             -- older window must not clobber a rename already recorded from a newer one
             ad_name       = CASE WHEN excluded.last_seen >= ads.last_seen THEN excluded.ad_name       ELSE ads.ad_name       END,
             campaign_id   = CASE WHEN excluded.last_seen >= ads.last_seen THEN excluded.campaign_id   ELSE ads.campaign_id   END,
             campaign_name = CASE WHEN excluded.last_seen >= ads.last_seen THEN excluded.campaign_name ELSE ads.campaign_name END,
             adset_id      = CASE WHEN excluded.last_seen >= ads.last_seen THEN excluded.adset_id      ELSE ads.adset_id      END,
             first_seen=MIN(ads.first_seen, excluded.first_seen),
             last_seen=MAX(ads.last_seen, excluded.last_seen)""",
        list(per_ad.values()),
    )
    return [i for i in ids if i not in existing]


def record_fetch(conn: sqlite3.Connection, since: str, until: str, rows: int, fetched_at: str | None = None) -> None:
    conn.execute("INSERT INTO fetch_log (window_start, window_end, rows, fetched_at) VALUES (?,?,?,?)",
                 (since, until, rows, fetched_at or _now()))


def load_daily_file(path: str | os.PathLike) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = data.get("data", []) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise ValueError(f"{path}: expected a list or {{'data': [...]}}")
    return rows


def ingest_daily(conn: sqlite3.Connection, raw_rows: list[dict], since: str, until: str) -> IngestResult:
    """One transaction: metrics upsert + ads roster + fetch_log. Idempotent."""
    retention = any(has_retention_keys(r) for r in raw_rows)  # batch provenance, see normalize_row
    rows = [normalize_row(r, retention_fetched=retention) for r in raw_rows]
    now = _now()
    with conn:
        upsert_metrics(conn, rows, now)
        new_ids = upsert_ads(conn, rows)
        record_fetch(conn, since, until, len(rows), now)
    return IngestResult(rows=len(rows), new_ad_ids=new_ids, since=since, until=until)


def ingest_daily_file(conn: sqlite3.Connection, path: str | os.PathLike, since: str, until: str) -> IngestResult:
    return ingest_daily(conn, load_daily_file(path), since, until)


# ── gap / catch-up ────────────────────────────────────────────────────────────
def max_date(conn: sqlite3.Connection) -> str | None:
    return conn.execute("SELECT MAX(date) FROM ad_day_metrics").fetchone()[0]


def catch_up_window(conn: sqlite3.Connection, today: str | None = None,
                    trailing_days: int = TRAILING_DAYS) -> tuple[str, str] | None:
    """(since, until) the next fetch-daily should cover: (max_stored − trailing) → today.
    None when the store is empty — that is a backfill, not a catch-up (spec §4.2/4.3)."""
    latest = max_date(conn)
    if latest is None:
        return None
    today_d = date.fromisoformat(today) if today else date.today()
    since_d = min(date.fromisoformat(latest) - timedelta(days=trailing_days), today_d)
    return since_d.isoformat(), today_d.isoformat()


# ── reads for the analysis step ───────────────────────────────────────────────
def aggregate_ads(conn: sqlite3.Connection, since: str, until: str) -> list[dict]:
    """Per-ad sums over [since, until] plus hook_rate (video_view ÷ impressions) and
    hold_rate (thruplay ÷ video_view). Never 0 by accident:
      - hook_rate is None when impressions are 0 or the ad never logged a video_view (image ads).
        video_view lives in `actions`, which every pull requests, so a NULL day IS zero.
      - hold_rate is None when video_view is 0 OR any day in the window has
        retention_fetched=0 (pre-0.19 pull): a partial SUM would silently understate it.
        With full coverage NULL thruplay days are zeros (Meta omits empty action arrays)."""
    q = """
      SELECT m.ad_id, a.ad_name, a.campaign_name, a.creative_id, a.asset_hash,
             COUNT(*) AS days, SUM(m.retention_fetched) AS retention_days,
             SUM(m.impressions) AS impressions, SUM(m.clicks) AS clicks, SUM(m.spend) AS spend,
             SUM(m.video_view) AS video_view, SUM(COALESCE(m.thruplay, 0)) AS thruplay,
             SUM(m.p25) AS p25, SUM(m.p50) AS p50, SUM(m.p75) AS p75, SUM(m.p100) AS p100,
             SUM(m.purchases) AS purchases, SUM(m.purchase_value) AS purchase_value
      FROM ad_day_metrics m LEFT JOIN ads a USING (ad_id)
      WHERE m.date BETWEEN ? AND ?
      GROUP BY m.ad_id ORDER BY impressions DESC"""
    out = []
    for r in conn.execute(q, (since, until)):
        d = dict(r)
        d["hook_rate"] = _ratio(d["video_view"], d["impressions"])
        full_coverage = d["retention_days"] == d["days"]
        if not full_coverage:
            d["thruplay"] = None  # don't hand a partial sum downstream either
        d["hold_rate"] = _ratio(d["thruplay"], d["video_view"]) if full_coverage else None
        out.append(d)
    return out


def _ratio(num, den) -> float | None:
    if num is None or not den:
        return None
    return round(num / den, 4)


def untagged_ads(conn: sqlite3.Connection, since: str | None = None, *,
                 need: str | None = None, retry_failed: bool = False) -> list[dict]:
    """Ads with no cached tags. Optional `since` limits to ads seen on/after that date.

    need=None           → no asset_hash yet (video never fetched) OR no creative_tags row.
    need="tags"         → video fetched but Gemini tags missing (row absent or tags_json NULL);
    need="deterministic"→ same for deterministic_json. Both require video_path. The per-producer forms exist because
    upsert_tags allows partial rows: a deterministic-only row must not hide an ad from Gemini.
    retry_failed=True (need="tags" only) also returns rows flagged {"tag_failed": true}."""
    if need is None:
        cond = "(a.asset_hash IS NULL OR t.asset_hash IS NULL)"
    elif need in ("tags", "deterministic"):
        col = "t.tags_json" if need == "tags" else "t.deterministic_json"
        # video_path required: image ads and unavailable assets carry a hash (so they stop being
        # fetch candidates) but have nothing a video tagger can consume.
        cond = f"a.asset_hash IS NOT NULL AND a.video_path IS NOT NULL AND (t.asset_hash IS NULL OR {col} IS NULL"
        if need == "tags" and retry_failed:
            cond += " OR json_extract(t.tags_json, '$.tag_failed') = 1"
        cond += ")"
    else:
        raise ValueError(f"need must be None, 'tags' or 'deterministic', got {need!r}")
    q = f"""SELECT a.* FROM ads a LEFT JOIN creative_tags t ON t.asset_hash = a.asset_hash
            WHERE {cond}"""
    args: tuple = ()
    if since:
        q += " AND a.last_seen >= ?"
        args = (since,)
    return [dict(r) for r in conn.execute(q + " ORDER BY a.last_seen DESC", args)]


def set_ad_asset(conn: sqlite3.Connection, ad_id: str, creative_id: str | None,
                 asset_hash: str | None, video_path: str | None) -> None:
    with conn:
        set_ad_asset_nocommit(conn, ad_id, creative_id, asset_hash, video_path)


def set_ad_asset_nocommit(conn: sqlite3.Connection, ad_id: str, creative_id: str | None,
                          asset_hash: str | None, video_path: str | None) -> None:
    """Same UPDATE without the commit — for callers batching many rows in one transaction."""
    conn.execute("UPDATE ads SET creative_id=?, asset_hash=?, video_path=? WHERE ad_id=?",
                 (creative_id, asset_hash, video_path, ad_id))


def upsert_tags(conn: sqlite3.Connection, asset_hash: str, *, creative_id: str | None = None,
                tags: dict | None = None, deterministic: dict | None = None,
                tagger_model: str | None = None) -> None:
    """Tag-once cache write. Partial updates allowed: passing only `deterministic` keeps an
    existing `tags_json` (and vice versa) so the two producers can land independently."""
    with conn:
        conn.execute(
            """INSERT INTO creative_tags (asset_hash, creative_id, tags_json, deterministic_json, tagger_model, tagged_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(asset_hash) DO UPDATE SET
                 creative_id=COALESCE(excluded.creative_id, creative_tags.creative_id),
                 tags_json=COALESCE(excluded.tags_json, creative_tags.tags_json),
                 deterministic_json=COALESCE(excluded.deterministic_json, creative_tags.deterministic_json),
                 tagger_model=COALESCE(excluded.tagger_model, creative_tags.tagger_model),
                 tagged_at=excluded.tagged_at""",
            (asset_hash, creative_id,
             json.dumps(tags) if tags is not None else None,
             json.dumps(deterministic) if deterministic is not None else None,
             tagger_model, _now()),
        )


def get_tags(conn: sqlite3.Connection, asset_hash: str) -> dict | None:
    r = conn.execute("SELECT * FROM creative_tags WHERE asset_hash=?", (asset_hash,)).fetchone()
    if r is None:
        return None
    d = dict(r)
    d["tags"] = json.loads(d.pop("tags_json")) if d.get("tags_json") else None
    d["deterministic"] = json.loads(d.pop("deterministic_json")) if d.get("deterministic_json") else None
    return d


def status(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) AS rows, COUNT(DISTINCT ad_id) AS ads, MIN(date) AS min_date, MAX(date) AS max_date "
        "FROM ad_day_metrics").fetchone()
    last = conn.execute("SELECT window_start, window_end, rows, fetched_at FROM fetch_log ORDER BY id DESC LIMIT 1").fetchone()
    return {
        "db": str(conn.execute("PRAGMA database_list").fetchone()[2]),
        "schema_version": conn.execute("PRAGMA user_version").fetchone()[0],
        "metric_rows": row["rows"], "ads": row["ads"],
        "min_date": row["min_date"], "max_date": row["max_date"],
        "ads_tagged": conn.execute("SELECT COUNT(*) FROM creative_tags").fetchone()[0],
        "ads_untagged": len(untagged_ads(conn)),
        "fetches": conn.execute("SELECT COUNT(*) FROM fetch_log").fetchone()[0],
        "last_fetch": dict(last) if last else None,
    }


# ── CLI ───────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=None, help="override $CREATIVE_SIGNAL_DB / default path")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("status")
    g = sub.add_parser("gap")
    g.add_argument("--today", default=None)
    i = sub.add_parser("ingest")
    i.add_argument("file")
    i.add_argument("--since", required=True)
    i.add_argument("--until", required=True)
    a = ap.parse_args(argv)

    try:
        conn = connect(a.db)
        if a.cmd == "init":
            out: dict = {"db": str(db_path(a.db)), "schema_version": SCHEMA_VERSION}
        elif a.cmd == "status":
            out = status(conn)
        elif a.cmd == "gap":
            w = catch_up_window(conn, a.today)
            out = {"since": w[0], "until": w[1]} if w else {"since": None, "until": None, "note": "store empty — run backfill"}
        else:
            r = ingest_daily_file(conn, a.file, a.since, a.until)
            out = {"rows": r.rows, "new_ads": len(r.new_ad_ids), "new_ad_ids": r.new_ad_ids,
                   "since": r.since, "until": r.until}
    except (OSError, ValueError, KeyError, sqlite3.Error) as e:
        print(f"[store] error: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
