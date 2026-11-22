from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from .practice import Practice, Rule
from .practice.records import PracticeWire
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
    practice: PracticeWire | None = None


@dataclass(frozen=True)
class LessonDocument:
    id: str
    lesson: dict[str, Any]
    steps: list[dict[str, Any]]
    done: bool
    error: str | None
    practice: PracticeWire | None


def done_event(record: LessonRecord, steps: int) -> dict[str, Any]:
    return {
        "steps": steps, "seconds": record.done_seconds, "first_step_seconds": record.first_step_seconds,
        "cost_usd": record.cost_usd, "labs": record.labs, "timings": record.timings,
        "transcription_seconds": record.transcription_seconds, "repairs": record.repairs,
        "point_check": record.header.get("point_check"), "practice_check": record.header.get("practice_check"),
    }


class LessonLibrary:
    def __init__(self, settings: Settings, store: Store, speaker: Speaker):
        self._settings = settings
        self._store = store
        self._speaker = speaker
        for lesson_id in self._hand_ids():
            self._register_hand_practice(lesson_id)

    def summaries(self, profile_id: int | None = None) -> list[dict[str, Any]]:
        hand = [{"id": lesson_id, **self._read_hand(lesson_id)[0], "source": LessonSource.HAND.value} for lesson_id in self._hand_ids()] if profile_id is None else []
        hand_ids = {item["id"] for item in hand}
        stored = [
            {"id": record.id, "ask": record.ask, "title": record.title, "labs": record.labs, "source": record.source.value, "status": record.status, "profile_id": record.profile_id}
            for record in self._store.lessons(profile_id)
        ]
        return hand + [item for item in stored if item["id"] not in hand_ids]

    def raw(self, lesson_id: str) -> RawLesson:
        if lesson_id in self._hand_ids():
            header, steps, _ = self._read_hand(lesson_id)
            return RawLesson(header, steps, True, practice=self._store.lesson_practice(lesson_id))
        record = self._store.lesson(lesson_id)
        if record is None:
            raise LookupError(f"no lesson with id '{lesson_id}'")
        header = record.header or {"title": record.title or record.ask}
        return RawLesson(header, self._store.steps(lesson_id), record.status == READY, record.error, self._store.lesson_practice(lesson_id))

    def attach_practice(self, lesson_id: str, practice: Practice) -> PracticeWire:
        if lesson_id in self._hand_ids():
            self._write_hand_practice(lesson_id, practice)
            self._register_hand_practice(lesson_id)
            return self._store.lesson_practice(lesson_id)
        record = self._store.lesson(lesson_id)
        if record is None:
            raise LookupError(f"no lesson with id '{lesson_id}'")
        return self._store.save_practice(lesson_id, practice, record.topic_id)

    async def document(self, lesson_id: str) -> LessonDocument:
        raw = self.raw(lesson_id)
        steps = await asyncio.gather(*(self._with_voice(step) for step in raw.steps))
        return LessonDocument(lesson_id, raw.header, list(steps), raw.done, raw.error, await self._numbered_practice(raw))

    def events(self, lesson_id: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        raw = self.raw(lesson_id)
        return self._replay(lesson_id, raw)

    async def _replay(self, lesson_id: str, raw: RawLesson) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        yield "lesson", {"id": lesson_id, "lesson": raw.header}
        voicing = [asyncio.ensure_future(self._with_voice(step)) for step in raw.steps]
        try:
            for step in voicing:
                yield "step", await step
        finally:
            for step in voicing:
                step.cancel()
        if raw.practice:
            yield "practice", await self._numbered_practice(raw)
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

    def _read_hand(self, lesson_id: str) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
        lines = self._hand_lines(lesson_id)
        practice = [line["practice"] for line in lines if "practice" in line]
        return lines[0]["lesson"], [line for line in lines[1:] if "practice" not in line], practice[-1] if practice else None

    def _register_hand_practice(self, lesson_id: str) -> None:
        line = self._read_hand(lesson_id)[2]
        if line:
            self._store.save_practice(lesson_id, _practice_of(line), None)

    def _hand_lines(self, lesson_id: str) -> list[dict[str, Any]]:
        path = self._settings.lessons_dir / f"{lesson_id}.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def _write_hand_practice(self, lesson_id: str, practice: Practice) -> None:
        lines = [line for line in self._hand_lines(lesson_id) if "practice" not in line]
        unvoiced = Practice(practice.rule, tuple({key: value for key, value in item.items() if key != "voice"} for item in practice.items))
        path = self._settings.lessons_dir / f"{lesson_id}.jsonl"
        path.write_text("".join(json.dumps(line) + "\n" for line in [*lines, unvoiced.line()]))

    async def _numbered_practice(self, raw: RawLesson) -> PracticeWire | None:
        if raw.practice is None:
            return None
        last_step = raw.steps[-1]["step"] if raw.steps else 0
        items = await asyncio.gather(*(self._with_voice({**item, "step": last_step + position}) for position, item in enumerate(raw.practice["items"], start=1)))
        return {**raw.practice, "items": list(items)}

    async def _with_voice(self, step: dict[str, Any]) -> dict[str, Any]:
        text = step.get("say")
        if not text or "voice" in step:
            return step
        voice = await self._speaker.voice(text)
        return {**step, "voice": voice.for_player()}


def _practice_of(line: dict[str, Any]) -> Practice:
    return Practice(Rule(line["rule"], line["condition"], tuple(line["slots"])), tuple(line["challenges"]))
