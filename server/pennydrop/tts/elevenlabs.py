from __future__ import annotations

import asyncio
import base64
import io
import wave

import httpx

from ..words import WordTiming, normalize_word
from .provider import Provider, Synthesis, TtsError

ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps"
PCM_SAMPLE_WIDTH_BYTES = 2


class ElevenLabsProvider(Provider):
    name = "elevenlabs"

    async def synthesize(self, text: str, voice: str) -> Synthesis:
        key = self.settings.secret("ELEVENLABS_API_KEY")
        if not key:
            raise TtsError("ELEVENLABS_API_KEY is not set in .env, so the elevenlabs voice cannot speak yet")
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                ENDPOINT.format(voice=voice),
                params={"output_format": self.section["output_format"]},
                headers={"xi-api-key": key},
                json={"text": text, "model_id": self.section["model"]},
            )
        if response.status_code != 200:
            raise TtsError(f"elevenlabs answered {response.status_code}: {response.text[:300]}")
        body = response.json()
        words = _words_from(body["alignment"])
        audio = base64.b64decode(body["audio_base64"])
        codec, _, rate = self.section["output_format"].partition("_")
        if codec == "pcm":
            return _pcm_synthesis(audio, int(rate), words)
        if codec == "mp3":
            return Synthesis(audio, "mp3", await _mp3_duration(audio), words)
        raise TtsError(f"tts.elevenlabs output_format '{self.section['output_format']}' is not supported; use an mp3_* or pcm_* format")


def _pcm_synthesis(pcm: bytes, sample_rate: int, words: list[WordTiming]) -> Synthesis:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(PCM_SAMPLE_WIDTH_BYTES)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return Synthesis(buffer.getvalue(), "wav", len(pcm) / (PCM_SAMPLE_WIDTH_BYTES * sample_rate), words)


async def _mp3_duration(audio: bytes) -> float:
    try:
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-nostats", "-i", "pipe:0", "-f", "null", "-", "-progress", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise TtsError("'ffmpeg' is not installed or not on PATH; it measures the length of elevenlabs mp3 audio") from None
    stdout, stderr = await process.communicate(audio)
    decoded = [int(line.split("=")[1]) for line in stdout.decode().splitlines() if line.startswith("out_time_us=")]
    if process.returncode != 0 or not decoded:
        raise TtsError(f"ffmpeg could not decode the elevenlabs mp3: {stderr.decode(errors='replace')[-300:]}")
    return decoded[-1] / 1_000_000


def _words_from(alignment: dict) -> list[WordTiming]:
    words = []
    pieces: list[str] = []
    spans: list[tuple[float, float]] = []
    triples = list(zip(alignment["characters"], alignment["character_start_times_seconds"], alignment["character_end_times_seconds"], strict=True))
    for character, start, end in triples + [(" ", 0.0, 0.0)]:
        if character.isspace():
            word = normalize_word("".join(pieces))
            if word:
                words.append(WordTiming(word, spans[0][0], spans[-1][1]))
            pieces, spans = [], []
        else:
            pieces.append(character)
            if normalize_word(character):
                spans.append((start, end))
    return words
