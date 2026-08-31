"""run.py orchestration tests — every external step injected; the pipeline itself is real
(store → deterministic cache → gemini cache → correlate → files on disk).

Run:  python3 -m unittest discover -s skills/creative-signal/tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import deterministic  # noqa: E402
import fetch_assets  # noqa: E402
import run as runmod  # noqa: E402
import store  # noqa: E402
import sync  # noqa: E402
import tag_gemini as tg  # noqa: E402
from test_store import raw_row  # noqa: E402
from test_tag_gemini import GOOD, FakeClient  # noqa: E402

TODAY = "2026-08-31"
DAYS = [f"2026-08-{d:02d}" for d in range(17, 31)]   # last_14d ending yesterday (08-30)


def det_result(cuts: int) -> dict:
    return {"deterministic_version": 1, "audio_analysis": "basic",
            "features": {"cut_count": cuts, "duration_s": 12.0, "aspect_ratio": "9:16"}, "warnings": []}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-run-"))
        self.conn = store.connect(self.tmp / "t.db")
        self.calls: dict[str, list] = {"sync": [], "assets": [], "analyze": [], "tag": []}
        self.env_backup = dict(os.environ)
        os.environ.pop("META_ADS_ACCOUNT_ID", None)

    def tearDown(self):
        self.conn.close()
        os.environ.clear(); os.environ.update(self.env_backup)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def seed(self, n: int = 6, *, with_video: bool = True):
        rows = [raw_row(f"a{i}", d, impressions=5000, video_view=1500 + 100 * (i % 2)) for i in range(n) for d in DAYS]
        store.ingest_daily(self.conn, rows, DAYS[0], DAYS[-1])
        if with_video:
            for i in range(n):
                v = self.tmp / f"a{i}.mp4"; v.write_bytes(b"v" + str(i % 3).encode())   # 3 distinct creatives
                store.set_ad_asset(self.conn, f"a{i}", f"cr{i % 3}", f"h{i % 3}", str(v))

    # injected steps
    def sync_fn(self, conn, today):
        self.calls["sync"].append(today)
        return sync.SyncResult(since="2026-08-23", until=today, rows=0)

    def assets_fn(self, conn, today=None, **kw):
        self.calls["assets"].append(today)
        return fetch_assets.FetchAssetsResult(candidates=0, fetched=False)

    def analyze(self, path):
        self.calls["analyze"].append(path)
        if path.endswith("a2.mp4"):
            raise deterministic.FfmpegError("ffprobe: moov atom not found")
        return det_result(cuts=len(self.calls["analyze"]))

    def tag_fn(self, conn, *, max_ads, **kw):
        self.calls["tag"].append(max_ads)
        return tg.tag_untagged(conn, FakeClient([json.dumps(GOOD)] * 10), max_ads=max_ads, sleep=lambda s: None)

    def go(self, **kw):
        kw.setdefault("sync_fn", self.sync_fn); kw.setdefault("assets_fn", self.assets_fn)
        kw.setdefault("analyze", self.analyze); kw.setdefault("tag_fn", self.tag_fn)
        kw.setdefault("today", TODAY); kw.setdefault("out", str(self.tmp / "out"))
        kw.setdefault("config_path", self.tmp / "no-intel-config.json")   # never read the real ~/.meta-ads-intel
        return runmod.run(self.conn, **kw)


class RunTest(Base):
    def test_full_pipeline_writes_signals_and_status(self):
        self.seed()
        st = self.go()
        self.assertEqual((st["since"], st["until"]), ("2026-08-17", "2026-08-30"), "last_14d ends yesterday")
        self.assertEqual(self.calls["sync"], [TODAY]); self.assertEqual(self.calls["assets"], [TODAY])
        det = st["steps"]["deterministic"]
        self.assertEqual((det["analyzed"], det["failed"], det["shared_ads"]), (2, 1, 3), "3 hashes, 6 ads; h2 fails")
        self.assertTrue(store.get_tags(self.conn, "h2")["deterministic"]["failed"], "failure cached, not retried")
        self.assertEqual(st["steps"]["gemini"]["calls"], 3, "one Gemini call per asset_hash")
        self.assertEqual(store.get_tags(self.conn, "h2")["tags"]["format_style"], "ugc",
                         "a deterministic failure does not block Gemini on the same asset")
        c = st["steps"]["correlate"]
        self.assertEqual((c["n_ads"], c["n_eligible"]), (6, 6))
        self.assertTrue(any("deterministic failed for ad a2" in w for w in st["warnings"]))
        out = Path(st["out_dir"])
        sig = json.loads((out / "signals.json").read_text())
        self.assertEqual(sig["run"]["window"], "last_14d")
        self.assertEqual(sig["run"]["account_id"], "act_1", "falls back to the store's account_id")
        self.assertEqual(len(sig["ads"]), 6)
        self.assertEqual(json.loads((out / "run-status.json").read_text())["steps"]["correlate"], c)
        # second run: everything cached → zero analyze / gemini calls
        st2 = self.go()
        self.assertEqual(len(self.calls["analyze"]), 3, "no re-analysis")
        self.assertEqual(st2["steps"]["gemini"]["calls"], 0)

    def test_empty_store_needs_backfill(self):
        with self.assertRaises(runmod.NeedsBackfill):
            self.go(sync_fn=lambda conn, today: None)
        with self.assertRaises(runmod.NeedsBackfill):
            self.go(no_sync=True)
        self.assertEqual(self.calls["assets"], [], "nothing else runs on an empty store")

    def test_no_sync_no_tag_and_missing_key_degrade_to_warnings(self):
        self.seed()
        st = self.go(no_sync=True, no_tag=True)
        self.assertEqual(self.calls["sync"], []); self.assertEqual(self.calls["tag"], [])
        self.assertEqual(st["steps"]["sync"], {"skipped": True}); self.assertEqual(st["steps"]["gemini"], {"skipped": True})
        self.assertEqual(st["steps"]["deterministic"]["analyzed"], 2, "ffmpeg lane still runs without Gemini")

        def no_key(conn, **kw):
            raise tg.ApiUnavailable("GEMINI_API_KEY not set")
        st = self.go(tag_fn=no_key)
        self.assertIn("GEMINI_API_KEY", st["steps"]["gemini"]["reason"])
        self.assertTrue(any(w.startswith("gemini tagging skipped") for w in st["warnings"]))
        self.assertIn("signals_file", st, "correlate still ran")

    def test_max_tags_and_account_id_precedence(self):
        self.seed()
        st = self.go(max_tags=1, account_id="act_cli")
        self.assertEqual(self.calls["tag"], [1]); self.assertEqual(st["account_id"], "act_cli")
        os.environ["META_ADS_ACCOUNT_ID"] = "act_env"
        self.assertEqual(runmod.resolve_account_id(self.conn), "act_env")
        del os.environ["META_ADS_ACCOUNT_ID"]
        cfg = self.tmp / "config.json"; cfg.write_text(json.dumps({"account_id": "act_cfg"}))
        self.assertEqual(runmod.resolve_account_id(self.conn, config_path=cfg), "act_cfg")
        self.assertEqual(runmod.resolve_account_id(self.conn, config_path=self.tmp / "nope.json"), "act_1")

    def test_fetch_error_propagates(self):
        self.seed()

        def boom(conn, today):
            raise sync.FetchError("Another pull instance is running")
        with self.assertRaises(sync.FetchError):
            self.go(sync_fn=boom)

    def test_default_out_dir_is_per_until(self):
        os.environ["CREATIVE_SIGNAL_OUT"] = str(self.tmp / "root")
        self.assertEqual(runmod.out_dir(None, "2026-08-30"), self.tmp / "root" / "2026-08-30")
        self.assertEqual(runmod.out_dir(str(self.tmp / "x"), "2026-08-30"), self.tmp / "x")


class CliTest(unittest.TestCase):
    def test_exit_codes(self):
        tmp = Path(tempfile.mkdtemp(prefix="cs-run-cli-"))
        try:
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "CREATIVE_SIGNAL_DB": str(tmp / "c.db"),
                   "META_ADS_BIN": str(tmp / "nope"), "CREATIVE_SIGNAL_OUT": str(tmp / "out")}
            p = subprocess.run([sys.executable, str(SCRIPTS / "run.py"), "--no-sync", "--no-tag"],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 3, p.stderr); self.assertIn("backfill", p.stderr)
            p = subprocess.run([sys.executable, str(SCRIPTS / "run.py"), "--today", "bad"],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 1); self.assertIn("[run] error", p.stderr)
            p = subprocess.run([sys.executable, str(SCRIPTS / "run.py"), "--window", "last_99d"],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 2, "argparse usage error")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
