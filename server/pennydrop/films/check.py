from __future__ import annotations

import asyncio
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
from .document import FilmError
from .kits import SAMPLE_RATE
from .measures import FilmMeasures, format_measures, gather
from .narration import Narration
from .workspace import Workspace

LOUDNESS_TOLERANCE = 0.5
TRUE_PEAK_LIMIT = loudness.TARGET_TRUE_PEAK
SHORTEST_LETTER_SECONDS = 0.12
LINE_MARGIN_SECONDS = 0.1
LONGEST_SILENCE = 1.5
LIVENESS_FPS = 4
LIVENESS_SIZE = (480, 270)
CHANGED_LEVELS = 20
FEWEST_CHANGED_PIXELS = 40
LONGEST_STILL = 1.0


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
class Gap:
    start: float
    seconds: float
    where: str


@dataclass(frozen=True)
class FilmReport:
    film: Path
    loudness: loudness.Loudness
    spoken: SpokenScript
    silences: list[Gap]
    stills: list[Gap]
    measures: FilmMeasures

    @property
    def loudness_ok(self) -> bool:
        return abs(self.loudness.integrated - loudness.TARGET_LUFS) <= LOUDNESS_TOLERANCE and self.loudness.true_peak <= TRUE_PEAK_LIMIT

    @property
    def spoken_ok(self) -> bool:
        return not self.spoken.clipped_letters

    @property
    def dead_air(self) -> list[Gap]:
        return [silence for silence in self.silences if silence.seconds > LONGEST_SILENCE]

    @property
    def passed(self) -> bool:
        return self.loudness_ok and self.spoken_ok and not self.dead_air and not self.stills


def _decode(path: Path) -> numpy.ndarray:
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"], capture_output=True, check=True)
    return numpy.frombuffer(result.stdout, dtype=numpy.float32).astype(numpy.float64)


def still_moments(film: Path) -> list[Gap]:
    """Finds stretches of a second or more in which the picture hardly changes, so a viewer would see a frozen frame."""
    width, height = LIVENESS_SIZE
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(film), "-an", "-vf", f"fps={LIVENESS_FPS},scale={width}:{height}:flags=area,format=gray", "-f", "rawvideo", "-"],
        capture_output=True,
        check=True,
    ).stdout
    frames = numpy.frombuffer(raw, numpy.uint8).reshape(-1, height, width).astype(numpy.int16)
    lag = LIVENESS_FPS // 2
    changed = (numpy.abs(frames[lag:] - frames[:-lag]) > CHANGED_LEVELS).sum(axis=(1, 2))
    stills, start = [], None
    for index, quiet in enumerate([*(changed < FEWEST_CHANGED_PIXELS), False]):
        if quiet and start is None:
            start = index
        elif not quiet and start is not None:
            seconds = (index - start + lag) / LIVENESS_FPS
            if seconds >= LONGEST_STILL:
                stills.append(Gap(start / LIVENESS_FPS, seconds, "the picture hardly changes"))
            start = None
    return stills


def check_film(workspace: Workspace, transcriber: Transcriber) -> FilmReport:
    film = workspace.home / f"{workspace.thread}.mp4"
    if not film.exists():
        raise FilmError(f"{film} is missing; run the render stage first")
    narration = Narration.read(workspace)
    seconds = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(film)], capture_output=True, text=True, check=True).stdout)
    spoken = asyncio.run(_spoken_script(_decode(film), narration, transcriber))
    return FilmReport(film, loudness.measure(film), spoken, _silences(narration, seconds), still_moments(film), gather(workspace))


def _silences(narration: Narration, seconds: float) -> list[Gap]:
    words = narration.words
    opening = Gap(0.0, words[0].start, "before the first word")
    between = [
        Gap(said.end, following.start - said.end, f"in line {said.line}" if said.line == following.line else f"between lines {said.line} and {following.line}")
        for said, following in pairwise(words)
    ]
    ending = Gap(words[-1].end, seconds - words[-1].end, "after the last word")
    return [opening, *between, ending]


async def _spoken_script(heard: numpy.ndarray, narration: Narration, transcriber: Transcriber) -> SpokenScript:
    expected_all: list[str] = []
    actual_all: list[str] = []
    mismatches: list[dict] = []
    clipped: list[ClippedLetter] = []
    try:
        for line in narration.lines:
            words = [word for word in narration.words if word.line == line["line"]]
            begin, end = line["start"] - LINE_MARGIN_SECONDS, line["end"] + LINE_MARGIN_SECONDS
            with tempfile.TemporaryDirectory() as scratch:
                clip = Path(scratch) / "line.wav"
                soundfile.write(clip, heard[max(0, int(begin * SAMPLE_RATE)) : int(end * SAMPLE_RATE)], SAMPLE_RATE)
                transcript = await transcriber.transcribe(clip)
            expected, actual = comparable_script(line["say"]), comparable_script(transcript)
            expected_all += expected
            actual_all += actual
            mismatches += [{"line": line["line"], **miss} for miss in misheard(expected, actual)]
            for match in spelled_letters(line["say"]):
                timing = words[len(spoken_words(line["say"][: match.start()]))]
                if timing.end - timing.start < SHORTEST_LETTER_SECONDS:
                    clipped.append(ClippedLetter(line["line"], match.group(1), timing.end - timing.start))
    finally:
        await transcriber.close()
    return SpokenScript(len(expected_all), word_error_rate(expected_all, actual_all), mismatches, clipped)


def format_report(report: FilmReport) -> str:
    rows = [f"film  {report.film}"]
    rows.append(f"loudness  integrated {report.loudness.integrated:.2f} LUFS (target {loudness.TARGET_LUFS}), true peak {report.loudness.true_peak:.2f} dBTP (limit {TRUE_PEAK_LIMIT})  {'OK' if report.loudness_ok else 'FAIL'}")
    spoken = report.spoken
    rows.append(f"spoken script  word error rate {spoken.word_error_rate:.2%} over {spoken.words} words, {len(spoken.mismatches)} mismatches, {len(spoken.clipped_letters)} spelled letters under {SHORTEST_LETTER_SECONDS} s  {'OK' if report.spoken_ok else 'FAIL'}")
    rows.extend(f"  line {miss['line']}: expected '{miss['expected']}' heard '{miss['heard']}'" for miss in spoken.mismatches)
    rows.extend(f"  line {letter.line}: spelled letter {letter.letter} lasts {letter.seconds * 1000:.0f} ms" for letter in spoken.clipped_letters)
    longest = max(report.silences, key=lambda silence: silence.seconds)
    rows.append(f"dead air  longest {longest.seconds:.2f} s {longest.where} at {longest.start:.1f} s, {len(report.dead_air)} silences over {LONGEST_SILENCE} s  {'FAIL' if report.dead_air else 'OK'}")
    rows.extend(f"  {silence.seconds:.2f} s {silence.where} at {silence.start:.1f} s" for silence in report.dead_air)
    rows.append(f"liveness  {len(report.stills)} stretches of {LONGEST_STILL:g} s or more where the picture hardly changes  {'FAIL' if report.stills else 'OK'}")
    rows.extend(f"  {still.seconds:.2f} s at {still.start:.1f} s" for still in report.stills)
    rows.extend(format_measures(report.measures))
    return "\n".join(rows)
