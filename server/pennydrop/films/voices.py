from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..tts import Speaker, TtsError, Voice

VOICES: dict[str, dict[str, str]] = {
    "narrator-low": {"kokoro": "am_onyx", "qwen3": "Ryan"},
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
    name = VOICES[voice_id][provider]
    return [SpokenLine(await speaker.voice(say, provider=provider, voice=name)) for say in says]
