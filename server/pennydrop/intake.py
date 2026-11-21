from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
import tempfile
from pathlib import Path

from .settings import Settings
from .words import WordTiming, normalize_word

SAMPLE_RATE = 16000


class IntakeError(RuntimeError):
    pass


class Transcriber:
    def __init__(self, settings: Settings):
        self._model = settings.whisper_model
        self._threads = settings.whisper_threads

    async def transcribe(self, audio: bytes | Path) -> str:
        async with _prepared_wav(audio) as wav:
            await self._run_whisper(wav, "-nt", "-otxt")
            return " ".join(wav.with_suffix(".txt").read_text().split())

    async def word_timings(self, audio: bytes | Path) -> list[WordTiming]:
        async with _prepared_wav(audio) as wav:
            await self._run_whisper(wav, "-ml", "1", "-sow", "-oj")
            segments = json.loads(wav.with_suffix(".json").read_text())["transcription"]
        timings = [
            WordTiming(normalize_word(segment["text"]), segment["offsets"]["from"] / 1000, segment["offsets"]["to"] / 1000)
            for segment in segments
        ]
        return [timing for timing in timings if timing.word]

    async def _run_whisper(self, wav: Path, *mode_flags: str) -> None:
        if not self._model.exists():
            raise IntakeError(f"whisper model not found at {self._model}")
        await _run(
            ["whisper-cli", "-m", str(self._model), "-f", str(wav), "-l", "en", "-np", "-t", str(self._threads),
             "-of", str(wav.with_suffix("")), *mode_flags],
        )


@contextlib.asynccontextmanager
async def _prepared_wav(audio: bytes | Path) -> AsyncIterator[Path]:
    with tempfile.TemporaryDirectory(prefix="pennydrop-intake-") as name:
        directory = Path(name)
        source = audio
        if isinstance(audio, bytes):
            source = directory / "source"
            source.write_bytes(audio)
        wav = directory / "speech.wav"
        await _run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(wav)])
        yield wav


async def _run(argv: list[str]) -> bytes:
    try:
        process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except FileNotFoundError:
        raise IntakeError(f"'{argv[0]}' is not installed or not on PATH") from None
    try:
        stdout, stderr = await process.communicate()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode != 0:
        raise IntakeError(f"{argv[0]} exited with {process.returncode}: {stderr.decode(errors='replace')[-400:]}")
    return stdout
