#!/usr/bin/env python3
"""Optional advanced audio lane for creative-signal (decision B+).

Vendored and trimmed from hyperframes `skills/music-to-video/scripts/analyze-beatgrid.py`
(librosa beat tracker + RMS energy narrative). Kept: decode, tempo/beat grid, onsets,
energy phases / surges / drops / hard stops. Dropped: drum typing, 16th-note metrical grid,
rolls, phrases, per-event lists — those serve beat-synced video editing, not
attribute→hook-rate correlation. Every kept output is a scalar (or a short label) so
`correlate.py` can treat it like any other attribute.

Importing this module imports librosa. deterministic.py catches the ImportError and
falls back to the ffmpeg-only core — do NOT make this a hard dependency anywhere.

Deps: ffmpeg on PATH + librosa, numpy, soundfile (requirements-advanced.txt).
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

SR = 22050
HOP = 512  # ~23 ms frames
HOOK_WINDOW_S = 3  # Meta's 3-second view is the hook-rate denominator (spec §3)


def load_audio(path: str) -> tuple[np.ndarray, int, float]:
    """Decode any ffmpeg-readable file to mono float32 @ SR via a temp wav."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), wav],
            capture_output=True, check=True,
        )
        y, sr = sf.read(wav, dtype="float32")
    finally:
        Path(wav).unlink(missing_ok=True)
    if y.ndim > 1:
        y = y.mean(axis=1)
    return y, sr, len(y) / sr


def beat_grid(y: np.ndarray, sr: int) -> tuple[float, int]:
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP, units="frames")
    return float(np.atleast_1d(tempo)[0]), int(len(beat_frames))


def energy_structure(y: np.ndarray, sr: int, dur: float) -> dict:
    """RMS @ 1 s frames → normalized energy curve, level phases, surges/drops, hard stops."""
    rms = librosa.feature.rms(y=y, hop_length=sr)[0]  # ~1 s frames
    rms = rms / (rms.max() + 1e-9)
    norms = [float(n) for n in rms]

    def lvl(n: float) -> str:
        return "VOID" if n < 0.2 else "LOW" if n < 0.4 else "MEDIUM" if n < 0.65 else "HIGH"

    phases: list[str] = []
    for n in norms:
        level = lvl(n)
        if not phases or phases[-1] != level:
            phases.append(level)

    moments = []
    for i in range(1, len(norms)):
        d = norms[i] - norms[i - 1]
        if abs(d) > 0.12:
            moments.append({"t": i, "kind": "DROP" if d < 0 else "SURGE", "delta": d})
    # hard stop: a sudden HIGH→low cliff in the back part of the runtime
    hard_stops = [m for m in moments if m["kind"] == "DROP" and m["t"] > dur * 0.6 and m["delta"] < -0.25]

    return {"norms": norms, "phases": phases, "moments": moments, "hard_stops": hard_stops}


def analyze_audio(path: str) -> dict:
    """Return exactly deterministic.ADVANCED_KEYS (asserted by the test suite)."""
    y, sr, dur = load_audio(path)
    if dur <= 0 or not np.any(y):
        raise ValueError("audio stream is empty or silent")

    bpm, beat_count = beat_grid(y, sr)
    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=HOP, units="time", backtrack=True)
    es = energy_structure(y, sr, dur)
    norms = es["norms"]
    first = norms[:HOOK_WINDOW_S] or norms

    return {
        "tempo_bpm": round(bpm, 1),
        "beat_count": beat_count,
        "onset_count": int(len(onsets)),
        "onset_rate": round(len(onsets) / dur, 2),
        "energy_first3s": round(float(np.mean(first)), 2),
        "energy_mean": round(float(np.mean(norms)), 2),
        "energy_peak_t": int(np.argmax(norms)),
        "energy_phase_count": len(es["phases"]),
        "energy_level_sequence": ">".join(es["phases"]),
        "surge_count": sum(1 for m in es["moments"] if m["kind"] == "SURGE"),
        "drop_count": sum(1 for m in es["moments"] if m["kind"] == "DROP"),
        "hard_stop_count": len(es["hard_stops"]),
    }
