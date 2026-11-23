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
from .letters import respelled
from .provider import Provider, Synthesis, TtsError
from .qwen3 import Qwen3Provider

__all__ = ["Speaker", "TtsError", "Voice"]

MEDIA_PREFIX = "/media/tts"
PROVIDERS = {provider.name: provider for provider in (KokoroProvider, ElevenLabsProvider, Qwen3Provider)}


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

    async def voice(self, text: str, *, provider: str | None = None, voice: str | None = None, pace: float = 1.0) -> Voice:
        engine = self._provider(provider or self._settings.tts_provider)
        if pace != 1.0 and not engine.paces:
            raise TtsError(f"tts provider '{engine.name}' speaks at one pace, so it cannot speak at pace {pace}")
        voice_name = voice or engine.default_voice
        spoken = engine.speakable(text)
        stem = self._cache_stem(engine, voice_name, spoken, pace)
        cached = self._read_cached(stem)
        if cached:
            return cached
        synthesis = await engine.synthesize(spoken, voice_name, pace)
        return await self._store(stem, text, respelled(text), synthesis)

    def _provider(self, name: str) -> Provider:
        if name not in self._providers:
            if name not in PROVIDERS:
                raise TtsError(f"unknown tts provider '{name}', known providers: {', '.join(sorted(PROVIDERS))}")
            self._providers[name] = PROVIDERS[name](self._settings, self._settings.tts_sections.get(name, {}))
        return self._providers[name]

    def _cache_stem(self, engine: Provider, voice: str, text: str, pace: float) -> str:
        identity = [engine.name, voice, engine.section, text]
        if pace != 1.0:
            # A natural pace keeps the key it had before pace existed, so audio cached then stays valid.
            identity.append(pace)
        return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    def _read_cached(self, stem: str) -> Voice | None:
        timings_path = self._settings.tts_cache_dir / f"{stem}.json"
        if not timings_path.exists():
            return None
        saved = json.loads(timings_path.read_text())
        audio_path = self._settings.tts_cache_dir / saved["audio"]
        return Voice(audio_path, f"{MEDIA_PREFIX}/{saved['audio']}", saved["duration"], [WordTiming(**word) for word in saved["words"]], True)

    async def _store(self, stem: str, text: str, aligned_text: str, synthesis: Synthesis) -> Voice:
        directory = self._settings.tts_cache_dir
        directory.mkdir(parents=True, exist_ok=True)
        audio_name = f"{stem}.{synthesis.extension}"
        audio_path = directory / audio_name
        audio_path.write_bytes(synthesis.audio)
        words = synthesis.words
        if words is None:
            words = align_to_text(aligned_text, await self._transcriber.word_timings(audio_path))
        words = _as_script_words(text, aligned_text, words)
        (directory / f"{stem}.json").write_text(
            json.dumps({"audio": audio_name, "duration": synthesis.duration, "words": [asdict(word) for word in words]})
        )
        return Voice(audio_path, f"{MEDIA_PREFIX}/{audio_name}", synthesis.duration, words, False)


def _as_script_words(text: str, aligned_text: str, words: list[WordTiming]) -> list[WordTiming]:
    expected = spoken_words(text)
    heard = [timing.word.lower() for timing in words]
    if heard not in ([word.lower() for word in spoken_words(candidate)] for candidate in (text, aligned_text)):
        raise TtsError(f"word timings do not line up with the text: expected {expected}, got {heard}")
    return [WordTiming(word, timing.start, timing.end) for word, timing in zip(expected, words, strict=True)]
