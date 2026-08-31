#!/usr/bin/env python3
"""One-time historical backfill for creative-signal (spec §4.2).

Runs once at onboarding over the window PJ chose (default 6 months; Meta retains ~37).
Meta cannot return months of ad×day rows in one async report, so the window is walked in
~30-day chunks oldest → newest, each pulled with `meta-ads intel fetch-daily` and upserted
as it lands — a crash or sleep mid-way loses nothing already stored.

Resumable by default: a chunk whose exact (since, until) already appears in fetch_log with
rows > 0 is skipped, so re-running the same command after an interruption only fetches
what is missing. --force re-pulls everything (e.g. after a CLI upgrade added fields).
Historical days are frozen on Meta's side, so a skipped chunk is not stale; the trailing
week is sync.py's job.

Usage:
    python3 backfill.py --months 6            [--until YYYY-MM-DD] [--force] [--dry-run] [--db PATH]
    python3 backfill.py --since 2026-03-01    [--until YYYY-MM-DD] [--force] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
import sync  # noqa: E402

DEFAULT_MONTHS = 6


@dataclass
class BackfillResult:
    since: str
    until: str
    windows: list[dict] = field(default_factory=list)   # [{since, until, rows, new_ads, skipped}]
    rows: int = 0
    new_ad_ids: list[str] = field(default_factory=list)
    skipped: int = 0
    dry_run: bool = False

    def as_dict(self) -> dict:
        return {"since": self.since, "until": self.until, "chunks": len(self.windows), "skipped": self.skipped,
                "windows": self.windows, "rows": self.rows, "new_ads": len(self.new_ad_ids),
                "new_ad_ids": self.new_ad_ids, "dry_run": self.dry_run}


def months_ago(until: str, months: int) -> str:
    """Calendar-month subtraction, clamped to the target month's last day (Mar 31 − 1mo = Feb 28)."""
    u = date.fromisoformat(until)
    y, m = u.year, u.month - months
    while m <= 0:
        y, m = y - 1, m + 12
    # last day of target month
    nxt = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    last = (nxt - timedelta(days=1)).day
    return date(y, m, min(u.day, last)).isoformat()


def already_fetched(conn, since: str, until: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM fetch_log WHERE window_start=? AND window_end=? AND rows>0 LIMIT 1", (since, until)).fetchone()
    return row is not None


def backfill(conn, since: str, until: str, *, chunk_days: int = sync.CHUNK_DAYS, force: bool = False,
             dry_run: bool = False, fetch: sync.FetchFn = sync.run_fetch_daily) -> BackfillResult:
    res = BackfillResult(since=since, until=until, dry_run=dry_run)
    chunks = sync.chunk_windows(since, until, chunk_days)
    for i, (s, u) in enumerate(chunks, 1):
        if not force and already_fetched(conn, s, u):
            res.windows.append({"since": s, "until": u, "rows": None, "new_ads": None, "skipped": True})
            res.skipped += 1
            print(f"[backfill] {i}/{len(chunks)} {s} → {u} already in fetch_log, skipping", file=sys.stderr)
            continue
        if dry_run:
            res.windows.append({"since": s, "until": u, "rows": None, "new_ads": None, "skipped": False})
            continue
        print(f"[backfill] {i}/{len(chunks)} fetch-daily {s} → {u}", file=sys.stderr)
        r = sync.fetch_and_ingest(conn, s, u, fetch)
        res.windows.append({"since": s, "until": u, "rows": r.rows, "new_ads": len(r.new_ad_ids), "skipped": False})
        res.rows += r.rows
        res.new_ad_ids.extend(r.new_ad_ids)
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--months", type=int, default=None, help=f"window length back from --until (default {DEFAULT_MONTHS})")
    g.add_argument("--since", default=None, help="explicit start date YYYY-MM-DD")
    ap.add_argument("--until", default=None, help="end date (default today)")
    ap.add_argument("--chunk-days", type=int, default=sync.CHUNK_DAYS)
    ap.add_argument("--force", action="store_true", help="re-pull chunks already in fetch_log")
    ap.add_argument("--dry-run", action="store_true", help="print the chunk plan, fetch nothing")
    ap.add_argument("--db", default=None)
    a = ap.parse_args(argv)

    until = a.until or date.today().isoformat()
    since = a.since or months_ago(until, a.months or DEFAULT_MONTHS)
    try:
        conn = store.connect(a.db)
        res = backfill(conn, since, until, chunk_days=a.chunk_days, force=a.force, dry_run=a.dry_run)
    except (sync.FetchError, store.sqlite3.Error, OSError, ValueError) as e:
        print(f"[backfill] error: {e}", file=sys.stderr)
        return 1
    print(json.dumps(res.as_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
