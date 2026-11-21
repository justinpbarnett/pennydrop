from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass

from ..gateway import Gateway
from ..lessons import LessonLibrary
from ..settings import Settings
from ..store import LessonRecord, LessonSource, Store
from ..tracer import Tracer
from ..tts import Speaker
from .catalog import Catalog
from .classify import Classifier, Viewing
from .directives import DirectiveTools
from .live import Event, LiveLesson
from .run import Ask, LessonRun, Toolkit
from .stopwatch import Stopwatch
from .validator import Validator
from .writer import Writer

__all__ = ["AskRequest", "Asks", "FromStep"]


@dataclass(frozen=True)
class FromStep:
    lesson_id: str
    step: int


@dataclass(frozen=True)
class AskRequest:
    text: str
    profile_id: int | None
    from_step: FromStep | None
    received_at: float
    transcription_seconds: float | None = None


class Asks:
    def __init__(self, settings: Settings, store: Store, library: LessonLibrary, gateway: Gateway, speaker: Speaker, tracer: Tracer):
        catalog = Catalog(settings)
        self._store = store
        self._library = library
        self._validator = Validator(settings)
        self._kit = Toolkit(store, catalog, Classifier(gateway), Writer(gateway, catalog), self._validator, DirectiveTools(tracer), speaker)
        self._live: dict[str, LiveLesson] = {}
        self._running: set[asyncio.Task] = set()

    async def start(self, request: AskRequest) -> str:
        profile = self._store.profile(request.profile_id) if request.profile_id is not None else None
        viewing, earlier_steps = self._viewing(request.from_step)
        lesson_id = uuid.uuid4().hex[:12]
        record = LessonRecord(
            lesson_id, request.text, "", [], LessonSource.LIVE, status="writing", transcription_seconds=request.transcription_seconds,
        )
        self._store.save_lesson(record)
        live = LiveLesson()
        self._live[lesson_id] = live
        run = LessonRun(self._kit, Ask(request.text, profile, viewing, earlier_steps), record, live, Stopwatch(request.received_at))
        task = asyncio.create_task(run.run())
        self._running.add(task)
        task.add_done_callback(lambda finished: (self._running.discard(finished), self._live.pop(lesson_id, None)))
        return lesson_id

    def events(self, lesson_id: str) -> AsyncIterator[Event]:
        live = self._live.get(lesson_id)
        return live.stream() if live else self._library.events(lesson_id)

    async def close(self) -> None:
        for task in self._running:
            task.cancel()
        await self._validator.close()

    def _viewing(self, from_step: FromStep | None) -> tuple[Viewing | None, list[dict]]:
        if from_step is None:
            return None, []
        source = self._library.raw(from_step.lesson_id)
        earlier = [step for step in source.steps if step["step"] <= from_step.step]
        if not earlier or earlier[-1]["step"] != from_step.step:
            raise LookupError(f"lesson '{from_step.lesson_id}' has no step {from_step.step}")
        return Viewing(source.header.get("title", ""), source.header.get("goal", ""), earlier[-1]["say"]), earlier
