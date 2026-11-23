from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..tts import Speaker, TtsError, Voice


@dataclass(frozen=True)
class Narrator:
    voice: str
    pace: float = 1.0


VOICES: dict[str, dict[str, Narrator]] = {
    "narrator-low": {"kokoro": Narrator("am_onyx", pace=0.85), "qwen3": Narrator("Ryan")},
}


@dataclass(frozen=True)
class SpokenLine:
    voice: Voice

    @property
    def path(self) -> Path:
        return self.voice.path


async def speak_film(speaker: Speaker, provider: str, voice_id: str, says: list[str]) -> list[SpokenLine]:
    if voice_id not in VOICES:
        raise TtsError(f"unknown film voice '{voice_id}', known voices: {', '.join(VOICES)}")
    if provider not in VOICES[voice_id]:
        raise TtsError(f"film voice '{voice_id}' has no voice for tts provider '{provider}'")
    narrator = VOICES[voice_id][provider]
    return [SpokenLine(await speaker.voice(say, provider=provider, voice=narrator.voice, pace=narrator.pace)) for say in says]
