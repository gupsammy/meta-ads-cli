"""Store tests (spec §14 item 3): upsert idempotency, trailing-7d overwrite, gap query,
hook/hold aggregation, tag-once cache. Synthetic rows mirror the real Meta ad-level
time_increment=1 shape (string numerics, actions as [{action_type, value}]).

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

import store  # noqa: E402


def raw_row(ad_id: str, day: str, *, impressions=1000, video_view=300, thruplay=120,
            spend="12.50", purchases=2, with_retention=True, name=None) -> dict:
    row = {
        "account_id": "act_1", "campaign_id": "c1", "campaign_name": "Camp",
        "adset_id": "s1", "adset_name": "Set", "ad_id": ad_id, "ad_name": name or f"Ad {ad_id}",
        "impressions": str(impressions), "clicks": "40", "spend": spend, "reach": "800",
        "frequency": "1.25", "cpc": "0.31", "cpm": "12.5", "ctr": "4.0",
        "date_start": day, "date_stop": day,
        "quality_ranking": "AVERAGE", "engagement_rate_ranking": "ABOVE_AVERAGE",
        "conversion_rate_ranking": "UNKNOWN",
        "actions": [
            {"action_type": "link_click", "value": "40"},
            {"action_type": "purchase", "value": "99"},          # must lose to omni_purchase
            {"action_type": "omni_purchase", "value": str(purchases)},
            {"action_type": "video_view", "value": str(video_view)},
        ],
        "action_values": [{"action_type": "omni_purchase", "value": "150.00"}],
    }
    if with_retention:
        row.update({
            "video_thruplay_watched_actions": [{"action_type": "video_view", "value": str(thruplay)}],
            "video_p25_watched_actions": [{"action_type": "video_view", "value": "250"}],
            "video_p50_watched_actions": [{"action_type": "video_view", "value": "180"}],
            "video_p75_watched_actions": [{"action_type": "video_view", "value": "90"}],
            "video_p100_watched_actions": [{"action_type": "video_view", "value": "60"}],
            "video_avg_time_watched_actions": [{"action_type": "video_view", "value": "7.4"}],
        })
    return row


class StoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-store-"))
        self.db = self.tmp / "t.db"
        self.conn = store.connect(self.db)

    def tearDown(self) -> None:
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ── normalization ─────────────────────────────────────────────────────────
    def test_normalize_row_matches_metrics_ts_priority(self) -> None:
        n = store.normalize_row(raw_row("a1", "2026-08-10"))
        self.assertEqual((n["ad_id"], n["date"]), ("a1", "2026-08-10"))
        self.assertEqual(n["impressions"], 1000)
        self.assertEqual(n["spend"], 12.5)
        self.assertEqual(n["video_view"], 300)
        self.assertEqual(n["thruplay"], 120)
        self.assertEqual((n["p25"], n["p100"]), (250, 60))
        self.assertEqual(n["avg_watch_s"], 7.4)
        self.assertEqual(n["purchases"], 2)          # omni_purchase beats purchase
        self.assertEqual(n["purchase_value"], 150.0)
        self.assertEqual(n["quality_ranking"], "AVERAGE")

    def test_normalize_attr_guard_drops_attribution_window_duplicates(self) -> None:
        r = raw_row("a1", "2026-08-10")
        r["actions"] = [
            {"action_type": "video_view", "value": "300"},
            {"action_type": "video_view", "value": "999", "action_attribution_window": "7d_click"},
        ]
        self.assertEqual(store.normalize_row(r)["video_view"], 300)

    def test_normalize_pre_019_row_has_null_retention(self) -> None:
        n = store.normalize_row(raw_row("a1", "2026-08-10", with_retention=False))
        self.assertEqual(n["video_view"], 300)
        for k in ("thruplay", "p25", "p50", "p75", "p100", "avg_watch_s"):
            self.assertIsNone(n[k], k)

    # ── ingest / idempotency / overwrite ──────────────────────────────────────
    def _ingest(self, rows, since="2026-08-10", until="2026-08-12"):
        return store.ingest_daily(self.conn, rows, since, until)

    def _rows(self):
        return [raw_row(a, d) for a in ("a1", "a2") for d in ("2026-08-10", "2026-08-11", "2026-08-12")]

    def test_ingest_twice_is_idempotent(self) -> None:
        r1 = self._ingest(self._rows())
        r2 = self._ingest(self._rows())
        self.assertEqual((r1.rows, r2.rows), (6, 6))
        self.assertEqual(sorted(r1.new_ad_ids), ["a1", "a2"])
        self.assertEqual(r2.new_ad_ids, [])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM ad_day_metrics").fetchone()[0], 6)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM ads").fetchone()[0], 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM fetch_log").fetchone()[0], 2)

    def test_trailing_refetch_overwrites_revised_day(self) -> None:
        self._ingest(self._rows())
        revised = [raw_row("a1", "2026-08-12", impressions=1500, video_view=600, spend="20.00")]
        self._ingest(revised, since="2026-08-12", until="2026-08-12")
        row = self.conn.execute(
            "SELECT impressions, video_view, spend FROM ad_day_metrics WHERE ad_id='a1' AND date='2026-08-12'").fetchone()
        self.assertEqual(tuple(row), (1500, 600, 20.0))
        # other days untouched
        old = self.conn.execute(
            "SELECT impressions FROM ad_day_metrics WHERE ad_id='a1' AND date='2026-08-11'").fetchone()[0]
        self.assertEqual(old, 1000)

    def test_ads_roster_tracks_first_and_last_seen(self) -> None:
        self._ingest([raw_row("a1", "2026-08-11"), raw_row("a1", "2026-08-12", name="Ad a1 renamed")])
        # an OLDER backfill chunk landing after a newer one must widen first_seen but not rename
        self._ingest([raw_row("a1", "2026-08-05", name="Ad a1 original")], since="2026-08-05", until="2026-08-05")
        a = self.conn.execute("SELECT * FROM ads WHERE ad_id='a1'").fetchone()
        self.assertEqual((a["first_seen"], a["last_seen"]), ("2026-08-05", "2026-08-12"))
        self.assertEqual(a["ad_name"], "Ad a1 renamed")  # newest-day naming wins regardless of ingest order
        # a NEWER day does rename
        self._ingest([raw_row("a1", "2026-08-13", name="Ad a1 v3")], since="2026-08-13", until="2026-08-13")
        a = self.conn.execute("SELECT ad_name, last_seen FROM ads WHERE ad_id='a1'").fetchone()
        self.assertEqual(tuple(a), ("Ad a1 v3", "2026-08-13"))

    # ── gap / catch-up ────────────────────────────────────────────────────────
    def test_catch_up_window_empty_store_is_none(self) -> None:
        self.assertIsNone(store.catch_up_window(self.conn, today="2026-08-31"))

    def test_catch_up_window_is_max_minus_trailing_to_today(self) -> None:
        self._ingest(self._rows())  # max date 2026-08-12
        self.assertEqual(store.catch_up_window(self.conn, today="2026-08-31"), ("2026-08-05", "2026-08-31"))
        # store already at today → still re-fetch the trailing week
        self.assertEqual(store.catch_up_window(self.conn, today="2026-08-12"), ("2026-08-05", "2026-08-12"))

    # ── aggregation for correlate.py ──────────────────────────────────────────
    def test_aggregate_hook_and_hold_rates(self) -> None:
        self._ingest(self._rows())
        self._ingest([raw_row("a3", "2026-08-12", impressions=0, video_view=0, thruplay=0)],
                     since="2026-08-12", until="2026-08-12")
        self._ingest([raw_row("a4", "2026-08-12", with_retention=False)], since="2026-08-12", until="2026-08-12")
        agg = {r["ad_id"]: r for r in store.aggregate_ads(self.conn, "2026-08-10", "2026-08-12")}
        a1 = agg["a1"]
        self.assertEqual(a1["days"], 3)
        self.assertEqual(a1["impressions"], 3000)
        self.assertEqual(a1["hook_rate"], 0.3)     # 900 / 3000
        self.assertEqual(a1["hold_rate"], 0.4)     # 360 / 900
        self.assertIsNone(agg["a3"]["hook_rate"])  # zero impressions → None, not 0
        self.assertIsNone(agg["a4"]["hold_rate"])  # no thruplay fetched → None, not 0
        self.assertEqual(agg["a4"]["hook_rate"], 0.3)
        # window filter
        self.assertEqual(store.aggregate_ads(self.conn, "2026-08-13", "2026-08-31"), [])

    # ── tag-once cache ────────────────────────────────────────────────────────
    def test_untagged_then_tagged_flow(self) -> None:
        self._ingest(self._rows())
        self.assertEqual(sorted(a["ad_id"] for a in store.untagged_ads(self.conn)), ["a1", "a2"])
        store.set_ad_asset(self.conn, "a1", "cr1", "hash1", "/tmp/a1/video.mp4")
        self.assertEqual(len(store.untagged_ads(self.conn)), 2)  # hash set but no tags yet
        store.upsert_tags(self.conn, "hash1", creative_id="cr1", deterministic={"cut_count": 3})
        store.upsert_tags(self.conn, "hash1", tags={"format_style": "ugc"}, tagger_model="gemini-3.1-flash-lite")
        self.assertEqual([a["ad_id"] for a in store.untagged_ads(self.conn)], ["a2"])
        t = store.get_tags(self.conn, "hash1")
        self.assertEqual(t["deterministic"], {"cut_count": 3})   # partial update kept it
        self.assertEqual(t["tags"], {"format_style": "ugc"})
        self.assertEqual(t["tagger_model"], "gemini-3.1-flash-lite")
        # a second ad sharing the creative is tagged for free
        store.set_ad_asset(self.conn, "a2", "cr1", "hash1", "/tmp/a2/video.mp4")
        self.assertEqual(store.untagged_ads(self.conn), [])
        self.assertIsNone(store.get_tags(self.conn, "nope"))

    def test_status_counts(self) -> None:
        self._ingest(self._rows())
        s = store.status(self.conn)
        self.assertEqual((s["metric_rows"], s["ads"], s["fetches"]), (6, 2, 1))
        self.assertEqual((s["min_date"], s["max_date"]), ("2026-08-10", "2026-08-12"))
        self.assertEqual(s["schema_version"], store.SCHEMA_VERSION)
        self.assertEqual(s["last_fetch"]["window_end"], "2026-08-12")

    # ── CLI round trip ────────────────────────────────────────────────────────
    def test_cli_round_trip_and_error_exit(self) -> None:
        f = self.tmp / "ads-daily.json"
        f.write_text(json.dumps({"data": self._rows()}))
        env = {**os.environ, "CREATIVE_SIGNAL_DB": str(self.tmp / "cli.db"), "PYTHONDONTWRITEBYTECODE": "1"}
        script = str(SCRIPTS / "store.py")

        def run(*args):
            return subprocess.run([sys.executable, script, *args], capture_output=True, text=True, env=env)

        cp = run("ingest", str(f), "--since", "2026-08-10", "--until", "2026-08-12")
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertEqual(json.loads(cp.stdout)["rows"], 6)
        cp = run("gap", "--today", "2026-08-31")
        self.assertEqual(json.loads(cp.stdout), {"since": "2026-08-05", "until": "2026-08-31"})
        cp = run("status")
        self.assertEqual(json.loads(cp.stdout)["metric_rows"], 6)
        cp = run("ingest", str(self.tmp / "missing.json"), "--since", "2026-08-10", "--until", "2026-08-12")
        self.assertEqual(cp.returncode, 1)
        self.assertIn("[store] error:", cp.stderr)
        self.assertNotIn("Traceback", cp.stderr)


if __name__ == "__main__":
    unittest.main()
