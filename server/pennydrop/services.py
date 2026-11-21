from __future__ import annotations

from dataclasses import dataclass

from .gateway import Gateway
from .intake import Transcriber
from .settings import Settings, load_settings
from .store import Store
from .tracer import Tracer
from .tts import Speaker


@dataclass(frozen=True)
class Services:
    settings: Settings
    store: Store
    gateway: Gateway
    speaker: Speaker
    transcriber: Transcriber
    tracer: Tracer

    @classmethod
    def open(cls) -> Services:
        settings = load_settings()
        store = Store(settings.database_path)
        transcriber = Transcriber(settings)
        return cls(settings, store, Gateway(settings, store), Speaker(settings, transcriber), transcriber, Tracer(settings))
