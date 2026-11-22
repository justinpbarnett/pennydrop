from __future__ import annotations

from abc import ABC, abstractmethod
from typing import ClassVar
from dataclasses import dataclass

from ..settings import Settings
from ..words import WordTiming
from .letters import respelled


class TtsError(RuntimeError):
    pass


@dataclass(frozen=True)
class Synthesis:
    audio: bytes
    extension: str
    duration: float
    words: list[WordTiming] | None


class Provider(ABC):
    name: ClassVar[str]

    def __init__(self, settings: Settings, section: dict):
        self.settings = settings
        self.section = section

    @property
    def default_voice(self) -> str:
        return self.section["voice"]

    def warm(self) -> None:
        return None

    def speakable(self, text: str) -> str:
        return respelled(text)

    @abstractmethod
    async def synthesize(self, text: str, voice: str) -> Synthesis: ...

