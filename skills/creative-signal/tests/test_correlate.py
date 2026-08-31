"""correlate.py tests (spec §14 items 1 and 5): known-lift fixture → confidence buckets;
tiny window → everything anecdotal, never strong; stats helpers; store-backed E2E + CLI.

Run:  python3 -m unittest discover -s skills/creative-signal/tests -v
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import correlate  # noqa: E402
import store  # noqa: E402
from test_store import raw_row  # noqa: E402


def make_ads(n: int, seed: int = 7) -> list[dict]:
    """Planted structure: first3s_content=face lifts hook_rate (+~0.09); cut_count lifts hold_rate;
    sound_mode is pure noise; tempo_bpm is always None; aspect_ratio is constant."""
    rng = random.Random(seed)
    ads = []
    for i in range(n):
        face = i % 2 == 0
        cuts = rng.randint(1, 12)
        hook = rng.gauss(0.33 if face else 0.24, 0.035)
        hold = rng.gauss(0.30 + 0.02 * cuts, 0.05)
        ads.append({
            "ad_id": f"ad{i}", "hook_rate": round(max(hook, 0.01), 4), "hold_rate": round(max(hold, 0.01), 4),
            "attributes": {
                "first3s_content": "face" if face else rng.choice(["product", "text"]),
                "faces_present": face,
                "sound_mode": rng.choice(["music", "voiceover"]),
                "cut_count": cuts,
                "tempo_bpm": None,
                "aspect_ratio": "9:16",
                "hook_text": f"free text {i}",  # NON_ATTRIBUTES — must never be tested
            },
        })
    return ads


class StatsTest(unittest.TestCase):
    def test_mann_whitney_extremes(self) -> None:
        same = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        self.assertGreater(correlate.mann_whitney_p(same, same), 0.9)
        lo, hi = [0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19], [0.3, 0.31, 0.32, 0.33, 0.34, 0.35, 0.36, 0.37, 0.38, 0.39]
        self.assertLess(correlate.mann_whitney_p(lo, hi), 0.001)
        self.assertIsNone(correlate.mann_whitney_p([], [1.0]))

    def test_cohens_d_known_value(self) -> None:
        self.assertAlmostEqual(correlate.cohens_d([1, 2, 3], [4, 5, 6]), -3.0)
        self.assertEqual(correlate.cohens_d([2, 2, 2], [2, 2, 2]), 0.0)
        self.assertIsNone(correlate.cohens_d([1], [2, 3]))

    def test_benjamini_hochberg(self) -> None:
        q = correlate.benjamini_hochberg([0.01, 0.04, 0.03, 0.5])
        for got, want in zip(q, [0.04, 0.0533, 0.0533, 0.5]):
            self.assertAlmostEqual(got, want, places=3)
        self.assertEqual(correlate.benjamini_hochberg([]), [])
        self.assertTrue(all(v <= 1.0 for v in correlate.benjamini_hochberg([0.9, 0.95, 1.0])))

    def test_confidence_rules(self) -> None:
        self.assertEqual(correlate.confidence(20, 20, 0.6, 0.01, 0.3), "strong")
        self.assertEqual(correlate.confidence(19, 20, 0.6, 0.01, 0.3), "directional")  # n short of strong
        self.assertEqual(correlate.confidence(20, 20, 0.4, 0.01, 0.3), "directional")  # effect too small
        self.assertEqual(correlate.confidence(8, 8, 0.4, 0.19, 0.1), "directional")
        self.assertEqual(correlate.confidence(8, 8, 0.4, 0.19, -0.1), "anecdotal")     # sign disagrees
        self.assertEqual(correlate.confidence(7, 30, 1.0, 0.001, 0.5), "anecdotal")     # group too small
        self.assertEqual(correlate.confidence(30, 30, None, None, None), "anecdotal")


class ComputeSignalsTest(unittest.TestCase):
    def test_planted_lift_reaches_strong_and_noise_does_not(self) -> None:
        signals, n_tests = correlate.compute_signals(make_ads(60))
        by = {(s["attribute"], s["metric"]): s for s in signals}
        face = by[("first3s_content=face", "hook_rate")]
        self.assertEqual(face["confidence"], "strong")
        self.assertGreater(face["lift_pct"], 0.25)
        self.assertGreater(face["effect_size"], 1.0)
        self.assertLess(face["p_value"], 0.001)
        self.assertEqual((face["n_group"], face["n_rest"]), (30, 30))
        # bool with two values → exactly ONE test per metric, on the true side
        self.assertIn(("faces_present=true", "hook_rate"), by)
        self.assertNotIn(("faces_present=false", "hook_rate"), by)
        # numeric → median split label, planted on hold_rate
        cut_keys = [k for k in by if k[0].startswith("cut_count>=") and k[1] == "hold_rate"]
        self.assertEqual(len(cut_keys), 1)
        self.assertIn(by[cut_keys[0]]["confidence"], ("strong", "directional"))
        self.assertGreater(by[cut_keys[0]]["effect_size"], 0)
        # pure noise never reaches strong
        for s in signals:
            if s["attribute"].startswith("sound_mode="):
                self.assertNotEqual(s["confidence"], "strong", s)
        # all-null, constant, and free-text attributes produce no tests
        self.assertFalse(any(k[0].startswith(("tempo_bpm", "aspect_ratio", "hook_text")) for k in by))
        # ordering: strong first; every signal carries a q_value in [0,1]
        confs = [s["confidence"] for s in signals]
        rank = {"strong": 0, "directional": 1, "anecdotal": 2}
        self.assertEqual(confs, sorted(confs, key=lambda c: rank[c]))
        self.assertTrue(all(0 <= s["q_value"] <= 1 for s in signals))
        self.assertEqual(n_tests, len(signals))

    def test_tiny_window_is_never_strong(self) -> None:
        signals, _ = correlate.compute_signals(make_ads(6))
        self.assertTrue(signals, "6 ads with 3/3 split should still yield anecdotal signals")
        self.assertTrue(all(s["confidence"] == "anecdotal" for s in signals), signals)
        # 6 ads but the planted lift is real: the numbers are reported, the label is honest
        face = next(s for s in signals if s["attribute"] == "first3s_content=face" and s["metric"] == "hook_rate")
        self.assertGreater(face["lift_pct"], 0)

    def test_below_min_group_is_dropped(self) -> None:
        ads = make_ads(5)  # 3 face / 2 other → rest < MIN_GROUP
        signals, _ = correlate.compute_signals(ads)
        self.assertFalse(any(s["attribute"] == "first3s_content=face" for s in signals))

    def test_missing_attribute_values_are_absent_not_zero(self) -> None:
        ads = make_ads(40)
        for a in ads[:30]:
            a["attributes"]["cut_count"] = None  # advanced lane missing on most ads
        signals, _ = correlate.compute_signals(ads)
        cut = [s for s in signals if s["attribute"].startswith("cut_count>=")]
        for s in cut:
            self.assertEqual(s["n_group"] + s["n_rest"], 10)  # only the 10 with a value


class StoreBackedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-corr-"))
        self.db = self.tmp / "t.db"
        self.conn = store.connect(self.db)
        days = ("2026-08-25", "2026-08-26", "2026-08-27")
        rows = []
        for i in range(12):
            for d in days:
                # even ads (faces_present=True below) get the higher 3 s view count
                rows.append(raw_row(f"v{i}", d, impressions=2000, video_view=440 if i % 2 == 0 else 400, thruplay=160))
        rows += [raw_row("img1", d, impressions=5000, video_view=0) for d in days]      # image ad: no video_view
        rows += [raw_row("tiny", d, impressions=50, video_view=20) for d in days]         # below min impressions
        for r in rows:
            if r["ad_id"] == "img1":
                r["actions"] = [a for a in r["actions"] if a["action_type"] != "video_view"]
        store.ingest_daily(self.conn, rows, days[0], days[-1])
        for i in range(12):
            if i == 11:
                continue  # v11 stays untagged
            store.set_ad_asset(self.conn, f"v{i}", f"cr{i}", f"h{i}", f"/x/v{i}.mp4")
            store.upsert_tags(self.conn, f"h{i}", creative_id=f"cr{i}",
                              deterministic={"deterministic_version": 1, "audio_analysis": "basic",
                                             "features": {"cut_count": i, "duration_s": 15.0, "cut_times": [1, 2]}},
                              tags={"faces_present": i % 2 == 0, "format_style": "ugc", "transcript": "hi"},
                              tagger_model="gemini-3.1-flash-lite")

    def tearDown(self) -> None:
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_run_assembles_signals_json_contract(self) -> None:
        r = correlate.run(self.conn, "2026-08-25", "2026-08-27", label="last_3d", account_id="act_1")
        self.assertEqual(set(r), {"run", "ads", "signals", "warnings"})
        run = r["run"]
        self.assertEqual((run["window"], run["n_ads"], run["n_eligible"], run["shopify_enabled"]), ("last_3d", 14, 11, False))
        self.assertEqual(run["model"], "gemini-3.1-flash-lite")
        ads = {a["ad_id"]: a for a in r["ads"]}
        self.assertEqual(ads["img1"]["flags"], ["untagged", "no_video_view"])
        self.assertIn("below_min_impressions", ads["tiny"]["flags"])
        self.assertEqual(ads["v11"]["flags"], ["untagged"])
        self.assertFalse(ads["v11"]["eligible"])
        # deterministic features + gemini tags merged; audio_analysis surfaced; lists kept per ad
        self.assertEqual(ads["v2"]["attributes"]["cut_count"], 2)
        self.assertEqual(ads["v2"]["attributes"]["audio_analysis"], "basic")
        self.assertTrue(ads["v2"]["attributes"]["faces_present"])
        self.assertEqual(ads["v2"]["hook_rate"], 0.22)     # 440/2000
        self.assertEqual(ads["v2"]["hold_rate"], 0.3636)   # 160/440
        self.assertEqual(ads["v3"]["hook_rate"], 0.2)      # 400/2000
        # faces_present=true ↔ higher video_view by construction → a signal exists, tiny n → anecdotal
        fp = [s for s in r["signals"] if s["attribute"] == "faces_present=true" and s["metric"] == "hook_rate"]
        self.assertEqual(len(fp), 1)
        self.assertEqual(fp[0]["confidence"], "anecdotal")
        self.assertGreater(fp[0]["lift_pct"], 0)
        # no test on transcript / cut_times / duration constant
        self.assertFalse(any(s["attribute"].startswith(("transcript", "cut_times", "duration_s")) for s in r["signals"]))
        joined = "\n".join(r["warnings"])
        for needle in ("1 ads have no video_view", "3 ads untagged", "1 ads below min_impressions",  # v11, img1, tiny
                       "only 11 eligible ads", "Benjamini-Hochberg", "no revenue"):
            self.assertIn(needle, joined)

    def test_window_dates_end_yesterday(self) -> None:
        self.assertEqual(correlate.window_dates("last_7d", "2026-08-31"), ("2026-08-24", "2026-08-30"))
        self.assertEqual(correlate.window_dates("last_30d", "2026-03-01"), ("2026-01-30", "2026-02-28"))
        with self.assertRaises(ValueError):
            correlate.window_dates("last_90d")

    def test_cli_writes_file_and_errors_cleanly(self) -> None:
        env = {**os.environ, "CREATIVE_SIGNAL_DB": str(self.db), "PYTHONDONTWRITEBYTECODE": "1"}
        out = self.tmp / "signals.json"
        cp = subprocess.run([sys.executable, str(SCRIPTS / "correlate.py"), "--window", "last_7d", "--today", "2026-08-28",
                             "--min-impressions", "100", "-o", str(out)], capture_output=True, text=True, env=env)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        data = json.loads(out.read_text())
        self.assertEqual((data["run"]["window"], data["run"]["since"], data["run"]["until"]), ("last_7d", "2026-08-21", "2026-08-27"))
        self.assertIn("ads eligible", cp.stderr)
        cp = subprocess.run([sys.executable, str(SCRIPTS / "correlate.py"), "--since", "2026-09-01", "--until", "2026-08-01"],
                            capture_output=True, text=True, env=env)
        self.assertEqual(cp.returncode, 1)
        self.assertIn("[correlate] error:", cp.stderr)
        self.assertNotIn("Traceback", cp.stderr)
        cp = subprocess.run([sys.executable, str(SCRIPTS / "correlate.py")], capture_output=True, text=True, env=env)
        self.assertEqual(cp.returncode, 1)


if __name__ == "__main__":
    unittest.main()
