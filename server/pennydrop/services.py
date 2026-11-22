from __future__ import annotations

from dataclasses import dataclass

from .asks import Asks
from .gateway import Gateway
from .intake import Transcriber
from .judge import Judge
from .lessons import LessonLibrary
from .practice.grade import WordsGrader
from .practice.queue import RuleQueue
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
    library: LessonLibrary
    asks: Asks
    judge: Judge
    queue: RuleQueue
    grader: WordsGrader

    @classmethod
    def open(cls) -> Services:
        settings = load_settings()
        store = Store(settings.database_path)
        transcriber = Transcriber(settings)
        gateway = Gateway(settings, store)
        speaker = Speaker(settings, transcriber)
        tracer = Tracer(settings)
        library = LessonLibrary(settings, store, speaker)
        return cls(settings, store, gateway, speaker, transcriber, tracer, library, Asks(settings, store, library, gateway, speaker, tracer), Judge(gateway, library), RuleQueue(store), WordsGrader(gateway))
