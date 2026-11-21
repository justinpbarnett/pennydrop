from __future__ import annotations

import base64

import httpx

from ..words import WordTiming, normalize_word
from .provider import Provider, Synthesis, TtsError

ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps"
EXTENSIONS = {"mp3": "mp3", "pcm": "wav", "ulaw": "wav"}


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
        extension = EXTENSIONS[self.section["output_format"].split("_")[0]]
        return Synthesis(base64.b64decode(body["audio_base64"]), extension, words[-1].end if words else 0.0, words)


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
