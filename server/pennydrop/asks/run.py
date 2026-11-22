from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, replace
from typing import Any

from ..courses import CourseContext
from ..lessons import done_event
from ..pictures import prefetch, subject_of
from ..store import LessonRecord, LessonSource, Profile, ProfileKind, Store
from ..tts import Speaker, TtsError, Voice
from .catalog import Catalog
from .classify import Classifier, Plan, Viewing
from .coaching import coached
from .directives import DirectiveError, DirectiveTools, expand_directives
from .lesson_format import Header, Malformed
from .live import LiveLesson
from .mending import mended, mended_by_verdict, mended_cues
from .stage import Stage
from .stopwatch import Stopwatch
from .validator import PlayerCrash, Validator
from .writer import Brief, Writer

LOG = logging.getLogger("pennydrop.asks")
MAX_MENDS = 3
MAX_REPAIR_TRIES = 2
HONOR_CODE_ERROR = "the Step touches project code or an assignment spec; explain the concept on a toy example of your own instead"
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
    course: CourseContext | None = None


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
        self._first_voice: asyncio.Task[Voice | None] | None = None
        self._repairs: list[dict[str, Any]] = []
        self._catalog_labs: set[str] = set()
        self._published = 0
        self._redone_for_child: set[int] = set()
        self._remembered_values: dict[str, Any] = {}
        self._stage = Stage()
        self._refused = False
        self._warm_picture: asyncio.Task[None] | None = None

    @property
    def _reading(self) -> bool:
        return not self._is_kid

    @property
    def _is_kid(self) -> bool:
        return self._ask.profile is not None and self._ask.profile.kind is ProfileKind.KID

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
        self._refused = not plan.fine_for_young_child
        self._request_missing_lab(plan)
        photo_search = subject_of(self._ask.text) if "picture" in plan.labs else None
        if photo_search:
            self._warm_picture = asyncio.create_task(prefetch(kit.directive_tools.images, photo_search, not self._is_kid, self._record.id))
        self._record = replace(self._record, tier=plan.tier.value)
        start_scene = await kit.validator.replay(self._ask.earlier_steps, self._reading) if plan.follow_up else None
        self._stage = Stage(start_scene)
        brief = Brief(self._ask.text, self._ask.profile, plan, start_scene, self._ask.viewing.title if self._ask.viewing else None, self._ask.course, photo_search)
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

    def _request_missing_lab(self, plan: Plan) -> None:
        if plan.labs or plan.follow_up or not plan.fine_for_young_child or self._record.source in (LessonSource.BENCH, LessonSource.COURSE):
            return
        store = self._kit.store
        if not any(request.ask == self._ask.text for request in store.lab_requests("open")):
            store.file_lab_request(self._ask.text)

    def _open(self, header: Header, start_scene: Any) -> None:
        header = header.model_copy(update={"labs": [lab for lab in header.labs if lab in self._catalog_labs], "start_scene": start_scene, "reading": self._reading})
        data = header.model_dump(exclude_none=True)
        self._record = replace(self._record, title=header.title, labs=header.labs, header=data)
        self._kit.store.save_lesson(self._record)
        self._live.publish("lesson", {"id": self._record.id, "lesson": data})

    async def _settle(self, brief: Brief, scene: Any, pending: asyncio.Queue[PendingStep | None], ready: asyncio.Queue[ReadyStep | None]) -> None:
        while (step := await pending.get()) is not None:
            try:
                settled = await self._settle_step(brief, step, scene)
            except PlayerCrash as crash:
                raise LessonError(f"the player's validator crashed on step {step.number}, and no rewrite can fix that: {crash}") from None
            scene = settled.scene
            self._stage.settle(settled.step)
            self._stopwatch.mark("first_step_checked")
            await ready.put(ReadyStep(settled.step, self._voice(settled.step["say"])))
        await ready.put(None)

    async def _settle_step(self, brief: Brief, pending: PendingStep, scene: Any) -> SettledStep:
        written = pending.written
        for attempt in range(MAX_REPAIR_TRIES + 1):
            checked = await self._check(written, pending.number, scene)
            if not checked.errors:
                self._stage.remember_trace(written, checked.step)
                return SettledStep(checked.step, checked.scene)
            if attempt == MAX_REPAIR_TRIES:
                break
            self._log_repair(pending.number, attempt + 1, checked.errors, "redone by the writer")
            written = await self._kit.writer.repair(brief, scene, written, checked.errors, self._record.id)
        if HONOR_CODE_ERROR in checked.errors:
            raise LessonError(f"Step {pending.number} still broke the honor code after {MAX_REPAIR_TRIES} rewrites")
        return await self._salvage(pending.number, written, checked, scene)

    async def _check(self, written: dict[str, Any] | Malformed, number: int, scene: Any) -> Checked:
        if isinstance(written, Malformed):
            return Checked([coached(written.reason)], None, scene)
        step = mended({**written, "step": number}, self._stage)
        owned = self._stage.errors_in_written(written)
        if owned:
            return Checked(owned, None, scene)
        try:
            tools = replace(self._kit.directive_tools, lesson_id=self._record.id, young_child=self._is_kid, staged=self._stage.on_stage(), traced=frozenset(self._stage.traces), pictures=dict(self._stage.specs))
            expanded = mended_cues(await expand_directives(step, tools, self._remembered_values))
            step = expanded
        except DirectiveError as error:
            return Checked([coached(str(error))], None, scene)
        verdict, fine_for_child, keeps_honor_code = await asyncio.gather(
            self._kit.validator.check(step, scene, self._reading), self._fine_for_child(step), self._keeps_honor_code(step)
        )
        for _ in range(MAX_MENDS):
            if (roomier := mended_by_verdict(step, verdict.errors, self._stage)) is None:
                break
            retry = await self._kit.validator.check(roomier, scene, self._reading)
            if retry.errors == verdict.errors:
                break
            step, verdict = roomier, retry
        errors = [coached(error) for error in verdict.errors] + self._stage.errors_in(step, ran=_ran_something(written))
        if not keeps_honor_code:
            errors.append(HONOR_CODE_ERROR)
        if not fine_for_child:
            self._redone_for_child.add(number)
            errors.append("say is not fine for a young child; rewrite the narration so it is gentle, true and free of frightening or adult content")
        return Checked(errors, step, verdict.scene)

    async def _fine_for_child(self, step: dict[str, Any]) -> bool:
        if not self._is_kid or not isinstance(step.get("say"), str):
            return True
        return await self._kit.classifier.fine_for_young_child(step["say"], self._record.id)

    async def _keeps_honor_code(self, step: dict[str, Any]) -> bool:
        if not self._ask.course:
            return True
        shown = json.dumps({field: step[field] for field in ("say", "scene", "challenge") if field in step})
        return await self._kit.classifier.keeps_honor_code(shown, self._ask.course.honor_code, self._record.id)

    async def _salvage(self, number: int, written: dict[str, Any] | Malformed, last: Checked, scene: Any) -> SettledStep:
        step = last.step or {}
        say = _recover_say(step, written)
        validator = self._kit.validator
        self._stage.lost_runs = self._stage.lost_runs or _ran_something(written)
        answerable = not self._stage.unran_values(step, False)
        for kept_fields in (("scene", "challenge"), ("challenge",), ("scene",), ()):
            if "challenge" in kept_fields and not answerable:
                continue
            candidate = {"step": number, "say": say, **{field: step[field] for field in kept_fields if field in step}}
            verdict = await validator.check(candidate, scene, self._reading, replay=not kept_fields)
            if verdict.ok:
                break
        else:
            raise LessonError(f"Step {number} could not be repaired, and even its narration alone failed: {'; '.join(verdict.errors)}")
        kept_ops: list[dict[str, Any]] = []
        for operation in step.get("do", []) if "scene" in candidate else []:
            trial = await validator.check({**candidate, "do": [*kept_ops, operation]}, scene, self._reading)
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
            task = asyncio.create_task(self._speak(text, after=self._first_voice))
            self._first_voice = self._first_voice or task
            task.add_done_callback(lambda finished: finished.cancelled() or finished.exception())
            self._voices[text] = task
        return self._voices[text]

    async def _speak(self, text: str, after: asyncio.Task[Voice | None] | None) -> Voice | None:
        if after:
            await asyncio.wait([after])
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
        drawn = [lab for lab in self._record.labs if lab in self._stage.drawn_labs]
        record = replace(
            self._record, labs=drawn, header={**(self._record.header or {}), "labs": drawn}, status="ready", first_step_seconds=marks["first_step_published"], done_seconds=self._stopwatch.elapsed(),
            cost_usd=self._kit.store.lesson_cost(self._record.id), timings=marks, repairs=self._repairs,
        )
        self._kit.store.save_lesson(record)
        self._record_content_check()
        self._live.publish("done", done_event(record, self._published))

    def _record_content_check(self) -> None:
        if not self._is_kid:
            return
        if self._refused:
            outcome = "refused: ask a grown up"
        elif self._redone_for_child:
            outcome = "redone: step " + ", ".join(str(number) for number in sorted(self._redone_for_child))
        else:
            outcome = "passed"
        self._kit.store.record_content_check(self._record.id, outcome)

    def _fail(self, error: BaseException) -> None:
        LOG.error("lesson %s failed: %s", self._record.id, error, exc_info=error)
        record = replace(
            self._record, status="failed", error=str(error), cost_usd=self._kit.store.lesson_cost(self._record.id),
            timings=self._stopwatch.marks, repairs=self._repairs,
        )
        self._kit.store.save_lesson(record)
        self._live.publish("error", {"message": str(error)})


def _ran_something(written: dict[str, Any] | Malformed) -> bool:
    return isinstance(written, dict) and any(key in written for key in ("trace", "simulate"))


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
