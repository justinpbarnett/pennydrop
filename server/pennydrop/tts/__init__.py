from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from ..intake import Transcriber
from ..settings import Settings
from ..words import WordTiming, spoken_words
from .align import align_to_text
from .elevenlabs import ElevenLabsProvider
from .kokoro import KokoroProvider
from .provider import Provider, Synthesis, TtsError

__all__ = ["Speaker", "TtsError", "Voice"]

MEDIA_PREFIX = "/media/tts"
PROVIDERS = {provider.name: provider for provider in (KokoroProvider, ElevenLabsProvider)}


@dataclass(frozen=True)
class Voice:
    path: Path
    url: str
    duration: float
    words: list[WordTiming]
    cache_hit: bool

    def for_player(self) -> dict:
        return {"url": self.url, "duration": self.duration, "words": [asdict(word) for word in self.words]}


class Speaker:
    def __init__(self, settings: Settings, transcriber: Transcriber):
        self._settings = settings
        self._transcriber = transcriber
        self._providers: dict[str, Provider] = {}

    def warm(self) -> None:
        self._provider(self._settings.tts_provider).warm()

    async def voice(self, text: str, *, provider: str | None = None, voice: str | None = None) -> Voice:
        engine = self._provider(provider or self._settings.tts_provider)
        voice_name = voice or engine.default_voice
        stem = self._cache_stem(engine, voice_name, text)
        cached = self._read_cached(stem)
        if cached:
            return cached
        synthesis = await engine.synthesize(text, voice_name)
        return await self._store(stem, text, synthesis)

    def _provider(self, name: str) -> Provider:
        if name not in self._providers:
            if name not in PROVIDERS:
                raise TtsError(f"unknown tts provider '{name}', known providers: {', '.join(sorted(PROVIDERS))}")
            self._providers[name] = PROVIDERS[name](self._settings, self._settings.tts_sections.get(name, {}))
        return self._providers[name]

    def _cache_stem(self, engine: Provider, voice: str, text: str) -> str:
        identity = json.dumps([engine.name, voice, engine.section, text], sort_keys=True)
        return hashlib.sha256(identity.encode()).hexdigest()

    def _read_cached(self, stem: str) -> Voice | None:
        timings_path = self._settings.tts_cache_dir / f"{stem}.json"
        if not timings_path.exists():
            return None
        saved = json.loads(timings_path.read_text())
        audio_path = self._settings.tts_cache_dir / saved["audio"]
        return Voice(audio_path, f"{MEDIA_PREFIX}/{saved['audio']}", saved["duration"], [WordTiming(**word) for word in saved["words"]], True)

    async def _store(self, stem: str, text: str, synthesis: Synthesis) -> Voice:
        directory = self._settings.tts_cache_dir
        directory.mkdir(parents=True, exist_ok=True)
        audio_name = f"{stem}.{synthesis.extension}"
        audio_path = directory / audio_name
        audio_path.write_bytes(synthesis.audio)
        words = synthesis.words
        if words is None:
            words = align_to_text(text, await self._transcriber.word_timings(audio_path))
        _require_words_match(text, words)
        (directory / f"{stem}.json").write_text(
            json.dumps({"audio": audio_name, "duration": synthesis.duration, "words": [asdict(word) for word in words]})
        )
        return Voice(audio_path, f"{MEDIA_PREFIX}/{audio_name}", synthesis.duration, words, False)


def _require_words_match(text: str, words: list[WordTiming]) -> None:
    expected = [word.lower() for word in spoken_words(text)]
    actual = [timing.word.lower() for timing in words]
    if expected != actual:
        raise TtsError(f"word timings do not line up with the text: expected {expected}, got {actual}")
