from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from .settings import Settings
from .store import LessonSource, Store
from .tts import Speaker


@dataclass(frozen=True)
class LessonDocument:
    id: str
    lesson: dict[str, Any]
    steps: list[dict[str, Any]]


class LessonLibrary:
    def __init__(self, settings: Settings, store: Store, speaker: Speaker):
        self._settings = settings
        self._store = store
        self._speaker = speaker

    def summaries(self) -> list[dict[str, Any]]:
        hand = [{"id": lesson_id, **self._read_hand(lesson_id)[0], "source": LessonSource.HAND.value} for lesson_id in self._hand_ids()]
        hand_ids = {item["id"] for item in hand}
        stored = [
            {"id": record.id, "ask": record.ask, "title": record.title, "labs": record.labs, "source": record.source.value, "status": record.status}
            for record in self._store.lessons()
        ]
        return hand + [item for item in stored if item["id"] not in hand_ids]

    def has(self, lesson_id: str) -> bool:
        return lesson_id in self._hand_ids() or self._store.lesson(lesson_id) is not None

    def header(self, lesson_id: str) -> dict[str, Any]:
        return self._raw_document(lesson_id)[0]

    async def voiced_steps(self, lesson_id: str) -> AsyncIterator[dict[str, Any]]:
        for step in self._raw_document(lesson_id)[1]:
            yield await self._with_voice(step)

    async def document(self, lesson_id: str) -> LessonDocument:
        return LessonDocument(lesson_id, self.header(lesson_id), [step async for step in self.voiced_steps(lesson_id)])

    def _raw_document(self, lesson_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if lesson_id in self._hand_ids():
            return self._read_hand(lesson_id)
        record = self._store.lesson(lesson_id)
        if record is None:
            raise LookupError(f"no lesson with id '{lesson_id}'")
        header = {"ask": record.ask, "title": record.title, "labs": record.labs, "source": record.source.value, "status": record.status}
        return header, self._store.steps(lesson_id)

    def _hand_ids(self) -> list[str]:
        directory = self._settings.lessons_dir
        return sorted(path.stem for path in directory.glob("*.jsonl")) if directory.exists() else []

    def _read_hand(self, lesson_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        path = self._settings.lessons_dir / f"{lesson_id}.jsonl"
        lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        return lines[0], lines[1:]

    async def _with_voice(self, step: dict[str, Any]) -> dict[str, Any]:
        text = step.get("say")
        if not text:
            return step
        voice = await self._speaker.voice(text)
        return {**step, "voice": voice.for_player()}

