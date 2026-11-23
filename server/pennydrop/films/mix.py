from __future__ import annotations

import math
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy
import soundfile

from .. import loudness
from .kits import SAMPLE_RATE, SoundKit
from .voices import SpokenLine

VOICE_RMS_DB = -20.0
BED_RMS_DB = -34.0
ACCENT_UNDER_VOICE_LU = 12.0
DUCK_DB = 11.0
DUCK_ATTACK_SECONDS = 0.08
DUCK_RELEASE_SECONDS = 0.6
SPEECH_FLOOR = 0.01
ENVELOPE_RATE = 100
VIDEO_FPS = 30


@dataclass(frozen=True)
class MixReport:
    voice: loudness.Loudness
    bed: loudness.Loudness
    master: loudness.Loudness
    seconds: float


def _decode_mono(path: Path) -> numpy.ndarray:
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"], capture_output=True, check=True
    )
    return numpy.frombuffer(result.stdout, dtype=numpy.float32).astype(numpy.float64)


def _rms_db(signal: numpy.ndarray, active: numpy.ndarray | None = None) -> float:
    chosen = signal if active is None else signal[active]
    return 20 * math.log10(max(float(numpy.sqrt(numpy.mean(chosen**2))), 1e-9))


def _duck_gain(voice: numpy.ndarray, count: int) -> numpy.ndarray:
    step = SAMPLE_RATE // ENVELOPE_RATE
    frames = count // step + 1
    padded = numpy.pad(numpy.abs(voice), (0, frames * step - len(voice)))
    energy = padded.reshape(frames, step).mean(axis=1)
    active = (energy > SPEECH_FLOOR * energy.max()).astype(float)
    attack = 1 - math.exp(-1 / (DUCK_ATTACK_SECONDS * ENVELOPE_RATE))
    release = 1 - math.exp(-1 / (DUCK_RELEASE_SECONDS * ENVELOPE_RATE))
    smooth = numpy.zeros(frames)
    level = 0.0
    for index, wanted in enumerate(active):
        level += (attack if wanted > level else release) * (wanted - level)
        smooth[index] = level
    gain = 10 ** (-DUCK_DB * smooth / 20)
    return numpy.interp(numpy.arange(count) / step, numpy.arange(frames), gain)


def build_mix(manifest: dict, spoken: list[SpokenLine], kit: SoundKit, directory: Path) -> MixReport:
    directory.mkdir(parents=True, exist_ok=True)
    seconds = math.ceil(manifest["duration"] * VIDEO_FPS) / VIDEO_FPS
    count = round(seconds * SAMPLE_RATE)

    voice = numpy.zeros(count)
    for line, start in zip(spoken, manifest["lineStarts"], strict=True):
        clip = _decode_mono(line.path)
        offset = round(start * SAMPLE_RATE)
        end = min(count, offset + len(clip))
        voice[offset:end] += clip[: end - offset]
    speaking = numpy.abs(voice) > SPEECH_FLOOR * numpy.abs(voice).max()
    voice *= 10 ** ((VOICE_RMS_DB - _rms_db(voice, speaking)) / 20)
    stereo_voice = numpy.stack([voice, voice], axis=1)
    paths = {name: directory / f"{name}.wav" for name in ("voice", "bed", "mix", "master")}
    _write(paths["voice"], stereo_voice)
    voice_loudness = loudness.measure(paths["voice"])

    bed = kit.bed(seconds)[:count]
    bed *= 10 ** ((BED_RMS_DB - _rms_db(bed)) / 20)
    bed *= _duck_gain(voice, count)[:, None]

    accent_loudness = voice_loudness.integrated - ACCENT_UNDER_VOICE_LU
    tones = {tone: _leveled(kit.accent(tone), accent_loudness) for tone in {accent["tone"] for accent in manifest["accents"]}}
    accents = numpy.zeros((count, 2))
    for accent in manifest["accents"]:
        tone = tones[accent["tone"]] * accent["gain"]
        offset = round(accent["time"] * SAMPLE_RATE)
        end = min(count, offset + len(tone))
        accents[offset:end] += tone[: end - offset]

    _write(paths["bed"], bed)
    _write(paths["mix"], stereo_voice + bed + accents)
    loudness.normalize(paths["mix"], paths["master"])
    return MixReport(voice_loudness, loudness.measure(paths["bed"]), loudness.delivered(paths["master"]), seconds)


def _write(path: Path, signal: numpy.ndarray) -> None:
    soundfile.write(path, signal.astype(numpy.float32), SAMPLE_RATE, subtype="FLOAT")


def _leveled(tone: numpy.ndarray, target_lufs: float) -> numpy.ndarray:
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "accent.wav"
        _write(path, tone)
        return tone * 10 ** ((target_lufs - loudness.loudest_moment(path)) / 20)


def mux(video: Path, master: Path, output: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(master), "-map", "0:v", "-map", "1:a", "-shortest", "-c:v", "copy", *loudness.DELIVERY_CODEC, "-movflags", "+faststart", str(output)],
        check=True,
    )
