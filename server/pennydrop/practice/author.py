from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from ..asks.classify import Plan
from ..asks.lesson_format import Malformed, ParsedLine
from ..asks.stage import Stage
from ..asks.validator import Validator
from ..asks.writer import Brief, Writer, lesson_text
from ..lessons import LessonLibrary
from ..store import Profile, ProfileKind
from ..tts import Speaker, TtsError
from . import Direction, Form, Practice, PracticeError, Rule
from .check import ItemCheck, PracticeChecker, Standing, case_keys

LOG = logging.getLogger(__name__)

MAX_REDOS = 3
BACK_TRIES = 2
WHY_LENGTH = 200


@dataclass(frozen=True)
class Authored:
    practice: Practice | None
    check: str


class PracticeAuthor:
    def __init__(self, library: LessonLibrary, writer: Writer, checker: PracticeChecker, validator: Validator, speaker: Speaker):
        self._library = library
        self._writer = writer
        self._checker = checker
        self._validator = validator
        self._speaker = speaker

    keys_of = staticmethod(case_keys)

    def standing(self, stage: Stage, scene: Any, remembered: dict[str, Any], cases: frozenset[str], reading: bool) -> Standing:
        return Standing(stage, scene, remembered, cases, reading)

    async def settle(self, first: ParsedLine | None, brief: Brief, header: dict[str, Any], steps: list[dict[str, Any]], standing: Standing, lesson_id: str) -> Authored:
        told = lesson_text(header, steps)
        written = first if first is not None else await self._writer.practice_line(brief, told, lesson_id)
        failure = ""
        for redo in range(MAX_REDOS + 1):
            errors = await self._errors(written, standing, steps, lesson_id)
            if not errors.reasons:
                return Authored(errors.practice, "second call" if first is None else f"redone: {failure}" if failure else "passed")
            failure = failure or _why(errors.reasons)
            LOG.warning("lesson %s practice line failed check %s: %s", lesson_id, redo + 1, " | ".join(errors.reasons))
            if redo == MAX_REDOS:
                break
            written = await self._writer.practice_line(brief, told, lesson_id, written, errors.reasons)
        return Authored(None, f"missed: {failure}")

    async def voiced(self, practice: Practice) -> Practice:
        return Practice(practice.rule, tuple([await self._voiced(item) for item in practice.items]))

    async def case(self, rule: Rule, form: Form, direction: Direction | None, lesson_id: str, seen: list[dict[str, Any]], profile: Profile | None) -> dict[str, Any]:
        standing = Standing.empty(profile is None or profile.kind is not ProfileKind.KID)
        lesson = lesson_text({}, [])
        taken = frozenset().union(*(case_keys(item) for item in seen))
        errors: list[str] = []
        for running in _directions_to_try(direction, standing.reading):
            errors = []
            for _ in range(BACK_TRIES if running is Direction.BACK else MAX_REDOS + 1):
                written = await self._writer.case(rule, form, running, lesson, seen, profile, errors, lesson_id)
                if isinstance(written, dict) and written.get("back") is False and running is Direction.BACK:
                    break
                checked = await self._checked_case(written, rule, form, running, standing, taken, lesson_id)
                if checked.item is not None:
                    return await self._voiced(checked.item)
                errors = checked.errors
                LOG.warning("lesson %s %s case failed its check: %s", lesson_id, form.value, " | ".join(errors))
        raise PracticeError(f"no {form.value} case for the Rule passed its check: {_why(errors)}")

    async def for_lesson(self, lesson_id: str) -> Practice:
        raw = self._library.raw(lesson_id)
        reading = raw.header.get("reading", True)
        steps = [{name: value for name, value in step.items() if name != "voice"} for step in raw.steps]
        standing = await self._standing_after(steps, reading)
        plan = Plan(False, tuple(raw.header.get("labs", ())), True, False, None)
        brief = Brief(raw.header.get("title", lesson_id), None, plan)
        authored = await self.settle(None, brief, raw.header, steps, standing, lesson_id)
        if authored.practice is None:
            raise PracticeError(f"no practice line for lesson {lesson_id} passed its check: {authored.check}")
        return authored.practice

    async def _standing_after(self, steps: list[dict[str, Any]], reading: bool) -> Standing:
        stage = Stage(kid=not reading)
        for step in steps:
            stage.settle(step)
            stage.remember_trace(step, step, {})
        replay = await self._validator.replay(steps, reading)
        if replay.skipped:
            LOG.warning("the stored steps play with these ops skipped: %s", "; ".join(replay.skipped))
        return Standing(stage, replay.scene, {}, frozenset().union(*(case_keys(step) for step in steps)), reading)

    async def _errors(self, written: ParsedLine, standing: Standing, steps: list[dict[str, Any]], lesson_id: str) -> LineErrors:
        if not isinstance(written, dict) or "practice" not in written:
            reason = f"{written.reason}: {written.text[:300]}" if isinstance(written, Malformed) else "the reply was not a practice line"
            return LineErrors([reason], None)
        checked = await self._checker.line(written, standing, steps, lesson_id)
        return LineErrors(checked.errors, checked.practice)

    async def _checked_case(self, written: ParsedLine, rule: Rule, form: Form, direction: Direction | None, standing: Standing, taken: frozenset[str], lesson_id: str) -> ItemCheck:
        if not isinstance(written, dict):
            return ItemCheck([f"{written.reason}: {written.text[:300]}"], None, standing)
        item = {**written, "form": form.value, **({"direction": direction.value} if direction else {})}
        return await self._checker.item(item, rule, standing, taken, lesson_id)

    async def _voiced(self, item: dict[str, Any]) -> dict[str, Any]:
        try:
            voice = await self._speaker.voice(item["say"])
        except TtsError as error:
            LOG.warning("practice item has no voice: %s", error)
            return item
        return {**item, "voice": voice.for_player()}


@dataclass(frozen=True)
class LineErrors:
    reasons: list[str]
    practice: Practice | None


def _directions_to_try(direction: Direction | None, reading: bool) -> list[Direction | None]:
    if direction is not Direction.BACK:
        return [direction]
    return [Direction.BACK, Direction.FORWARD] if reading else [Direction.FORWARD]


def _why(reasons: list[str]) -> str:
    return reasons[0][:WHY_LENGTH]
