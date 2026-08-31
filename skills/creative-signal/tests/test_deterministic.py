"""Golden-fixture tests for scripts/deterministic.py (spec §14 item 2).

Run:  python3 -m unittest discover -s skills/creative-signal/tests -v
Needs ffmpeg/ffprobe on PATH. The advanced-lane test is skipped when librosa is absent
and runs for real when it is — both branches of B+ are covered from one suite.

Fixture (built with ffmpeg lavfi, so no binary lives in the repo):
  video  540x960 (9:16), 25 fps, three 2 s TEXTURED shots       → 2 hard cuts at 2 s and 4 s
         (testsrc2 → smptebars → rgbtestsrc; solid colours won't do — ffmpeg's scene score
         measures per-pixel change, and a flat red→green swap scores < 0.1)
  audio  440 Hz sine for 4 s, then 2 s of digital silence      → silence_ratio ≈ 1/3,
                                                                  one HIGH→VOID hard stop
"""

from __future__ import annotations

import importlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import deterministic  # noqa: E402

HAS_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
try:
    import librosa  # noqa: F401
    HAS_LIBROSA = True
except ImportError:
    HAS_LIBROSA = False


def _build_fixture(out: Path, with_audio: bool) -> None:
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for src in ("testsrc2", "smptebars", "rgbtestsrc"):
        cmd += ["-f", "lavfi", "-i", f"{src}=s=540x960:d=2:r=25"]
    if with_audio:
        cmd += ["-f", "lavfi", "-i", "sine=f=440:d=4",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2"]
        fc = "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a]concat=n=2:v=0:a=1[a]"
        maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac"]
    else:
        fc = "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]"
        maps = ["-map", "[v]", "-an"]
    cmd += ["-filter_complex", fc, *maps, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)]
    subprocess.run(cmd, check=True, capture_output=True)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe not on PATH")
class DeterministicCoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="cs-fixture-"))
        cls.audio_mp4 = cls.tmp / "cuts_audio.mp4"
        cls.mute_mp4 = cls.tmp / "cuts_mute.mp4"
        _build_fixture(cls.audio_mp4, with_audio=True)
        _build_fixture(cls.mute_mp4, with_audio=False)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_core_features_on_golden_fixture(self) -> None:
        r = deterministic.analyze(str(self.audio_mp4), advanced=False)
        f = r["features"]
        self.assertEqual(r["deterministic_version"], 1)
        self.assertEqual(r["audio_analysis"], "basic")
        self.assertAlmostEqual(f["duration_s"], 6.0, delta=0.2)
        self.assertEqual((f["width"], f["height"]), (540, 960))
        self.assertEqual(f["aspect_ratio"], "9:16")
        self.assertTrue(f["has_audio"])
        self.assertEqual(f["cut_count"], 2)
        self.assertAlmostEqual(f["time_to_first_cut"], 2.0, delta=0.1)
        self.assertAlmostEqual(f["cut_times"][1], 4.0, delta=0.1)
        self.assertAlmostEqual(f["avg_shot_len"], 2.0, delta=0.1)
        self.assertIsInstance(f["loudness_lufs"], float)
        self.assertLess(f["loudness_lufs"], 0)
        self.assertGreater(f["silence_ratio"], 0.25)
        self.assertLess(f["silence_ratio"], 0.42)
        # advanced=False must leave every advanced field null, with no warning about the lane
        for k in deterministic.ADVANCED_KEYS:
            self.assertIsNone(f[k], k)
        self.assertEqual(r["warnings"], [])

    def test_mute_video_yields_audio_analysis_none(self) -> None:
        r = deterministic.analyze(str(self.mute_mp4))
        f = r["features"]
        self.assertEqual(r["audio_analysis"], "none")
        self.assertFalse(f["has_audio"])
        self.assertIsNone(f["loudness_lufs"])
        self.assertIsNone(f["silence_ratio"])
        self.assertEqual(f["cut_count"], 2)
        self.assertTrue(any("no audio stream" in w for w in r["warnings"]))

    def test_advanced_lane_degrades_to_basic_when_librosa_missing(self) -> None:
        # Simulate PJ's machine: librosa import fails → core still succeeds, lane reports itself.
        saved = {k: sys.modules.get(k) for k in ("librosa", "audio_lane")}
        sys.modules["librosa"] = None  # type: ignore[assignment]  # makes `import librosa` raise ImportError
        sys.modules.pop("audio_lane", None)
        try:
            r = deterministic.analyze(str(self.audio_mp4), advanced=True)
        finally:
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v
        self.assertEqual(r["audio_analysis"], "basic")
        for k in deterministic.ADVANCED_KEYS:
            self.assertIsNone(r["features"][k], k)
        self.assertTrue(any("advanced audio lane unavailable" in w for w in r["warnings"]))
        self.assertEqual(r["features"]["cut_count"], 2)

    @unittest.skipUnless(HAS_LIBROSA, "librosa not installed — advanced lane not exercised")
    def test_advanced_lane_on_golden_fixture(self) -> None:
        audio_lane = importlib.import_module("audio_lane")
        adv = audio_lane.analyze_audio(str(self.audio_mp4))
        self.assertEqual(set(adv), set(deterministic.ADVANCED_KEYS))

        r = deterministic.analyze(str(self.audio_mp4), advanced=True)
        f = r["features"]
        self.assertEqual(r["audio_analysis"], "advanced")
        self.assertEqual(r["warnings"], [])
        self.assertGreater(f["tempo_bpm"], 0)
        self.assertIsInstance(f["onset_count"], int)
        # sine for 4 s then silence: loud opening, a HIGH→VOID cliff after 60 % of runtime
        self.assertGreater(f["energy_first3s"], 0.8)
        self.assertEqual(f["energy_level_sequence"].split(">")[0], "HIGH")
        self.assertEqual(f["energy_level_sequence"].split(">")[-1], "VOID")
        self.assertGreaterEqual(f["hard_stop_count"], 1)
        self.assertGreaterEqual(f["drop_count"], 1)
        # core fields are identical whether or not the lane ran
        base = deterministic.analyze(str(self.audio_mp4), advanced=False)["features"]
        for k in deterministic.CORE_KEYS:
            self.assertEqual(f[k], base[k], k)

    def test_cli_writes_json(self) -> None:
        out = self.tmp / "features.json"
        cp = subprocess.run(
            [sys.executable, str(SCRIPTS / "deterministic.py"), str(self.audio_mp4),
             "-o", str(out), "--no-advanced"],
            capture_output=True, text=True,
        )
        self.assertEqual(cp.returncode, 0, cp.stderr)
        data = json.loads(out.read_text())
        self.assertEqual(data["features"]["cut_count"], 2)
        self.assertIn("audio_analysis=basic", cp.stderr)


if __name__ == "__main__":
    unittest.main()
