from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field, replace
from typing import Any

from ..courses import CourseContext
from ..gateway import GatewayError
from ..lessons import done_event
from ..pictures import prefetch
from ..store import LessonRecord, LessonSource, Profile, ProfileKind, Store
from ..tts import Speaker, TtsError, Voice
from .catalog import Catalog
from .classify import Classifier, Plan, Viewing
from .coaching import coached
from .directives import DirectiveError, DirectiveTools, as_promise, computed_facts, directive_briefs, expand_directives, fill_values, contrast_run_keys, run_outline, staged_directives, with_sources
from .lesson_format import Header, Malformed
from .live import LiveLesson
from .mending import mended, mended_by_verdict, mended_cues, with_one_figure_on_stage
from .stage import Stage, question_without_challenge, ran_something, trace_totals
from .stage_words import ArrayPlay, PlotView, array_plays, plot_views
from .stopwatch import Stopwatch
from .validator import PlayerCrash, Validator, Verdict
from .writer import Brief, Writer

LOG = logging.getLogger("pennydrop.asks")
MAX_MENDS = 3
MAX_REPAIR_TRIES = 2
HONOR_CODE_ERROR = "the Step touches project code or an assignment spec; explain the concept on a toy example of your own instead"
MISSING_HINGE = 'no Step so far asks the predict Challenge, and only the last Step comes after this one, so this Step is the hinge: add a "challenge" that the earlier Steps let the learner answer, make "say" ask that question in plain words without giving the answer, and keep the scene, because the next Step reveals it; the narration never names the story\'s parts, such as "hinge" or "reveal"'
REVEALED_NEXT = '; the last Step says "{say}", so ask what that Step shows that no earlier Step has played or said, and never what the stage already shows'
NARRATION_ONLY = 'this Step could not keep its challenge, so it ships without one, and its narration still asks the learner to answer or tap; rewrite "say" alone so it tells this beat of the story over the stage as it stands and asks the learner nothing, and keep every other field as it is'
NARRATION_OFF_STAGE = 'say: this Step plays only this on the stage: {played}; the narration tells a move the stage does not play here, so rewrite "say" to tell the moves this Step plays, in their order, and keep every other field as it is'
ANSWER_ON_STAGE = 'challenge: a Challenge waits after its Step plays, and by then the stage shows {shown}, so the learner reads the answer off it instead of predicting; ask what a later Step plays that the stage does not show yet: stop this Step\'s run at an earlier "until", or graph the line that settles the answer in the next Step, so the answer is still to come'
STORY_OFF_LAB = 'the stage still holds only text and shapes after this Step, but the Lesson plans the {labs} Lab, where the story is shown rather than told; bring that Lab on stage in this Step, with its directive when it has one, and show on it what "say" tells'
RUN_ENDS_BEFORE_HINGE = 'this Step plays the run to its end before the Lesson has asked its predict Challenge, and once the run ends the stage shows every result, so nothing is left to predict; give this Step\'s trace an "until" that stops before the turn that settles the answer, so a later Step can ask the Challenge over the unfinished run and the Step after it can play the end'
RUN_ENDS_AFTER_STOP = 'this Step plays the run to its end before the Lesson has asked its predict Challenge, and once the run ends the stage shows every result, so nothing is left to predict; the Step before stopped the run at "until": {until}, so repeat the trace here with "until": {until}, which keeps the stage as it is, make this Step the hinge that asks the predict Challenge over the unfinished run without giving the answer, and leave the end of the run to the next Step\'s trace with no "until"'
OPEN_QUESTION = 'say: the narration ends on a question, but this Step has no Challenge, so the learner gets no turn to answer it; give this Step the predict Challenge that question asks, or end the narration on the statement it is leading to'
PLOT_ENDS_BEFORE_HINGE = 'this Step draws the {plot} plot to its end before the Lesson has asked its predict Challenge, and once every line is drawn the learner reads any answer off the plot; graph the {line} line here only part way, with "to" at an x before the end, so a later Step can ask the Challenge about where it ends and the Step after it can graph the rest and mark the end'
RUN_LEFT_UNFINISHED = 'the run on stage stopped part way, and this is the last Step, so the learner never sees how it ends; carry the trace directive here with no "until", so this Step plays the rest of the run to its end, and let the narration tell what the finished run shows'
ANSWER_TOLD = 'challenge: the narration so far, this Step\'s "say" included, already tells the answer to this Challenge, so the learner remembers it instead of predicting; take the answer out of this Step\'s "say", and when an earlier Step told it, ask about the next thing the run or story does that no Step has said or played yet, and let the next Step show it'
STILL_STAGE = 'this Step plays nothing on the stage and asks nothing, so the learner hears new words over a still picture; add to "do" the operations that show what "say" tells, such as the next part of the run, the next line of a plot or a highlight on what the narration names, and keep the narration'
END_TOLD_EARLY = 'say: the narration gives {value}, where the {line} line ends, but the {plot} plot has not drawn that line to its end yet, so the narration tells the result before the stage shows it; leave that number out of "say" here and tell it in the Step that graphs the {line} line to its end and marks it'
STILL_SIDE_RUN = "; the contrast run is not played yet, so carry its trace in this Step exactly as the brief gives it, and play it here"
STILL_RUN = 'this Step plays nothing on the stage and asks nothing: its "{directive}" repeats the stop of the Step before, so the learner hears new words over a still picture; give "until" the next stop after that one, or leave "until" out to play the rest of the run, write no "do" entries for the run, and keep "say" telling only the part this Step plays'
PLACEHOLDER = re.compile(r"\{[^}]*\}")
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")
QUOTED = re.compile(r'"[^"]*"')
SAY_FIELD = re.compile(r'"say"\s*:\s*("(?:[^"\\]|\\.)*")')


PROMISE_WORDS = 14

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
    followed: asyncio.Future[bool]
    last_after: asyncio.Future[dict[str, Any] | Malformed | None]


@dataclass(frozen=True)
class Checked:
    errors: list[str]
    step: dict[str, Any] | None
    scene: Any
    advice: list[str] = field(default_factory=list)
    values: dict[str, Any] = field(default_factory=dict)


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
        self._claims_disagreed: set[int] = set()
        self._remembered_values: dict[str, Any] = {}
        self._asked_challenge = False
        self._told: list[str] = []
        self._stage = Stage()
        self._refused = False
        self._warm_picture: asyncio.Task[None] | None = None
        self._point_check: asyncio.Task[str] | None = None

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
        photo_search = plan.photo_subject if "picture" in plan.labs else None
        if photo_search:
            self._warm_picture = asyncio.create_task(prefetch(kit.directive_tools.images, photo_search, not self._is_kid, self._record.id))
        self._record = replace(self._record, tier=plan.tier.value)
        start_scene = await kit.validator.replay(self._ask.earlier_steps, self._reading) if plan.follow_up else None
        self._stage = Stage(start_scene, contrast_run_keys(plan.algorithm))
        outline = await run_outline(plan.algorithm, kit.directive_tools.tracer) if plan.algorithm else None
        brief = Brief(self._ask.text, self._ask.profile, plan, start_scene, self._ask.viewing.title if self._ask.viewing else None, self._ask.course, photo_search, outline)
        pending: asyncio.Queue[PendingStep | None] = asyncio.Queue()
        ready: asyncio.Queue[ReadyStep | None] = asyncio.Queue()
        async with asyncio.TaskGroup() as group:
            group.create_task(self._read(brief, plan, start_scene, pending))
            group.create_task(self._settle(brief, start_scene, pending, ready))
            group.create_task(self._publish(ready))
        await self._finish()

    async def _read(self, brief: Brief, plan: Plan, start_scene: Any, pending: asyncio.Queue[PendingStep | None]) -> None:
        number = 0
        written: list[PendingStep] = []
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
            if written:
                written[-1].followed.set_result(True)
            if len(written) > 1:
                written[-2].last_after.set_result(None)
            loop = asyncio.get_running_loop()
            written.append(PendingStep(number, line, self._prevoice(line), loop.create_future(), loop.create_future()))
            await pending.put(written[-1])
        if not written:
            raise LessonError("the writer finished without writing any Step")
        written[-1].followed.set_result(False)
        written[-1].last_after.set_result(None)
        if len(written) > 1:
            written[-2].last_after.set_result(written[-1].written)
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
        if header.point:
            self._point_check = asyncio.create_task(self._check_point(header.point))

    async def _check_point(self, point: str) -> str:
        try:
            if await self._kit.classifier.states_a_claim(point, self._record.id):
                return "passed"
        except GatewayError as error:
            LOG.warning("lesson %s point could not be checked: %s", self._record.id, error)
            return f"unchecked: {error}"
        LOG.warning("lesson %s point reads as a topic, not a claim: %s", self._record.id, point)
        return "missed: the point is a topic, not a claim"

    async def _settle(self, brief: Brief, scene: Any, pending: asyncio.Queue[PendingStep | None], ready: asyncio.Queue[ReadyStep | None]) -> None:
        while (step := await pending.get()) is not None:
            try:
                settled = await self._settle_step(brief, step, scene)
            except PlayerCrash as crash:
                raise LessonError(f"the player's validator crashed on step {step.number}, and no rewrite can fix that: {crash}") from None
            scene = settled.scene
            self._asked_challenge = self._asked_challenge or "challenge" in settled.step
            self._told.append(settled.step["say"])
            self._stage.settle(settled.step)
            self._stopwatch.mark("first_step_checked")
            await ready.put(ReadyStep(settled.step, self._voice(settled.step["say"])))
        await ready.put(None)

    async def _settle_step(self, brief: Brief, pending: PendingStep, scene: Any) -> SettledStep:
        written = self._mended(pending.written, pending.number)
        sent: list[str] = []
        for attempt in range(MAX_REPAIR_TRIES + 1):
            checked = await self._check(written, pending, scene)
            if not checked.errors and not checked.advice:
                return self._accepted(written, checked)
            reasons = checked.errors + checked.advice
            if attempt == MAX_REPAIR_TRIES or _same_failure(reasons, sent):
                break
            sent = reasons
            self._log_repair(pending.number, attempt + 1, reasons, "redone by the writer")
            written = self._mended(await self._kit.writer.repair(brief, scene, written, reasons, self._record.id), pending.number)
        if not checked.errors:
            self._log_repair(pending.number, attempt + 1, checked.advice, "kept as written")
            return self._accepted(written, checked)
        if HONOR_CODE_ERROR in checked.errors:
            raise LessonError(f"Step {pending.number} still broke the honor code after {MAX_REPAIR_TRIES} rewrites")
        return await self._salvage(brief, pending.number, written, checked, scene)

    def _mended(self, written: dict[str, Any] | Malformed, number: int) -> dict[str, Any] | Malformed:
        if isinstance(written, Malformed):
            return written
        step = mended({**written, "step": number}, self._stage)
        return as_promise(with_one_figure_on_stage(step, self._stage) if self._is_kid else step)

    def _accepted(self, written: dict[str, Any] | Malformed, checked: Checked) -> SettledStep:
        self._stage.remember_trace(written, checked.step, checked.values)
        self._stage.remember_simulation(written)
        self._remembered_values.update(checked.values)
        return SettledStep(checked.step, checked.scene)

    async def _check(self, written: dict[str, Any] | Malformed, pending: PendingStep, scene: Any) -> Checked:
        number = pending.number
        if isinstance(written, Malformed):
            return Checked([coached(written.reason)], None, scene)
        step = written
        owned = self._stage.errors_in_written(written)
        if owned:
            return Checked(owned, None, scene)
        try:
            tools = replace(self._kit.directive_tools, lesson_id=self._record.id, young_child=self._is_kid, staged=self._stage.on_stage(), traced=frozenset(self._stage.traces), pictures=dict(self._stage.specs), played=tuple(self._stage.played))
            expanded, values = await expand_directives(step, tools, self._remembered_values)
            step = mended_cues(expanded)
        except DirectiveError as error:
            return Checked([coached(str(error))], None, scene)
        known = {**self._remembered_values, **values}
        facts = computed_facts(known)
        plays = array_plays(scene, step)
        plots = plot_views(scene, step)
        verdict, fine_for_child, keeps_honor_code, restates_point, claims_agree, *further_advice = await asyncio.gather(
            self._kit.validator.check(step, scene, self._reading),
            self._fine_for_child(step),
            self._keeps_honor_code(step),
            self._restates_point(step, number, pending.followed),
            self._claims_agree(step, written, known, facts),
            self._missing_hinge(step, number, pending.last_after),
            self._narration_off_stage(step, plays),
            self._answer_on_stage(step, [play.shown() for play in plays] + [view.shown() for view in plots if view.lines]),
            self._answer_told(step),
            self._story_off_lab(step, number),
            self._ends_before_hinge(step, written, values, plots, pending.followed),
            self._still_stage(step, written, number, pending.followed),
            _end_told_early(step, plots),
            self._run_left_unfinished(written, values, pending.followed),
        )
        for _ in range(MAX_MENDS):
            if (roomier := mended_by_verdict(step, verdict.errors, self._stage)) is None:
                break
            retry = await self._kit.validator.check(roomier, scene, self._reading)
            if retry.errors == verdict.errors:
                break
            step, verdict = roomier, retry
        errors = [coached(error) for error in verdict.errors] + self._stage.errors_in(step, written, values)
        if not keeps_honor_code:
            errors.append(HONOR_CODE_ERROR)
        if not fine_for_child:
            self._redone_for_child.add(number)
            errors.append("say is not fine for a young child; rewrite the narration so it is gentle, true and free of frightening or adult content")
        if not claims_agree:
            self._claims_disagreed.add(number)
            errors.append(_claims_disagree(_claimed(step), facts))
        advice = [] if restates_point or number in self._claims_disagreed else [f'the last Step must say the Lesson\'s point again in plain words, and this narration does not; the point is "{self._record.header["point"]}"; rewrite "say" so it states that point simply as the close of the story, and keep the Step\'s scene and challenge']
        advice.extend(found for found in further_advice if found)
        if number > 1 and "challenge" not in step and isinstance(step.get("say"), str) and step["say"].rstrip().endswith("?"):
            advice.append(OPEN_QUESTION)
        if number == 1 and isinstance(step.get("say"), str) and len(step["say"].split()) > PROMISE_WORDS:
            advice.append(f"the promise must be one question of at most {PROMISE_WORDS} words, and this one has {len(step['say'].split())}; cut it down and keep its concrete example")
        return Checked(errors, step, verdict.scene, advice, values)

    async def _missing_hinge(self, step: dict[str, Any], number: int, last_after: asyncio.Future[dict[str, Any] | Malformed | None]) -> str | None:
        if number == 1 or self._asked_challenge or "challenge" in step:
            return None
        last = await last_after
        if last is None:
            return None
        say = last.get("say") if isinstance(last, dict) else None
        return MISSING_HINGE + (REVEALED_NEXT.format(say=say) if isinstance(say, str) else "")

    async def _story_off_lab(self, step: dict[str, Any], number: int) -> str | None:
        planned = set(self._record.labs)
        if number != 2 or not planned:
            return None
        scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
        kept = {lab for name, lab in self._stage.labs.items() if not (name in scene and not isinstance(scene[name], dict))}
        brought = {spec["lab"] for spec in scene.values() if isinstance(spec, dict) and isinstance(spec.get("lab"), str)}
        if kept | brought:
            return None
        return " ".join([STORY_OFF_LAB.format(labs=" or ".join(sorted(planned))), *directive_briefs(tuple(sorted(planned)))])

    async def _ends_before_hinge(self, step: dict[str, Any], written: dict[str, Any] | Malformed, values: dict[str, Any], plots: list[PlotView], followed: asyncio.Future[bool]) -> str | None:
        if self._asked_challenge or "challenge" in step:
            return None
        if trace_totals(values) and not self._stage.is_side_run(written):
            until = self._stage.until_shown_by(written)
            advice = RUN_ENDS_AFTER_STOP.format(until=until) if isinstance(until, int) and until > 0 else RUN_ENDS_BEFORE_HINGE
        elif finished := next((view for view in plots if view.graphed and not view.unfinished), None):
            advice = PLOT_ENDS_BEFORE_HINGE.format(plot=finished.name, line=finished.graphed[-1])
        else:
            return None
        return advice if await followed else None

    async def _run_left_unfinished(self, written: dict[str, Any] | Malformed, values: dict[str, Any], followed: asyncio.Future[bool]) -> str | None:
        if not self._stage.run_left_unfinished(written, values):
            return None
        return None if await followed else RUN_LEFT_UNFINISHED

    async def _still_stage(self, step: dict[str, Any], written: dict[str, Any], number: int, followed: asyncio.Future[bool]) -> str | None:
        if number == 1 or step.get("do") or step.get("scene") or "challenge" in step:
            return None
        if not await followed:
            return None
        staged = next(iter(staged_directives(written)), None)
        if staged:
            return STILL_RUN.format(directive=staged)
        return STILL_STAGE + STILL_SIDE_RUN if self._stage.side_run_unplayed() else STILL_STAGE

    async def _narration_off_stage(self, step: dict[str, Any], plays: list[ArrayPlay]) -> str | None:
        played = "; and ".join(play.told() for play in plays if play.moves)
        if not played or not isinstance(step.get("say"), str):
            return None
        try:
            off = await self._kit.classifier.tells_other_moves(played, step["say"], self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s Step could not be checked against its stage: %s", self._record.id, error)
            return None
        return NARRATION_OFF_STAGE.format(played=played) if off else None

    async def _answer_on_stage(self, step: dict[str, Any], views: list[str]) -> str | None:
        asked = _predicted(step)
        if not views or asked is None:
            return None
        shown = "; and ".join(views)
        try:
            readable = await self._kit.classifier.answer_on_stage(shown, asked, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s Challenge could not be checked against its stage: %s", self._record.id, error)
            return None
        return ANSWER_ON_STAGE.format(shown=shown) if readable else None

    async def _answer_told(self, step: dict[str, Any]) -> str | None:
        asked = _predicted(step)
        if asked is None:
            return None
        try:
            told = await self._kit.classifier.answer_told(" ".join([*self._told, str(step.get("say", ""))]), asked, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s Challenge could not be checked against the narration: %s", self._record.id, error)
            return None
        return ANSWER_TOLD if told else None

    async def _restates_point(self, step: dict[str, Any], number: int, followed: asyncio.Future[bool]) -> bool:
        point = self._record.header.get("point")
        if number == 1 or not point or not isinstance(step.get("say"), str) or await followed:
            return True
        try:
            return await self._kit.classifier.restates_point(step["say"], point, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s last Step could not be checked against the point: %s", self._record.id, error)
            return True

    async def _claims_agree(self, step: dict[str, Any], written: dict[str, Any], known: dict[str, Any], facts: list[str]) -> bool:
        if not isinstance(step.get("say"), str) or not facts:
            return True
        say = with_sources(written["say"], step["say"], known) if isinstance(written.get("say"), str) else step["say"]
        try:
            return await self._kit.classifier.claims_agree(_claimed({**step, "say": say}), facts, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s Step could not be checked against its computed facts: %s", self._record.id, error)
            return True

    async def _fine_for_child(self, step: dict[str, Any]) -> bool:
        if not self._is_kid or not isinstance(step.get("say"), str):
            return True
        return await self._kit.classifier.fine_for_young_child(step["say"], self._record.id)

    async def _keeps_honor_code(self, step: dict[str, Any]) -> bool:
        if not self._ask.course:
            return True
        shown = json.dumps({field: step[field] for field in ("say", "scene", "challenge") if field in step})
        return await self._kit.classifier.keeps_honor_code(shown, self._ask.course.honor_code, self._record.id)

    async def _salvage(self, brief: Brief, number: int, written: dict[str, Any] | Malformed, last: Checked, scene: Any) -> SettledStep:
        step = last.step or {}
        self._remembered_values.update(last.values)
        say = _recover_say(step, written, self._remembered_values)
        validator = self._kit.validator
        self._stage.lost_runs = self._stage.lost_runs or ran_something(written)
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
        if question_without_challenge(candidate):
            candidate, verdict = await self._told_not_asked(brief, candidate, verdict, scene)
        kept_ops: list[dict[str, Any]] = []
        for operation in step.get("do", []) if "scene" in candidate else []:
            trial = await validator.check({**candidate, "do": [*kept_ops, operation]}, scene, self._reading)
            if trial.ok:
                kept_ops.append(operation)
                verdict = trial
        outcome = f"kept the narration, dropped fields {sorted(set(step) - set(candidate))} and {len(step.get('do', [])) - len(kept_ops)} operations"
        self._log_repair(number, MAX_REPAIR_TRIES + 1, last.errors, outcome)
        return SettledStep({**candidate, **({"do": kept_ops} if kept_ops else {})}, verdict.scene)

    async def _told_not_asked(self, brief: Brief, candidate: dict[str, Any], verdict: Verdict, scene: Any) -> tuple[dict[str, Any], Verdict]:
        rewritten = await self._kit.writer.repair(brief, scene, candidate, [NARRATION_ONLY], self._record.id)
        say = rewritten.get("say") if isinstance(rewritten, dict) else None
        told = {**candidate, "say": say}
        if not isinstance(say, str) or not say.strip() or PLACEHOLDER.search(say) or question_without_challenge(told):
            return candidate, verdict
        retold = await self._kit.validator.check(told, scene, self._reading, replay="scene" not in told)
        return (told, retold) if retold.ok else (candidate, verdict)

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

    async def _finish(self) -> None:
        marks = self._stopwatch.marks
        drawn = [lab for lab in self._stage.drawn_labs if lab in self._catalog_labs]
        point_check = await self._point_check if self._point_check else "not needed: a refusal has no point" if self._refused else "missed: the writer sent no point"
        record = replace(
            self._record, labs=drawn, header={**(self._record.header or {}), "labs": drawn, "point_check": point_check}, status="ready", first_step_seconds=marks["first_step_published"], done_seconds=self._stopwatch.elapsed(),
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


def _claimed(step: dict[str, Any]) -> str:
    challenge = step.get("challenge")
    if not isinstance(challenge, dict) or not challenge.get("choices") or not isinstance(challenge.get("answer"), str):
        return step["say"]
    return f'{step["say"]} The Challenge asks "{challenge.get("prompt")}", and its answer is "{challenge["answer"]}".'


def _same_failure(reasons: list[str], sent: list[str]) -> bool:
    return bool(sent) and [QUOTED.sub('""', reason) for reason in reasons] == [QUOTED.sub('""', reason) for reason in sent]


def _claims_disagree(claimed: str, facts: list[str]) -> str:
    listed = "; ".join(facts)
    return (
        f'say: the Step reads "{claimed}", and a claim in it disagrees with what running the Lesson\'s examples computed: {listed}.'
        " The computed values are right, so rewrite the claim, in \"say\" or in the Challenge\'s \"answer\", so every number and comparison in it matches them, such as which run is lower or which job finishes sooner;"
        " when the facts hold several runs, name the run each value comes from, such as \"with the lock\" or \"in the round robin run\", and leave out any claim they do not bear out"
    )


def _recover_say(step: dict[str, Any], written: dict[str, Any] | Malformed, values: dict[str, Any]) -> str:
    if isinstance(step.get("say"), str):
        say = step["say"]
    elif isinstance(written, dict) and isinstance(written.get("say"), str):
        say = written["say"]
    else:
        found = SAY_FIELD.search(written.text) if isinstance(written, Malformed) else None
        say = json.loads(found.group(1)) if found else ""
    filled = fill_values({"say": say}, values)["say"]
    cleaned = " ".join(sentence for sentence in SENTENCE_BREAK.split(filled.strip()) if not PLACEHOLDER.search(sentence))
    if not cleaned:
        raise LessonError("a Step could not be repaired and its narration could not be recovered")
    return cleaned


async def _end_told_early(step: dict[str, Any], plots: list[PlotView]) -> str | None:
    say = step.get("say")
    if not isinstance(say, str):
        return None
    for view in plots:
        if early := view.end_told_early(say):
            line, end = early
            return END_TOLD_EARLY.format(value=_said_number(end), line=line, plot=view.name)
    return None


def _said_number(value: float) -> str:
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def _predicted(step: dict[str, Any]) -> str | None:
    challenge = step.get("challenge")
    if not isinstance(challenge, dict) or challenge.get("kind") != "predict" or "answer" not in challenge:
        return None
    choices = f' Choices: {", ".join(map(str, challenge["choices"]))}.' if isinstance(challenge.get("choices"), list) else ""
    return f'{challenge.get("prompt")}{choices} Answer: {challenge["answer"]}'
