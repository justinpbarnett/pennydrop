from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, replace
from typing import Any

from ..lessons import done_event
from ..store import LessonRecord, Profile, ProfileKind, Store
from ..tts import Speaker, TtsError, Voice
from .catalog import Catalog
from .classify import Classifier, Plan, Viewing
from .directives import DirectiveError, DirectiveTools, expand_directives
from .lesson_format import Header, Malformed
from .live import LiveLesson
from .stopwatch import Stopwatch
from .validator import Validator
from .writer import Brief, Writer

LOG = logging.getLogger("pennydrop.asks")
MAX_REPAIR_TRIES = 2
PLACEHOLDER = re.compile(r"\s*\{[^}]*\}")
SAY_FIELD = re.compile(r'"say"\s*:\s*("(?:[^"\\]|\\.)*")')


class LessonError(RuntimeError):
    pass


@dataclass(frozen=True)
class Toolkit:
    store: Store
    catalog: Catalog
    classifier: Classifier
    writer: Writer
    validator: Validator
    directive_tools: DirectiveTools
    speaker: Speaker


@dataclass(frozen=True)
class Ask:
    text: str
    profile: Profile | None
    viewing: Viewing | None
    earlier_steps: list[dict[str, Any]]


@dataclass(frozen=True)
class PendingStep:
    number: int
    written: dict[str, Any] | Malformed
    voice: asyncio.Task[Voice | None] | None


@dataclass(frozen=True)
class Checked:
    errors: list[str]
    step: dict[str, Any] | None
    scene: Any


@dataclass(frozen=True)
class SettledStep:
    step: dict[str, Any]
    scene: Any


@dataclass(frozen=True)
class ReadyStep:
    step: dict[str, Any]
    voice: asyncio.Task[Voice | None]


class LessonRun:
    def __init__(self, toolkit: Toolkit, ask: Ask, record: LessonRecord, live: LiveLesson, stopwatch: Stopwatch):
        self._kit = toolkit
        self._ask = ask
        self._record = record
        self._live = live
        self._stopwatch = stopwatch
        self._voices: dict[str, asyncio.Task[Voice | None]] = {}
        self._repairs: list[dict[str, Any]] = []
        self._catalog_labs: set[str] = set()
        self._published = 0

    async def run(self) -> None:
        try:
            await self._write()
        except BaseExceptionGroup as group:
            self._fail(group.exceptions[0])
        except Exception as error:
            self._fail(error)
        finally:
            self._live.close()

    async def _write(self) -> None:
        kit = self._kit
        snapshot = await kit.catalog.current()
        self._catalog_labs = {lab.id for lab in snapshot.labs}
        plan = await kit.classifier.plan(self._ask.text, self._ask.profile, snapshot.labs, self._ask.viewing, self._record.id)
        self._stopwatch.mark("classified")
        self._record = replace(self._record, tier=plan.tier.value)
        start_scene = await kit.validator.replay(self._ask.earlier_steps) if plan.follow_up else None
        brief = Brief(self._ask.text, self._ask.profile, plan, start_scene, self._ask.viewing.title if self._ask.viewing else None)
        pending: asyncio.Queue[PendingStep | None] = asyncio.Queue()
        ready: asyncio.Queue[ReadyStep | None] = asyncio.Queue()
        async with asyncio.TaskGroup() as group:
            group.create_task(self._read(brief, plan, start_scene, pending))
            group.create_task(self._settle(brief, start_scene, pending, ready))
            group.create_task(self._publish(ready))
        self._finish()

    async def _read(self, brief: Brief, plan: Plan, start_scene: Any, pending: asyncio.Queue[PendingStep | None]) -> None:
        number = 0
        async for line in self._kit.writer.lines(brief, self._stopwatch, self._record.id):
            if isinstance(line, Header):
                if self._record.header:
                    raise LessonError("the writer sent a second lesson header")
                self._open(line, start_scene if plan.follow_up else None)
                continue
            if not self._record.header:
                raise LessonError("the writer's first line was not a lesson header, so the Lesson cannot start")
            number += 1
            self._stopwatch.mark("first_step_parsed")
            await pending.put(PendingStep(number, line, self._prevoice(line)))
        if number == 0:
            raise LessonError("the writer finished without writing any Step")
        await pending.put(None)

    def _open(self, header: Header, start_scene: Any) -> None:
        header = header.model_copy(update={"labs": [lab for lab in header.labs if lab in self._catalog_labs], "start_scene": start_scene})
        data = header.model_dump(exclude_none=True)
        self._record = replace(self._record, title=header.title, labs=header.labs, header=data)
        self._kit.store.save_lesson(self._record)
        self._live.publish("lesson", {"id": self._record.id, "lesson": data})

    async def _settle(self, brief: Brief, scene: Any, pending: asyncio.Queue[PendingStep | None], ready: asyncio.Queue[ReadyStep | None]) -> None:
        while (step := await pending.get()) is not None:
            settled = await self._settle_step(brief, step, scene)
            scene = settled.scene
            self._stopwatch.mark("first_step_checked")
            await ready.put(ReadyStep(settled.step, self._voice(settled.step["say"])))
        await ready.put(None)

    async def _settle_step(self, brief: Brief, pending: PendingStep, scene: Any) -> SettledStep:
        written = pending.written
        for attempt in range(MAX_REPAIR_TRIES + 1):
            checked = await self._check(written, pending.number, scene)
            if not checked.errors:
                return SettledStep(checked.step, checked.scene)
            if attempt == MAX_REPAIR_TRIES:
                break
            self._log_repair(pending.number, attempt + 1, checked.errors, "redone by the writer")
            written = await self._kit.writer.repair(brief, scene, written, checked.errors, self._record.id)
        return await self._salvage(pending.number, written, checked, scene)

    async def _check(self, written: dict[str, Any] | Malformed, number: int, scene: Any) -> Checked:
        if isinstance(written, Malformed):
            return Checked([written.reason], None, scene)
        step = {**written, "step": number}
        try:
            step = await expand_directives(step, self._kit.directive_tools)
        except DirectiveError as error:
            return Checked([str(error)], None, scene)
        verdict, fine_for_child = await asyncio.gather(self._kit.validator.check(step, scene), self._fine_for_child(step))
        errors = list(verdict.errors)
        if not fine_for_child:
            errors.append("say is not fine for a young child; rewrite the narration so it is gentle, true and free of frightening or adult content")
        return Checked(errors, step, verdict.scene)

    async def _fine_for_child(self, step: dict[str, Any]) -> bool:
        profile = self._ask.profile
        if profile is None or profile.kind is not ProfileKind.KID or not isinstance(step.get("say"), str):
            return True
        return await self._kit.classifier.fine_for_young_child(step["say"], self._record.id)

    async def _salvage(self, number: int, written: dict[str, Any] | Malformed, last: Checked, scene: Any) -> SettledStep:
        step = last.step or {}
        say = _recover_say(step, written)
        validator = self._kit.validator
        for kept_fields in (("scene", "challenge"), ("scene",), ()):
            candidate = {"step": number, "say": say, **{field: step[field] for field in kept_fields if field in step}}
            verdict = await validator.check(candidate, scene)
            if verdict.ok:
                break
        else:
            raise LessonError(f"Step {number} could not be repaired, and even its narration alone failed: {'; '.join(verdict.errors)}")
        kept_ops: list[dict[str, Any]] = []
        for operation in step.get("do", []) if "scene" in candidate else []:
            trial = await validator.check({**candidate, "do": [*kept_ops, operation]}, scene)
            if trial.ok:
                kept_ops.append(operation)
                verdict = trial
        outcome = f"kept the narration, dropped fields {sorted(set(step) - set(candidate))} and {len(step.get('do', [])) - len(kept_ops)} operations"
        self._log_repair(number, MAX_REPAIR_TRIES + 1, last.errors, outcome)
        return SettledStep({**candidate, **({"do": kept_ops} if kept_ops else {})}, verdict.scene)

    def _log_repair(self, number: int, attempt: int, errors: list[str], outcome: str) -> None:
        LOG.warning("lesson %s step %s failed check %s: %s -> %s", self._record.id, number, attempt, " | ".join(errors), outcome)
        self._repairs.append({"step": number, "attempt": attempt, "errors": errors, "outcome": outcome})

    def _prevoice(self, written: dict[str, Any] | Malformed) -> asyncio.Task[Voice | None] | None:
        say = written.get("say") if isinstance(written, dict) else None
        return self._voice(say) if isinstance(say, str) and say and "{" not in say else None

    def _voice(self, text: str) -> asyncio.Task[Voice | None]:
        if text not in self._voices:
            task = asyncio.create_task(self._speak(text))
            task.add_done_callback(lambda finished: finished.cancelled() or finished.exception())
            self._voices[text] = task
        return self._voices[text]

    async def _speak(self, text: str) -> Voice | None:
        try:
            return await self._kit.speaker.voice(text)
        except TtsError as error:
            LOG.warning("lesson %s narration has no voice: %s", self._record.id, error)
            return None

    async def _publish(self, ready: asyncio.Queue[ReadyStep | None]) -> None:
        while (item := await ready.get()) is not None:
            voice = await item.voice
            self._stopwatch.mark("first_step_voiced")
            voice_data = voice.for_player() if voice else None
            self._kit.store.save_step(self._record.id, item.step["step"], item.step, voice_data)
            self._live.publish("step", {**item.step, **({"voice": voice_data} if voice_data else {})})
            self._published += 1
            self._stopwatch.mark("first_step_published")

    def _finish(self) -> None:
        marks = self._stopwatch.marks
        record = replace(
            self._record, status="ready", first_step_seconds=marks["first_step_published"], done_seconds=self._stopwatch.elapsed(),
            cost_usd=self._kit.store.lesson_cost(self._record.id), timings=marks, repairs=self._repairs,
        )
        self._kit.store.save_lesson(record)
        self._live.publish("done", done_event(record, self._published))

    def _fail(self, error: BaseException) -> None:
        LOG.error("lesson %s failed: %s", self._record.id, error)
        record = replace(
            self._record, status="failed", error=str(error), cost_usd=self._kit.store.lesson_cost(self._record.id),
            timings=self._stopwatch.marks, repairs=self._repairs,
        )
        self._kit.store.save_lesson(record)
        self._live.publish("error", {"message": str(error)})


def _recover_say(step: dict[str, Any], written: dict[str, Any] | Malformed) -> str:
    if isinstance(step.get("say"), str):
        say = step["say"]
    elif isinstance(written, dict) and isinstance(written.get("say"), str):
        say = written["say"]
    else:
        found = SAY_FIELD.search(written.text) if isinstance(written, Malformed) else None
        say = json.loads(found.group(1)) if found else ""
    cleaned = PLACEHOLDER.sub("", say).strip()
    if not cleaned:
        raise LessonError("a Step could not be repaired and its narration could not be recovered")
    return cleaned
