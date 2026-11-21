from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from collections.abc import AsyncIterator
import tempfile
from pathlib import Path

import httpx

from .settings import Settings
from .words import WordTiming, normalize_word

SAMPLE_RATE = 16000


class IntakeError(RuntimeError):
    pass


class Transcriber:
    def __init__(self, settings: Settings):
        self._model = settings.whisper_model
        self._threads = settings.whisper_threads
        self._server: asyncio.subprocess.Process | None = None
        self._base_url = ""
        self._starting = asyncio.Lock()

    async def warm(self) -> None:
        await self._resident_server()

    async def close(self) -> None:
        if self._server and self._server.returncode is None:
            self._server.kill()
            await self._server.wait()

    async def transcribe(self, audio: bytes | Path) -> str:
        base_url = await self._resident_server()
        async with _prepared_wav(audio) as wav:
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.post(
                    f"{base_url}/inference", data={"response_format": "text", "language": "en"}, files={"file": ("speech.wav", wav.read_bytes())},
                )
        if response.status_code != 200:
            raise IntakeError(f"whisper-server answered {response.status_code}: {response.text[:300]}")
        return " ".join(response.text.split())

    async def _resident_server(self) -> str:
        async with self._starting:
            if self._server and self._server.returncode is None:
                return self._base_url
            if not self._model.exists():
                raise IntakeError(f"whisper model not found at {self._model}")
            port = _free_port()
            try:
                self._server = await asyncio.create_subprocess_exec(
                    "whisper-server", "-m", str(self._model), "--host", "127.0.0.1", "--port", str(port), "-t", str(self._threads),
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
            except FileNotFoundError:
                raise IntakeError("'whisper-server' is not installed or not on PATH; install whisper-cpp") from None
            self._base_url = f"http://127.0.0.1:{port}"
            await self._await_ready()
            return self._base_url

    async def _await_ready(self) -> None:
        async with httpx.AsyncClient(timeout=2) as client:
            for _ in range(120):
                if self._server.returncode is not None:
                    raise IntakeError(f"whisper-server exited with {self._server.returncode} while loading the model")
                try:
                    await client.get(self._base_url)
                    return
                except httpx.TransportError:
                    await asyncio.sleep(0.25)
        raise IntakeError("whisper-server did not start listening within 30 s")

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


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


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
