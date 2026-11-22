from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

TARGET_LUFS = -14.0
TARGET_TRUE_PEAK = -1.5
LOUDNESS_TOLERANCE = 0.3
LIMITER_MARGIN_DB = 0.3
OVERSAMPLE_HZ = 192000
MAX_PASSES = 6
DELIVERY_CODEC = ["-c:a", "aac", "-b:a", "256k", "-ar", "48000"]


@dataclass(frozen=True)
class Loudness:
    integrated: float
    true_peak: float


def _run(arguments: list[str]) -> str:
    result = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *arguments], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-600:]}")
    return result.stderr


def measure(path: Path) -> Loudness:
    log = _run(["-i", str(path), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"])
    summary = log[log.rindex("Summary:") :]
    integrated = float(re.search(r"I:\s+(-?[\d.]+) LUFS", summary).group(1))
    true_peak = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary[summary.index("True peak") :]).group(1))
    return Loudness(integrated, true_peak)


def normalize(source: Path, target: Path) -> Loudness:
    gain = TARGET_LUFS - measure(source).integrated
    margin = LIMITER_MARGIN_DB
    for _ in range(MAX_PASSES):
        _run(["-y", "-i", str(source), "-af", _limited_gain(gain, margin), "-ar", "48000", "-c:a", "pcm_s24le", str(target)])
        reached = delivered(target)
        if abs(reached.integrated - TARGET_LUFS) <= LOUDNESS_TOLERANCE and reached.true_peak <= TARGET_TRUE_PEAK:
            return reached
        gain += TARGET_LUFS - reached.integrated
        margin += max(0.0, reached.true_peak - TARGET_TRUE_PEAK)
    raise RuntimeError(
        f"could not reach {TARGET_LUFS} LUFS under {TARGET_TRUE_PEAK} dBTP for {source}: got {reached.integrated} LUFS, {reached.true_peak} dBTP"
    )


def delivered(master: Path) -> Loudness:
    with tempfile.TemporaryDirectory() as directory:
        encoded = Path(directory) / "delivery.m4a"
        _run(["-y", "-i", str(master), *DELIVERY_CODEC, str(encoded)])
        return measure(encoded)


def _limited_gain(gain: float, margin: float) -> str:
    ceiling = 10 ** ((TARGET_TRUE_PEAK - margin) / 20)
    return f"volume={gain}dB,aresample={OVERSAMPLE_HZ},alimiter=limit={ceiling:.4f}:attack=5:release=50:level=disabled,aresample=48000"
