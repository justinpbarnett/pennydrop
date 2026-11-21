from __future__ import annotations

import asyncio
import difflib
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import soundfile

from ..intake import Transcriber
from ..loudness import normalize
from ..settings import Settings
from ..words import comparable_words
from . import PROVIDERS
from .provider import TtsError


@dataclass(frozen=True)
class AbResult:
    provider: str
    file: str
    seconds: float
    audio_seconds: float
    real_time_factor: float
    word_error_rate: float
    loudness_lufs: float
    true_peak_dbtp: float
    misheard: list[dict]


async def compare(settings: Settings, transcriber: Transcriber, text: str, providers: list[str], out_dir: Path) -> list[AbResult]:
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for name in providers:
        if name not in PROVIDERS:
            raise TtsError(f"unknown tts provider '{name}', known providers: {', '.join(sorted(PROVIDERS))}")
        results.append(await _voice_with(settings, transcriber, text, name, out_dir))
    (out_dir / "ab.json").write_text(json.dumps([asdict(result) for result in results], indent=2))
    return results


async def _voice_with(settings: Settings, transcriber: Transcriber, text: str, name: str, out_dir: Path) -> AbResult:
    engine = PROVIDERS[name](settings, settings.tts_sections.get(name, {}))
    await asyncio.to_thread(engine.warm)
    started = time.monotonic()
    synthesis = await engine.synthesize(text, engine.default_voice)
    seconds = time.monotonic() - started
    raw = out_dir / f"{name}.raw.{synthesis.extension}"
    raw.write_bytes(synthesis.audio)
    matched = out_dir / f"{name}.wav"
    loudness = await asyncio.to_thread(normalize, raw, matched)
    raw.unlink()
    actual = comparable_words(await transcriber.transcribe(matched))
    expected = comparable_words(text)
    audio_seconds = soundfile.info(matched).duration
    return AbResult(
        name, str(matched), round(seconds, 2), round(audio_seconds, 2), round(seconds / synthesis.duration, 3),
        round(_word_error_rate(expected, actual), 4), round(loudness.integrated, 1), round(loudness.true_peak, 1), _misheard(expected, actual),
    )


def _word_error_rate(expected: list[str], actual: list[str]) -> float:
    previous = list(range(len(actual) + 1))
    for row, word in enumerate(expected, start=1):
        current = [row]
        for column, other in enumerate(actual, start=1):
            current.append(min(previous[column] + 1, current[-1] + 1, previous[column - 1] + (word != other)))
        previous = current
    return previous[-1] / len(expected) if expected else 0.0


def _misheard(expected: list[str], actual: list[str]) -> list[dict]:
    matcher = difflib.SequenceMatcher(a=expected, b=actual, autojunk=False)
    return [
        {"expected": " ".join(expected[a1:a2]), "heard": " ".join(actual[b1:b2])}
        for tag, a1, a2, b1, b2 in matcher.get_opcodes() if tag != "equal"
    ]
