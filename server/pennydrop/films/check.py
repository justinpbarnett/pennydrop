from __future__ import annotations

import asyncio
import json
import statistics
import subprocess
import tempfile
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

import numpy
import soundfile

from .. import loudness
from ..intake import Transcriber
from ..spoken import comparable_script, misheard, word_error_rate
from ..tts.letters import spelled_letters
from ..words import spoken_words
from .audit import LONGEST_SILENCE
from .document import FilmError
from .kits import SAMPLE_RATE
from .measures import FilmMeasures, format_measures, gather

FRAME_SECONDS = 1 / 30
SEARCH_SECONDS = 1.0
PIXEL_WIDTH, PIXEL_HEIGHT = 480, 270
CHANGED_LEVELS = 10
PIXEL_SCALE = 1920 / PIXEL_WIDTH
WINDOW_BEFORE, WINDOW_AFTER = 0.7, 0.9
QUIET_SECONDS = 0.4
ONSET_RATIO = 3.0
ONSET_FLOOR = 6.0
LOUDNESS_TOLERANCE = 0.5
TRUE_PEAK_LIMIT = loudness.TARGET_TRUE_PEAK
SHORTEST_LETTER_SECONDS = 0.12
LINE_MARGIN_SECONDS = 0.1


@dataclass(frozen=True)
class CueMeasure:
    line: int
    kind: str
    op: str
    cue: str
    word_start: float
    op_start: float
    offset_ms: float
    pixel_onset_ms: float | None


@dataclass(frozen=True)
class ClippedLetter:
    line: int
    letter: str
    seconds: float


@dataclass(frozen=True)
class SpokenScript:
    words: int
    word_error_rate: float
    mismatches: list[dict]
    clipped_letters: list[ClippedLetter]


@dataclass(frozen=True)
class Silence:
    start: float
    seconds: float
    where: str


@dataclass(frozen=True)
class FilmReport:
    loudness: loudness.Loudness
    cues: list[CueMeasure]
    measures: FilmMeasures
    spoken: SpokenScript
    silences: list[Silence]

    @property
    def offsets(self) -> list[float]:
        return [abs(cue.offset_ms) for cue in self.cues]

    @property
    def loudness_ok(self) -> bool:
        return abs(self.loudness.integrated - loudness.TARGET_LUFS) <= LOUDNESS_TOLERANCE and self.loudness.true_peak <= TRUE_PEAK_LIMIT

    @property
    def spoken_ok(self) -> bool:
        return not self.spoken.clipped_letters

    @property
    def cues_ok(self) -> bool:
        return max(self.offsets, default=0.0) <= FRAME_SECONDS * 1000

    @property
    def dead_air(self) -> list[Silence]:
        return [silence for silence in self.silences if silence.seconds > LONGEST_SILENCE]

    @property
    def passed(self) -> bool:
        return self.loudness_ok and self.cues_ok and self.spoken_ok and not self.dead_air


def _decode(path: str | Path) -> numpy.ndarray:
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"], capture_output=True, check=True)
    return numpy.frombuffer(result.stdout, dtype=numpy.float32).astype(numpy.float64)


def _locate(heard: numpy.ndarray, clip: numpy.ndarray, expected: float) -> float:
    start = max(0, int((expected - SEARCH_SECONDS) * SAMPLE_RATE))
    window = heard[start : start + len(clip) + int(2 * SEARCH_SECONDS * SAMPLE_RATE)]
    size = 1 << (len(window) + len(clip)).bit_length()
    correlation = numpy.fft.irfft(numpy.fft.rfft(window, size) * numpy.conj(numpy.fft.rfft(clip, size)), size)
    valid = correlation[: len(window) - len(clip) + 1]
    return (start + int(numpy.argmax(valid))) / SAMPLE_RATE


def _frames(mp4: Path, start: float, seconds: float) -> numpy.ndarray:
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{start:.4f}", "-i", str(mp4), "-t", f"{seconds:.4f}", "-an", "-vf", f"scale={PIXEL_WIDTH}:{PIXEL_HEIGHT}:flags=area,format=gray", "-f", "rawvideo", "-"],
        capture_output=True,
        check=True,
    )
    return numpy.frombuffer(result.stdout, dtype=numpy.uint8).reshape(-1, PIXEL_HEIGHT, PIXEL_WIDTH).astype(numpy.float64)


def _pixel_onset(mp4: Path, region: dict | None, op_start: float) -> float | None:
    if not region:
        return None
    start = max(0.0, op_start - WINDOW_BEFORE)
    frames = _frames(mp4, start, WINDOW_BEFORE + WINDOW_AFTER)
    left, top = int(region["x"] / PIXEL_SCALE), int(region["y"] / PIXEL_SCALE)
    right, bottom = int((region["x"] + region["w"]) / PIXEL_SCALE) + 1, int((region["y"] + region["h"]) / PIXEL_SCALE) + 1
    change = (numpy.abs(numpy.diff(frames[:, top:bottom, left:right], axis=0)) > CHANGED_LEVELS).sum(axis=(1, 2)).astype(float)
    times = start + (numpy.arange(len(change)) + 1) * FRAME_SECONDS
    quiet = change[times < start + QUIET_SECONDS]
    threshold = max(ONSET_FLOOR, ONSET_RATIO * float(numpy.median(quiet)) if len(quiet) else ONSET_FLOOR)
    after = numpy.nonzero((times >= op_start - 2 * FRAME_SECONDS) & (change > threshold))[0]
    return float(times[after[0]]) if len(after) else None


def check_film(mp4: Path, transcriber: Transcriber) -> FilmReport:
    sidecar = Path(f"{mp4}.manifest.json")
    if not sidecar.exists():
        raise FilmError(f"{sidecar.name} is missing next to {mp4.name}; render the film with pd film render")
    manifest = json.loads(sidecar.read_text())
    heard = _decode(mp4)
    shifts = {
        number: _locate(heard, _decode(path), start) - start
        for number, path, start in zip(manifest["lineNumbers"], manifest["voiceLines"], manifest["lineStarts"], strict=True)
    }
    measures = []
    for cue in manifest["cues"]:
        if cue["wordStart"] is None:
            continue
        heard_word = cue["wordStart"] + shifts[cue["line"]]
        onset = _pixel_onset(mp4, cue.get("region"), cue["opStart"]) if cue["kind"] == "do" else None
        measures.append(
            CueMeasure(cue["line"], cue["kind"], cue["op"], cue["cue"], heard_word, cue["opStart"], (heard_word - cue["opStart"]) * 1000, None if onset is None else (onset - heard_word) * 1000)
        )
    spoken = asyncio.run(_spoken_script(heard, manifest, shifts, transcriber))
    return FilmReport(loudness.measure(mp4), measures, gather(mp4, manifest), spoken, _silences(manifest, shifts))


def _silences(manifest: dict, shifts: dict[int, float]) -> list[Silence]:
    heard = [
        (start + shifts[number] + word["start"], start + shifts[number] + word["end"], number)
        for number, start, words in zip(manifest["lineNumbers"], manifest["lineStarts"], manifest["voiceWords"], strict=True)
        for word in words
    ]
    opening = Silence(0.0, heard[0][0], "before the first word")
    between = [Silence(said[1], following[0] - said[1], f"in line {said[2]}" if said[2] == following[2] else f"between lines {said[2]} and {following[2]}") for said, following in pairwise(heard)]
    ending = Silence(heard[-1][1], manifest["duration"] - heard[-1][1], "after the last word")
    return [opening, *between, ending]


async def _spoken_script(heard: numpy.ndarray, manifest: dict, shifts: dict[int, float], transcriber: Transcriber) -> SpokenScript:
    expected_all: list[str] = []
    actual_all: list[str] = []
    mismatches: list[dict] = []
    clipped: list[ClippedLetter] = []
    try:
        for number, say, start, words in zip(manifest["lineNumbers"], manifest["says"], manifest["lineStarts"], manifest["voiceWords"], strict=True):
            begin = start + shifts[number] - LINE_MARGIN_SECONDS
            end = start + shifts[number] + words[-1]["end"] + LINE_MARGIN_SECONDS
            with tempfile.TemporaryDirectory() as scratch:
                clip = Path(scratch) / "line.wav"
                soundfile.write(clip, heard[max(0, int(begin * SAMPLE_RATE)) : int(end * SAMPLE_RATE)], SAMPLE_RATE)
                transcript = await transcriber.transcribe(clip)
            expected, actual = comparable_script(say), comparable_script(transcript)
            expected_all += expected
            actual_all += actual
            mismatches += [{"line": number, **miss} for miss in misheard(expected, actual)]
            for match in spelled_letters(say):
                timing = words[len(spoken_words(say[: match.start()]))]
                if timing["end"] - timing["start"] < SHORTEST_LETTER_SECONDS:
                    clipped.append(ClippedLetter(number, match.group(1), timing["end"] - timing["start"]))
    finally:
        await transcriber.close()
    return SpokenScript(len(expected_all), word_error_rate(expected_all, actual_all), mismatches, clipped)


def format_report(report: FilmReport) -> str:
    rows = [f"loudness  integrated {report.loudness.integrated:.2f} LUFS (target {loudness.TARGET_LUFS}), true peak {report.loudness.true_peak:.2f} dBTP (limit {TRUE_PEAK_LIMIT})  {'OK' if report.loudness_ok else 'FAIL'}"]
    rows.append(f"{'line':>4} {'kind':7} {'op':9} {'cue':24} {'word s':>8} {'op s':>8} {'offset ms':>10} {'pixel onset after word ms':>26}")
    for cue in report.cues:
        pixel = "-" if cue.pixel_onset_ms is None else f"{cue.pixel_onset_ms:.1f}"
        rows.append(f"{cue.line:>4} {cue.kind:7} {cue.op:9} {cue.cue[:24]:24} {cue.word_start:8.3f} {cue.op_start:8.3f} {cue.offset_ms:10.1f} {pixel:>26}")
    offsets = report.offsets
    pixels = [cue.pixel_onset_ms for cue in report.cues if cue.pixel_onset_ms is not None]
    rows.append(
        f"cue offset  max {max(offsets, default=0):.1f} ms, mean {statistics.fmean(offsets) if offsets else 0:.1f} ms over {len(offsets)} cues (bar {FRAME_SECONDS * 1000:.0f} ms)  {'OK' if report.cues_ok else 'FAIL'}"
    )
    if pixels:
        rows.append(f"pixel onset after word  max {max(pixels):.1f} ms, mean {statistics.fmean(pixels):.1f} ms over {len(pixels)} ops with a visible region")
    spoken = report.spoken
    rows.append(f"spoken script  word error rate {spoken.word_error_rate:.2%} over {spoken.words} words, {len(spoken.mismatches)} mismatches, {len(spoken.clipped_letters)} spelled letters under {SHORTEST_LETTER_SECONDS} s  {'OK' if report.spoken_ok else 'FAIL'}")
    rows.extend(f"  line {miss['line']}: expected '{miss['expected']}' heard '{miss['heard']}'" for miss in spoken.mismatches)
    rows.extend(f"  line {letter.line}: spelled letter {letter.letter} lasts {letter.seconds * 1000:.0f} ms" for letter in spoken.clipped_letters)
    longest = max(report.silences, key=lambda silence: silence.seconds)
    rows.append(f"dead air  longest {longest.seconds:.2f} s {longest.where} at {longest.start:.1f} s, {len(report.dead_air)} silences over {LONGEST_SILENCE} s  {'FAIL' if report.dead_air else 'OK'}")
    rows.extend(f"  {silence.seconds:.2f} s {silence.where} at {silence.start:.1f} s" for silence in report.dead_air)
    rows.extend(format_measures(report.measures))
    return "\n".join(rows)
