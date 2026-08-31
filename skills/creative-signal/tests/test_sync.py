"""sync.py + backfill.py tests: chunking, catch-up window, lock retry, CLI error surfacing,
resumable backfill. The meta-ads CLI is replaced by (a) an injected fetch function that
writes ads-daily.json files, and (b) a fake `meta-ads` executable for the subprocess layer.

Run:  python3 -m unittest discover -s skills/creative-signal/tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import backfill  # noqa: E402
import store  # noqa: E402
import sync  # noqa: E402
from test_store import raw_row  # noqa: E402


def days(since: str, until: str) -> list[str]:
    s, u = date.fromisoformat(since), date.fromisoformat(until)
    return [(s + timedelta(days=i)).isoformat() for i in range((u - s).days + 1)]


class FakeFetch:
    """Stands in for run_fetch_daily: writes an ads-daily.json for the window and records calls."""

    def __init__(self, root: Path, ad_ids=("a1", "a2")):
        self.root, self.ad_ids, self.calls = root, ad_ids, []

    def __call__(self, since: str, until: str) -> dict:
        self.calls.append((since, until))
        rows = [raw_row(a, d) for a in self.ad_ids for d in days(since, until)]
        f = self.root / f"daily_{since}_{until}.json"
        f.write_text(json.dumps({"data": rows}))
        return {"run_dir": str(self.root), "since": since, "until": until, "rows": len(rows), "file": str(f)}


class ChunkingTest(unittest.TestCase):
    def test_chunk_windows_inclusive_and_contiguous(self) -> None:
        c = sync.chunk_windows("2026-01-01", "2026-03-15", 30)
        self.assertEqual(c, [("2026-01-01", "2026-01-30"), ("2026-01-31", "2026-03-01"), ("2026-03-02", "2026-03-15")])
        self.assertEqual(sync.chunk_windows("2026-08-31", "2026-08-31"), [("2026-08-31", "2026-08-31")])
        with self.assertRaises(ValueError):
            sync.chunk_windows("2026-09-01", "2026-08-31")
        for bad in (0, -5):  # must fail fast, not loop forever
            with self.assertRaises(ValueError):
                sync.chunk_windows("2026-01-01", "2026-01-31", bad)

    def test_months_ago_clamps_to_month_end(self) -> None:
        self.assertEqual(backfill.months_ago("2026-08-31", 6), "2026-02-28")
        self.assertEqual(backfill.months_ago("2026-03-31", 1), "2026-02-28")
        self.assertEqual(backfill.months_ago("2026-01-15", 2), "2025-11-15")
        self.assertEqual(backfill.months_ago("2026-12-31", 12), "2025-12-31")


class CatchUpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-sync-"))
        self.conn = store.connect(self.tmp / "t.db")
        self.fetch = FakeFetch(self.tmp)

    def tearDown(self) -> None:
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_store_returns_none(self) -> None:
        self.assertIsNone(sync.catch_up(self.conn, today="2026-08-31", fetch=self.fetch))
        self.assertEqual(self.fetch.calls, [])

    def test_catch_up_fetches_gap_plus_trailing_week_in_chunks(self) -> None:
        store.ingest_daily(self.conn, [raw_row("a1", "2026-07-10")], "2026-07-10", "2026-07-10")
        res = sync.catch_up(self.conn, today="2026-08-31", chunk_days=30, fetch=self.fetch)
        self.assertEqual((res.since, res.until), ("2026-07-03", "2026-08-31"))  # max − 7 → today
        self.assertEqual(self.fetch.calls, [("2026-07-03", "2026-08-01"), ("2026-08-02", "2026-08-31")])
        self.assertEqual(res.rows, 2 * len(days("2026-07-03", "2026-08-31")))
        self.assertEqual(res.new_ad_ids, ["a2"])          # a1 was known; a2 is new
        self.assertEqual(store.max_date(self.conn), "2026-08-31")
        # idempotent: running again re-fetches only the trailing week and finds no new ads
        self.fetch.calls.clear()
        res2 = sync.catch_up(self.conn, today="2026-08-31", fetch=self.fetch)
        self.assertEqual(self.fetch.calls, [("2026-08-24", "2026-08-31")])
        self.assertEqual(res2.new_ad_ids, [])

    def test_dry_run_plans_without_fetching(self) -> None:
        store.ingest_daily(self.conn, [raw_row("a1", "2026-08-20")], "2026-08-20", "2026-08-20")
        res = sync.catch_up(self.conn, today="2026-08-31", dry_run=True, fetch=self.fetch)
        self.assertEqual([(w["since"], w["until"]) for w in res.windows], [("2026-08-13", "2026-08-31")])
        self.assertEqual(self.fetch.calls, [])
        self.assertTrue(res.as_dict()["dry_run"])

    def test_fetch_result_without_file_is_an_error(self) -> None:
        store.ingest_daily(self.conn, [raw_row("a1", "2026-08-20")], "2026-08-20", "2026-08-20")
        with self.assertRaises(sync.FetchError):
            sync.catch_up(self.conn, today="2026-08-31", fetch=lambda s, u: {"rows": 0})


class BackfillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-backfill-"))
        self.conn = store.connect(self.tmp / "t.db")
        self.fetch = FakeFetch(self.tmp)

    def tearDown(self) -> None:
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_backfill_walks_chunks_oldest_first_and_resumes(self) -> None:
        res = backfill.backfill(self.conn, "2026-06-01", "2026-08-31", chunk_days=30, fetch=self.fetch)
        self.assertEqual(self.fetch.calls, [("2026-06-01", "2026-06-30"), ("2026-07-01", "2026-07-30"),
                                            ("2026-07-31", "2026-08-29"), ("2026-08-30", "2026-08-31")])
        self.assertEqual(res.skipped, 0)
        self.assertEqual(sorted(res.new_ad_ids), ["a1", "a2"])
        self.assertEqual(store.status(self.conn)["min_date"], "2026-06-01")
        # re-run: every chunk is in fetch_log → all skipped, nothing fetched
        self.fetch.calls.clear()
        res2 = backfill.backfill(self.conn, "2026-06-01", "2026-08-31", chunk_days=30, fetch=self.fetch)
        self.assertEqual((res2.skipped, self.fetch.calls), (4, []))
        # --force re-pulls
        res3 = backfill.backfill(self.conn, "2026-06-01", "2026-08-31", chunk_days=30, force=True, fetch=self.fetch)
        self.assertEqual((res3.skipped, len(self.fetch.calls)), (0, 4))

    def test_interrupted_backfill_resumes_from_missing_chunk(self) -> None:
        calls = []

        def flaky(since, until):
            calls.append((since, until))
            if len(calls) == 2:
                raise sync.FetchError("simulated network drop")
            return self.fetch(since, until)

        with self.assertRaises(sync.FetchError):
            backfill.backfill(self.conn, "2026-06-01", "2026-08-31", chunk_days=30, fetch=flaky)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM fetch_log").fetchone()[0], 1)  # chunk 1 landed
        self.fetch.calls.clear()
        res = backfill.backfill(self.conn, "2026-06-01", "2026-08-31", chunk_days=30, fetch=self.fetch)
        self.assertEqual(res.skipped, 1)
        self.assertEqual(self.fetch.calls[0], ("2026-07-01", "2026-07-30"))  # resumed at the failed chunk
        self.assertEqual(len(self.fetch.calls), 3)

    def test_dry_run_prints_plan_only(self) -> None:
        res = backfill.backfill(self.conn, "2026-06-01", "2026-07-15", dry_run=True, fetch=self.fetch)
        self.assertEqual(len(res.windows), 2)
        self.assertEqual(self.fetch.calls, [])
        self.assertEqual(store.status(self.conn)["metric_rows"], 0)


FAKE_CLI = r'''#!/usr/bin/env python3
"""Fake meta-ads: behaviour selected by $FAKE_MODE; records argv to $FAKE_LOG."""
import json, os, sys
with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps(sys.argv[1:]) + "\n")
mode = os.environ.get("FAKE_MODE", "ok")
calls = sum(1 for _ in open(os.environ["FAKE_LOG"]))
if mode == "lock" and calls < 3:
    sys.stderr.write("Another pull instance is running (lockdir: /x/.pull-lock).\n"); sys.exit(1)
if mode == "auth":
    # real CLI shape: a progress line, then the error object pretty-printed over several lines
    sys.stderr.write("Fetching ad×daily insights for act_1 [x → y]...\n")
    sys.stderr.write(json.dumps({"error": "AUTH", "message": "No access token found.", "hint": "run meta-ads auth login"}, indent=2) + "\n"); sys.exit(1)
if mode == "garbage":
    sys.stdout.write("not json\n"); sys.exit(0)
if mode == "crash":
    sys.stderr.write("TypeError: cannot read properties of undefined\n    at pull (dist/index.js:1:2)\n"); sys.exit(1)
if mode == "hang":
    import time; time.sleep(30)
i = sys.argv.index("--since"); since = sys.argv[i + 1]; until = sys.argv[sys.argv.index("--until") + 1]
out = os.path.join(os.environ["FAKE_OUT"], f"ads-daily-{since}.json")
open(out, "w").write(json.dumps({"data": [{"ad_id": "fake1", "date_start": until, "date_stop": until, "impressions": "10"}]}))
print(json.dumps({"run_dir": os.environ["FAKE_OUT"], "since": since, "until": until, "rows": 1, "file": out,
                  **({"creatives": {"total_ads": 1, "total_frames": 6, "videos_retained": 1}} if "--keep-video" in sys.argv else {})}))
'''


class RunFetchDailyTest(unittest.TestCase):
    """Subprocess layer against a fake `meta-ads` binary."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-cli-"))
        self.bin = self.tmp / "meta-ads"
        self.bin.write_text(FAKE_CLI)
        self.bin.chmod(self.bin.stat().st_mode | stat.S_IEXEC)
        self.log = self.tmp / "calls.log"
        self.log.write_text("")
        self.env_backup = dict(os.environ)
        os.environ.update({"META_ADS_BIN": str(self.bin), "FAKE_LOG": str(self.log), "FAKE_OUT": str(self.tmp)})

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self.env_backup)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _calls(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()]

    def test_ok_parses_json_and_passes_flags(self) -> None:
        os.environ["FAKE_MODE"] = "ok"
        r = sync.run_fetch_daily("2026-08-01", "2026-08-07")
        self.assertEqual((r["since"], r["until"], r["rows"]), ("2026-08-01", "2026-08-07", 1))
        self.assertTrue(Path(r["file"]).exists())
        self.assertEqual(self._calls()[0], ["intel", "fetch-daily", "--since", "2026-08-01", "--until", "2026-08-07", "-o", "json"])
        r2 = sync.run_fetch_daily("2026-08-01", "2026-08-07", keep_video=True)
        self.assertIn("--keep-video", self._calls()[1])
        self.assertEqual(r2["creatives"]["videos_retained"], 1)

    def test_lock_collision_retries_then_succeeds(self) -> None:
        os.environ["FAKE_MODE"] = "lock"
        r = sync.run_fetch_daily("2026-08-01", "2026-08-07", lock_wait_s=0)
        self.assertEqual(r["rows"], 1)
        self.assertEqual(len(self._calls()), 3)  # 2 locked attempts + 1 success

    def test_lock_collision_gives_up_after_retries(self) -> None:
        os.environ["FAKE_MODE"] = "lock"
        with self.assertRaises(sync.FetchError) as cm:
            sync.run_fetch_daily("2026-08-01", "2026-08-07", lock_retries=1, lock_wait_s=0)
        self.assertIn("Another pull instance", str(cm.exception))

    def test_cli_error_json_is_surfaced(self) -> None:
        os.environ["FAKE_MODE"] = "auth"
        with self.assertRaises(sync.FetchError) as cm:
            sync.run_fetch_daily("2026-08-01", "2026-08-07")
        self.assertEqual(str(cm.exception), "fetch-daily AUTH: No access token found. (run meta-ads auth login)")

    def test_non_json_stdout_is_an_error(self) -> None:
        os.environ["FAKE_MODE"] = "garbage"
        with self.assertRaises(sync.FetchError):
            sync.run_fetch_daily("2026-08-01", "2026-08-07")

    def test_non_json_stderr_falls_back_to_raw_tail(self) -> None:
        os.environ["FAKE_MODE"] = "crash"
        with self.assertRaises(sync.FetchError) as cm:
            sync.run_fetch_daily("2026-08-01", "2026-08-07")
        msg = str(cm.exception)
        self.assertTrue(msg.startswith("fetch-daily exited 1: "), msg)
        self.assertIn("cannot read properties of undefined", msg)

    def test_hung_cli_is_killed_after_timeout(self) -> None:
        os.environ["FAKE_MODE"] = "hang"
        with self.assertRaises(sync.FetchError) as cm:
            sync.run_fetch_daily("2026-08-01", "2026-08-07", timeout_s=0.5)
        self.assertIn("exceeded 0.5s", str(cm.exception))

    def test_missing_binary_is_a_clear_error(self) -> None:
        os.environ["META_ADS_BIN"] = str(self.tmp / "nope")
        with self.assertRaises(sync.FetchError) as cm:
            sync.run_fetch_daily("2026-08-01", "2026-08-07")
        self.assertIn("npm i -g meta-ads", str(cm.exception))

    def test_sync_cli_exit_codes(self) -> None:
        os.environ["FAKE_MODE"] = "ok"
        env = {**os.environ, "CREATIVE_SIGNAL_DB": str(self.tmp / "cli.db"), "PYTHONDONTWRITEBYTECODE": "1"}
        cp = subprocess.run([sys.executable, str(SCRIPTS / "sync.py"), "--today", "2026-08-31"],
                            capture_output=True, text=True, env=env)
        self.assertEqual(cp.returncode, sync.EXIT_NEEDS_BACKFILL, cp.stderr)
        self.assertIn("backfill.py", cp.stderr)
        cp = subprocess.run([sys.executable, str(SCRIPTS / "backfill.py"), "--since", "2026-08-25", "--until", "2026-08-31"],
                            capture_output=True, text=True, env=env)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertEqual(json.loads(cp.stdout)["chunks"], 1)
        # store now holds 2026-08-31 → sync owes the trailing week
        cp = subprocess.run([sys.executable, str(SCRIPTS / "sync.py"), "--today", "2026-08-31", "--dry-run"],
                            capture_output=True, text=True, env=env)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        plan = json.loads(cp.stdout)
        self.assertEqual((plan["since"], plan["until"], plan["dry_run"]), ("2026-08-24", "2026-08-31", True))
        cp = subprocess.run([sys.executable, str(SCRIPTS / "sync.py"), "--today", "2026-08-31"],
                            capture_output=True, text=True, env=env)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertEqual(json.loads(cp.stdout)["rows"], 1)
        # a CLI failure is one stderr line + exit 1
        os.environ["FAKE_MODE"] = "auth"
        cp = subprocess.run([sys.executable, str(SCRIPTS / "sync.py"), "--today", "2026-08-31"],
                            capture_output=True, text=True, env={**env, "FAKE_MODE": "auth"})
        self.assertEqual(cp.returncode, 1)
        self.assertIn("[sync] error: fetch-daily AUTH", cp.stderr)
        self.assertNotIn("Traceback", cp.stderr)


if __name__ == "__main__":
    unittest.main()
