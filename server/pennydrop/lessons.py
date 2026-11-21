from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from .settings import Settings
from .store import LessonRecord, LessonSource, Store
from .tts import Speaker

READY = "ready"


@dataclass(frozen=True)
class RawLesson:
    header: dict[str, Any]
    steps: list[dict[str, Any]]
    done: bool
    error: str | None = None


@dataclass(frozen=True)
class LessonDocument:
    id: str
    lesson: dict[str, Any]
    steps: list[dict[str, Any]]
    done: bool
    error: str | None


def done_event(record: LessonRecord, steps: int) -> dict[str, Any]:
    return {
        "steps": steps, "seconds": record.done_seconds, "first_step_seconds": record.first_step_seconds,
        "cost_usd": record.cost_usd, "tier": record.tier, "labs": record.labs, "timings": record.timings,
        "transcription_seconds": record.transcription_seconds, "repairs": record.repairs,
    }


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

    def raw(self, lesson_id: str) -> RawLesson:
        if lesson_id in self._hand_ids():
            header, steps = self._read_hand(lesson_id)
            return RawLesson(header, steps, True)
        record = self._store.lesson(lesson_id)
        if record is None:
            raise LookupError(f"no lesson with id '{lesson_id}'")
        header = record.header or {"title": record.title or record.ask}
        return RawLesson(header, self._store.steps(lesson_id), record.status == READY, record.error)

    async def document(self, lesson_id: str) -> LessonDocument:
        raw = self.raw(lesson_id)
        return LessonDocument(lesson_id, raw.header, [await self._with_voice(step) for step in raw.steps], raw.done, raw.error)

    def events(self, lesson_id: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        raw = self.raw(lesson_id)
        return self._replay(lesson_id, raw)

    async def _replay(self, lesson_id: str, raw: RawLesson) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        yield "lesson", {"id": lesson_id, "lesson": raw.header}
        for step in raw.steps:
            yield "step", await self._with_voice(step)
        record = self._store.lesson(lesson_id)
        if raw.error:
            yield "error", {"message": raw.error}
        elif record:
            yield "done", done_event(record, len(raw.steps))
        else:
            yield "done", {"steps": len(raw.steps)}

    def _hand_ids(self) -> list[str]:
        directory = self._settings.lessons_dir
        return sorted(path.stem for path in directory.glob("*.jsonl")) if directory.exists() else []

    def _read_hand(self, lesson_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        path = self._settings.lessons_dir / f"{lesson_id}.jsonl"
        lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        return lines[0]["lesson"], lines[1:]

    async def _with_voice(self, step: dict[str, Any]) -> dict[str, Any]:
        text = step.get("say")
        if not text or "voice" in step:
            return step
        voice = await self._speaker.voice(text)
        return {**step, "voice": voice.for_player()}
