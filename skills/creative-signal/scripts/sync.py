#!/usr/bin/env python3
"""Lazy catch-up for creative-signal (spec §4.3): pull the gap, upsert, report new ads.

Called at the start of every analysis run (and by an optional launchd job). It asks the
store for the window it owes — (max_stored_date − 7 days) → today — fetches it through
`meta-ads intel fetch-daily`, and upserts. The trailing-7-day overlap is deliberate: Meta
keeps revising recent days, so the last week is always overwritten. A laptop that slept for
a month just gets a longer window, chunked to ~30 days per Meta async report.

Metrics only. It never passes --keep-video: that re-downloads EVERY current video and
replaces ~/.meta-ads-intel/creatives/ (spec §4.4), so the decision belongs to run.py, driven
by store.untagged_ads() — sync.py just returns `new_ad_ids` so run.py knows something changed.

Empty store ⇒ not a catch-up. sync refuses and points at backfill.py (spec §4.2).

Usage:
    python3 sync.py [--today YYYY-MM-DD] [--chunk-days 30] [--dry-run] [--db PATH]
Exit 0 with JSON on stdout; exit 1 with one stderr line on failure; exit 3 if the store is
empty (backfill needed).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402

CHUNK_DAYS = 30                 # Meta async ad×day reports stay well under row/timeout caps at this size
LOCK_MARKER = "Another pull instance is running"
LOCK_RETRIES = 10               # × LOCK_WAIT_S = 5 min: long enough for a concurrent `intel run` to finish
LOCK_WAIT_S = 30
# Per-chunk ceiling. The CLI bounds its own async-report polling, so this only fires if the
# process itself wedges (network hang, stuck child). 30-day ad×day reports finish in minutes.
FETCH_TIMEOUT_S = 30 * 60
EXIT_NEEDS_BACKFILL = 3


class FetchError(RuntimeError):
    pass


# ── meta-ads CLI ──────────────────────────────────────────────────────────────
def meta_ads_bin() -> str:
    return os.environ.get("META_ADS_BIN") or "meta-ads"


def chunk_windows(since: str, until: str, chunk_days: int = CHUNK_DAYS) -> list[tuple[str, str]]:
    """Inclusive [since, until] → consecutive inclusive chunks of ≤ chunk_days."""
    if chunk_days < 1:
        raise ValueError(f"chunk_days must be ≥ 1 (got {chunk_days})")  # 0 would never advance the loop
    s, u = date.fromisoformat(since), date.fromisoformat(until)
    if s > u:
        raise ValueError(f"since {since} is after until {until}")
    out = []
    while s <= u:
        e = min(s + timedelta(days=chunk_days - 1), u)
        out.append((s.isoformat(), e.isoformat()))
        s = e + timedelta(days=1)
    return out


def run_fetch_daily(since: str, until: str, *, keep_video: bool = False,
                    lock_retries: int = LOCK_RETRIES, lock_wait_s: float = LOCK_WAIT_S,
                    timeout_s: float = FETCH_TIMEOUT_S, runner: Callable = subprocess.run) -> dict:
    """Invoke `meta-ads intel fetch-daily` and return its JSON result (has `file`, `rows`).

    A `.pull-lock` collision (another intel run in flight) is expected, not fatal: wait and
    retry up to lock_retries. Any other non-zero exit raises FetchError with the CLI's own
    message — the CLI prints {"error","message","hint"} JSON on stderr."""
    argv = [meta_ads_bin(), "intel", "fetch-daily", "--since", since, "--until", until, "-o", "json"]
    if keep_video:
        argv.append("--keep-video")
    if shutil.which(argv[0]) is None and not os.path.exists(argv[0]):
        raise FetchError(f"{argv[0]} not found on PATH — onboarding installs it with: npm i -g meta-ads@^0.19")
    attempt = 0
    while True:
        try:
            cp = runner(argv, capture_output=True, text=True, timeout=timeout_s)
        except subprocess.TimeoutExpired as e:
            raise FetchError(f"fetch-daily {since} → {until} exceeded {timeout_s:g}s and was killed") from e
        if cp.returncode == 0:
            try:
                return json.loads(cp.stdout)
            except json.JSONDecodeError as e:
                raise FetchError(f"fetch-daily returned non-JSON stdout: {e}: {cp.stdout[:200]!r}") from e
        if LOCK_MARKER in (cp.stderr or "") and attempt < lock_retries:
            attempt += 1
            print(f"[sync] pull lock held by another intel run — retry {attempt}/{lock_retries} in {lock_wait_s:g}s",
                  file=sys.stderr)
            time.sleep(lock_wait_s)
            continue
        raise FetchError(_cli_error_message(cp))


def _cli_error_message(cp: subprocess.CompletedProcess) -> str:
    err = (cp.stderr or "").strip()
    # The CLI pretty-prints {"error","message","hint"} over several lines, after any progress
    # text — so parse the outermost {...} span, not the last line.
    start, end = err.find("{"), err.rfind("}")
    if start != -1 and end > start:
        try:
            j = json.loads(err[start:end + 1])
            if isinstance(j, dict) and j.get("message"):
                hint = f" ({j['hint']})" if j.get("hint") else ""
                return f"fetch-daily {j.get('error', 'ERROR')}: {j['message']}{hint}"
        except json.JSONDecodeError:
            pass
    return f"fetch-daily exited {cp.returncode}: {err[-400:] or '(no stderr)'}"


# ── catch-up ──────────────────────────────────────────────────────────────────
@dataclass
class SyncResult:
    since: str | None
    until: str | None
    windows: list[dict] = field(default_factory=list)   # [{since, until, rows, new_ads}]
    rows: int = 0
    new_ad_ids: list[str] = field(default_factory=list)
    dry_run: bool = False

    def as_dict(self) -> dict:
        return {"since": self.since, "until": self.until, "chunks": len(self.windows), "windows": self.windows,
                "rows": self.rows, "new_ads": len(self.new_ad_ids), "new_ad_ids": self.new_ad_ids,
                "dry_run": self.dry_run}


FetchFn = Callable[[str, str], dict]


def fetch_and_ingest(conn, since: str, until: str, fetch: FetchFn = run_fetch_daily) -> store.IngestResult:
    """One chunk: CLI pull → ingest the file it wrote. Shared by sync and backfill."""
    result = fetch(since, until)
    path = result.get("file")
    if not path:
        raise FetchError(f"fetch-daily result has no 'file' key: {result}")
    return store.ingest_daily_file(conn, path, since, until)


def catch_up(conn, today: str | None = None, chunk_days: int = CHUNK_DAYS,
             dry_run: bool = False, fetch: FetchFn = run_fetch_daily) -> SyncResult | None:
    """Sync the store up to `today`. Returns None when the store is empty (backfill first)."""
    window = store.catch_up_window(conn, today)
    if window is None:
        return None
    since, until = window
    res = SyncResult(since=since, until=until, dry_run=dry_run)
    for s, u in chunk_windows(since, until, chunk_days):
        if dry_run:
            res.windows.append({"since": s, "until": u, "rows": None, "new_ads": None})
            continue
        print(f"[sync] fetch-daily {s} → {u}", file=sys.stderr)
        r = fetch_and_ingest(conn, s, u, fetch)
        res.windows.append({"since": s, "until": u, "rows": r.rows, "new_ads": len(r.new_ad_ids)})
        res.rows += r.rows
        res.new_ad_ids.extend(r.new_ad_ids)
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--today", default=None, help="override today (YYYY-MM-DD); tests / replays")
    ap.add_argument("--chunk-days", type=int, default=CHUNK_DAYS)
    ap.add_argument("--dry-run", action="store_true", help="print the windows sync would fetch, fetch nothing")
    ap.add_argument("--db", default=None)
    a = ap.parse_args(argv)
    try:
        conn = store.connect(a.db)
        res = catch_up(conn, a.today, a.chunk_days, a.dry_run)
    except (FetchError, store.sqlite3.Error, OSError, ValueError) as e:
        print(f"[sync] error: {e}", file=sys.stderr)
        return 1
    if res is None:
        print("[sync] store is empty — run backfill.py first (spec §4.2)", file=sys.stderr)
        return EXIT_NEEDS_BACKFILL
    print(json.dumps(res.as_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
