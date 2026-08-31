#!/usr/bin/env python3
"""Deterministic creative features for creative-signal (spec §7, decision B+).

Two lanes, one flat output:

  core      ffmpeg/ffprobe + Python stdlib. ALWAYS runs. Cuts via the `scene` filter,
            loudness via `ebur128`, silence via `silencedetect`, dims/duration via ffprobe.
  advanced  librosa (audio_lane.py, vendored from hyperframes music-to-video
            analyze-beatgrid.py). Runs only if `import librosa` succeeds. When it does not,
            every advanced field is null and `audio_analysis` is "basic". The core result
            never depends on it — the Python venv was the most fragile step of a
            non-technical onboarding, so librosa is best-effort, never required.

Usage:
    python3 deterministic.py video.mp4 [-o features.json] [--no-advanced]
                                       [--scene-threshold 0.4]

Output JSON:
    {"deterministic_version": 1,
     "audio_analysis": "none" | "basic" | "advanced",
     "features": {<flat scalars, see CORE_KEYS + ADVANCED_KEYS>},
     "warnings": [...]}
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

# Sibling import (audio_lane.py) must resolve no matter the caller's cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))

DETERMINISTIC_VERSION = 1

# ffmpeg scene score; 0.3–0.5 is the customary band. 0.4 flags hard cuts and full-frame
# transitions without counting fast pans / whip-zooms inside one shot.
SCENE_THRESHOLD = 0.4
# silencedetect: below -35 dBFS for ≥0.5 s counts as silence. Ad audio is loud and
# compressed, so -35 dB separates "nothing playing" from a quiet music bed.
SILENCE_NOISE_DB = -35.0
SILENCE_MIN_S = 0.5

# Nearest canonical placement ratio within ±6 %, else "other".
ASPECT_LABELS = ((9 / 16, "9:16"), (4 / 5, "4:5"), (1.0, "1:1"), (16 / 9, "16:9"))

CORE_KEYS = (
    "duration_s", "width", "height", "aspect_ratio", "aspect_value", "has_audio",
    "cut_count", "cut_times", "time_to_first_cut", "avg_shot_len",
    "loudness_lufs", "silence_ratio",
)
# Filled by audio_lane.analyze_audio(); null when the lane is unavailable or fails.
ADVANCED_KEYS = (
    "tempo_bpm", "beat_count", "onset_count", "onset_rate",
    "energy_first3s", "energy_mean", "energy_peak_t",
    "energy_phase_count", "energy_level_sequence",
    "surge_count", "drop_count", "hard_stop_count",
)

_PTS_RE = re.compile(r"pts_time:\s*([0-9.]+)")
_LUFS_RE = re.compile(r"\bI:\s+(-?[0-9.]+|-inf)\s+LUFS")
_SIL_START_RE = re.compile(r"silence_start:\s*(-?[0-9.]+)")
_SIL_END_RE = re.compile(r"silence_end:\s*(-?[0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)")


class FfmpegError(RuntimeError):
    pass


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    # ffmpeg writes filter reports (showinfo / ebur128 / silencedetect) to stderr at
    # loglevel info, so the default verbosity is load-bearing — do not add -v error.
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


# ── core: ffprobe ─────────────────────────────────────────────────────────────
def probe(path: str) -> dict:
    cp = _run(["ffprobe", "-v", "error", "-print_format", "json",
               "-show_streams", "-show_format", path])
    if cp.returncode != 0:
        raise FfmpegError(f"ffprobe failed ({cp.returncode}): {cp.stderr.strip()[-400:]}")
    info = json.loads(cp.stdout or "{}")
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise FfmpegError("no video stream")
    fmt = info.get("format", {})
    duration = float(fmt.get("duration") or video.get("duration") or 0.0)
    return {
        "duration_s": round(duration, 3),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
    }


def aspect_label(width: int, height: int) -> tuple[str, float | None]:
    if not width or not height:
        return "other", None
    value = width / height
    # One metric for both pick and accept: log-ratio distance, symmetric for 9:16 vs 16:9.
    dist = {label: abs(math.log(value / ratio)) for ratio, label in ASPECT_LABELS}
    best = min(dist, key=lambda k: dist[k])
    label = best if dist[best] <= math.log(1.06) else "other"
    return label, round(value, 3)


# ── core: ffmpeg filters ──────────────────────────────────────────────────────
def detect_cuts(path: str, threshold: float = SCENE_THRESHOLD) -> list[float]:
    """Timestamps (s) of frames whose scene-change score exceeds `threshold`."""
    cp = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-an",
               "-vf", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"])
    if cp.returncode != 0:
        raise FfmpegError(f"ffmpeg scene pass failed: {cp.stderr.strip()[-400:]}")
    return sorted(round(float(m), 3) for m in _PTS_RE.findall(cp.stderr))


def loudness_lufs(path: str) -> float | None:
    """EBU R128 integrated loudness; None when the stream is effectively silent (-inf)."""
    cp = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn",
               "-af", "ebur128=framelog=quiet", "-f", "null", "-"])
    if cp.returncode != 0:
        raise FfmpegError(f"ffmpeg ebur128 pass failed: {cp.stderr.strip()[-400:]}")
    hits = _LUFS_RE.findall(cp.stderr)
    if not hits or hits[-1] == "-inf":
        return None
    return round(float(hits[-1]), 1)


def silence_ratio(path: str, duration: float) -> float | None:
    """Fraction of the runtime below SILENCE_NOISE_DB for ≥ SILENCE_MIN_S."""
    if duration <= 0:
        return None
    cp = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn",
               "-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_S}",
               "-f", "null", "-"])
    if cp.returncode != 0:
        raise FfmpegError(f"ffmpeg silencedetect pass failed: {cp.stderr.strip()[-400:]}")
    total = sum(float(d) for _, d in _SIL_END_RE.findall(cp.stderr))
    starts, ends = _SIL_START_RE.findall(cp.stderr), _SIL_END_RE.findall(cp.stderr)
    if len(starts) > len(ends):  # silence runs off the end of the file — no silence_end line
        total += max(0.0, duration - float(starts[-1]))
    return round(min(1.0, total / duration), 3)


# ── orchestrate ───────────────────────────────────────────────────────────────
def analyze(path: str, advanced: bool = True, scene_threshold: float = SCENE_THRESHOLD) -> dict:
    warnings: list[str] = []
    meta = probe(path)
    duration = meta["duration_s"]
    label, value = aspect_label(meta["width"], meta["height"])
    cuts = detect_cuts(path, scene_threshold)

    features: dict = {k: None for k in (*CORE_KEYS, *ADVANCED_KEYS)}
    features.update(meta)
    features.update({
        "aspect_ratio": label,
        "aspect_value": value,
        "cut_count": len(cuts),
        "cut_times": cuts,
        "time_to_first_cut": cuts[0] if cuts else None,
        "avg_shot_len": round(duration / (len(cuts) + 1), 3) if duration else None,
    })

    audio_analysis = "none"
    if meta["has_audio"]:
        audio_analysis = "basic"
        features["loudness_lufs"] = loudness_lufs(path)
        features["silence_ratio"] = silence_ratio(path, duration)
        if advanced:
            try:
                from audio_lane import analyze_audio  # imports librosa; ImportError when absent
            except ImportError as e:
                warnings.append(f"advanced audio lane unavailable: {e}")
            else:
                try:
                    features.update(analyze_audio(path))
                    audio_analysis = "advanced"
                except Exception as e:  # best-effort lane: the core result must survive
                    warnings.append(f"advanced audio lane failed: {type(e).__name__}: {e}")
    else:
        warnings.append("no audio stream — loudness/silence/advanced fields are null")

    return {
        "deterministic_version": DETERMINISTIC_VERSION,
        "audio_analysis": audio_analysis,
        "features": features,
        "warnings": warnings,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--no-advanced", action="store_true", help="skip the librosa lane even if installed")
    ap.add_argument("--scene-threshold", type=float, default=SCENE_THRESHOLD)
    a = ap.parse_args()
    try:
        result = analyze(a.video, advanced=not a.no_advanced, scene_threshold=a.scene_threshold)
    except (FfmpegError, OSError) as e:
        # Callers run this as a subprocess: one line on stderr + exit 1, not a traceback to parse.
        # OSError covers ffmpeg/ffprobe missing from PATH and an unreadable input path.
        print(f"[deterministic] error: {e}", file=sys.stderr)
        sys.exit(1)
    text = json.dumps(result, indent=2)
    if a.out:
        Path(a.out).write_text(text + "\n", encoding="utf-8")
        print(f"[deterministic] wrote {a.out} · audio_analysis={result['audio_analysis']}", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
