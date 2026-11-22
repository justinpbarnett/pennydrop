from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

import httpx

from ..courses import CourseContext
from ..gateway import GatewayError
from ..lessons import done_event
from ..pictures import Picture, PictureNotFound
from ..practice import Rule
from ..store import LessonRecord, LessonSource, Profile, ProfileKind, Store
from ..tts import Speaker, TtsError, Voice
from .catalog import Catalog
from .challenge_words import answer_told, asks_another_question, predicted
from .classify import Classifier, Plan, Viewing
from .coaching import coached
from .directives import DirectiveError, DirectiveTools, as_promise, carries_directive, computed_facts, directive_briefs, expand_directives, fill_values, kid_outline, run_outline, staged_directives, with_sources
from .directives._support import Runs, operation_targets
from .directives.curves import graphed_half_way
from .lesson_format import Header, Malformed, ParsedLine, is_practice_line
from .live import LiveLesson
from .mending import PROMISE_WORDS, brings_in_a_figure, mended, mended_cues, retold, validated_and_mended, with_one_figure_on_stage
from .stage import Redeclared, Stage, question_without_challenge, ran_something, trace_totals
from .stage_words import ArrayPlay, EventPlay, FigurePlay, PlotView, StagePlay, array_plays, card_matches, event_plays, plot_views, shapes_plays, shown_pictures, stress_marks
from .stopwatch import Stopwatch
from .validator import PlayerCrash, Validator, Verdict

if TYPE_CHECKING:
    from ..practice.author import PracticeAuthor
from .writer import Brief, MainPhoto, Writer

LOG = logging.getLogger("pennydrop.asks")
MAIN_PHOTO_WAIT = 45.0
MAX_REPAIR_TRIES = 2
HONOR_CODE_ERROR = "the Step touches project code or an assignment spec; explain the concept on a toy example of your own instead"
MISSING_HINGE = 'no Step so far asks the predict Challenge, and only the last Step comes after this one, so this Step is the hinge: add a "challenge" that the earlier Steps let the learner answer, make "say" ask that question in plain words without giving the answer, and keep the scene, because the next Step reveals it; the narration never names the story\'s parts, such as "hinge" or "reveal"'
REVEALED_NEXT = '; the last Step says "{say}", so ask what that Step shows that no earlier Step has played or said, and never what the stage already shows'
NARRATION_ONLY = 'this Step could not keep its challenge, so it ships without one, and its narration still asks the learner to answer or tap; rewrite "say" alone so it tells this beat of the story over the stage as it stands and asks the learner nothing, and keep every other field as it is'
TRUE_NARRATION = 'say: this Step could not be repaired, so it ships with the narration you write now, and every sentence of its narration disagrees with what running the Lesson\'s examples computed: {facts}; rewrite "say" alone so it tells this beat of the story with only claims these values bear out, naming the run each value comes from, and keep every other field as it is'
NARRATION_OFF_STAGE = 'say: this Step plays only this on the stage: {played}; the narration tells a move the stage does not play here, so rewrite "say" to tell the moves this Step plays, in their order, and keep every other field as it is'
CLOSED_WITHOUT_PICTURE = 'this is the last Step, and it takes {pictures} off the stage, so the point is said without the picture the Lesson is about; keep {pictures} on stage, shown whole, and set anything new beside it, and keep the narration'
CLOSED_ZOOMED_IN = 'this is the last Step, and it says the point while {pictures} stays zoomed in on one part, so the learner never sees the whole picture again; add an "unzoom" op on {pictures} at the start of "do", cued on the first words of "say", and keep every other field as it is'
REVEAL_OFF_ANSWER = 'say: the Challenge just before asked "{asked}", and its answer is "{answer}"; this Step is its reveal, so start "say" by naming "{answer}" as the answer and show why, and keep every other field as it is'
CARD_OFF_STAGE = 'say: the narration points at the meaning card "{named}", while this Step\'s match runs the arrow to the card "{marked}" ("meaning": {index}); make "meaning" the index of the card the narration means, or rewrite "say" to tell the card the arrow reaches, and keep every other field as it is'
CARD_MARK_DENIED = 'say: this Step\'s match puts {mark} on the meaning card "{marked}", because the scene\'s "answer" is the card "{answer}", while the narration tells "{marked}" as {told}; rewrite "say" so it agrees with the {mark}, or drop this match op, and keep every other field as it is'
ANSWER_ON_STAGE = 'challenge: a Challenge waits after its Step plays, and by then the stage shows {shown}, so the learner reads the answer off it instead of predicting; ask what a later Step plays that the stage does not show yet: stop this Step\'s run at an earlier "until", or graph the line that settles the answer in the next Step, so the answer is still to come'
STORY_OFF_LAB = 'the stage holds no Lab figure after this Step, only primitives such as text, shapes or hand-drawn axes, but the Lesson plans the {labs} Lab, where the story is shown rather than told; bring that Lab on stage in this Step, with its directive when it has one, and show on it what "say" tells'
RUN_ENDS_BEFORE_HINGE = 'this Step plays the run to its end before the Lesson has asked its predict Challenge, and once the run ends the stage shows every result, so nothing is left to predict; give this Step\'s trace an "until" that stops before the turn that settles the answer, so a later Step can ask the Challenge over the unfinished run and the Step after it can play the end'
RUN_ENDS_AFTER_STOP = 'this Step plays the run to its end before the Lesson has asked its predict Challenge, and once the run ends the stage shows every result, so nothing is left to predict; the Step before stopped the run at "until": {until}, so repeat the trace here with "until": {until}, which keeps the stage as it is, make this Step the hinge that asks the predict Challenge over the unfinished run without giving the answer, and leave the end of the run to the next Step\'s trace with no "until"'
LOADED_BEFORE_HINGE = 'this Step has the OS load the missing page before the Lesson has asked its predict Challenge, and once the page is loaded the stage shows what the OS does, so nothing is left to predict; stop this Step\'s simulation at "k fault", where the walk finds the invalid entry, make this Step the hinge that asks what happens next without giving the answer, and leave "k load" to the next Step'
OPEN_QUESTION = 'say: the narration ends on a question, but this Step has no Challenge, so the learner gets no turn to answer it; give this Step the predict Challenge that question asks, or end the narration on the statement it is leading to'
PLOT_ENDS_BEFORE_HINGE = 'this Step draws the {plot} plot to its end before the Lesson has asked its predict Challenge, and once every line is drawn the learner reads any answer off the plot; graph the {line} line here only part way, with "to" at an x before the end, so a later Step can ask the Challenge about where it ends and the Step after it can graph the rest and mark the end'
MATCHED_BEFORE_HINGE = 'this Step matches the word to its meaning "{meaning}" before the Lesson has asked its predict Challenge, and once the check mark shows, the learner has seen the answer, so nothing is left to work out; here match only a wrong meaning, or none, ask for the meaning in a later Step\'s Challenge, and play the right match in the Step after it as the reveal'
SIDE_RUN_TOO_SOON = 'this Step starts the contrast run while the main run is stopped at "until": {until}, but the story plays the main run, the normal case, to its end before the contrast run breaks it, so the learner never sees the main run finish; play the main run on in this Step instead, with its trace at the next stop the brief gives after {until}, or with no "until" when no stop is left, narrate the turns it plays, and start the contrast run only in a Step after the main run ends'
MAIN_RUN_TOO_SOON = 'this Step plays the main run while the contrast run is stopped at "until": {until}, but the story plays the contrast run, the normal case, to its end before the main run answers it, so the learner never sees the contrast run finish and its whole order or total is never shown; play the contrast run on in this Step instead, with its trace at the next stop the brief gives after {until}, or with no "until" when no stop is left, narrate the turns it plays, and play the main run only in a Step after the contrast run ends'
PLANNED_HINGE = '; the story asks its hinge right after "until": {until} of the run on "{on}", so carry that run\'s trace in this Step with "until": {until}, which leaves the rest of the run to the last Step, and ask {question}'
OFF_THE_HINGE = 'this Step\'s predict Challenge is not the one the story asks at its hinge, which comes right after "until": {until} of the run on "{on}"; take the Challenge out of this Step, and ask it in the Step that plays that run to "until": {until}, which is {question}'
RUN_LEFT_UNFINISHED = 'the {run} stopped part way at "until": {until}, and this is the last Step, so the learner never sees how it ends; carry that run\'s trace directive here with no "until", so this Step plays the rest of the run to its end, and let the narration tell what the finished run shows'
STILL_OPENING = "this Step plays nothing on the stage and asks nothing"
EMPHASIS_OPENING = "this Step only outlines or pulses whole objects on a stage it leaves unchanged, which singles out nothing"
EMPHASIS_OPERATIONS = ("highlight", "pulse")
STILL_STAGE = ', so the learner hears new words over a still picture; add to "do" the operations that show what "say" tells, such as the next part of the run, the next line of a plot or a highlight on the one part the narration names, such as arr[2], and keep the narration'
CHALLENGE_READ_OFF = 'challenge: it asks about {x} {at}, but the {plot} plot already draws every line through {x} {at}, so the learner reads the answer off the plot instead of predicting it; ask about where the lines end, at {x} {end}, while one line is still drawn only part way, and let the next Step graph the rest and mark the end'
END_TOLD_EARLY = 'say: the narration gives {value}, where the {line} line ends, but the {plot} plot has not drawn that line to its end yet, so the narration tells the result before the stage shows it; leave that number out of "say" here and tell it in the Step that graphs the {line} line to its end and marks it'
STILL_SIDE_RUN = "; the contrast run is not played yet, so carry its trace in this Step exactly as the brief gives it, and play it here"
STILL_STOPPED_RUN = '; the story plays the {run} next, and it is stopped at "until": {until}, so carry its trace in this Step with the next stop the brief gives after {until}, or with no "until" when no stop is left, and narrate the turns it plays'
ASKED_AT_THE_CLOSE = 'challenge: this is the last Step, which closes the story on the point, and a Challenge here comes after the reveal, with nothing left to show its answer; leave "challenge" out of this Step and make "say" state the point'
STILL_RUN = ': its "{directive}" repeats the stop of the Step before, so the learner hears new words over a still picture; give "until" the next stop after that one, or leave "until" out to play the rest of the run, write no "do" entries for the run, and keep "say" telling only the part this Step plays'
STILL_SIMULATION = ', so the learner hears new words over a still picture; the run on stage plays only through its "simulate" directive, never through "do", so carry the simulation of the Step before, {simulation}, with the next stop after its "until", or with no "until" to play the rest of the run, and keep "say" telling only the part this Step plays'
PLACEHOLDER = re.compile(r"\{[^}]*\}")
ANSWERS_CUT_QUESTION = 'say: the Step before could not keep its Challenge, so the learner was never asked "{asked}", yet this narration announces its answer as if they had been; tell this beat as a plain statement over the stage, with no words that answer a question, and keep every other field as it is'
STRESS_OFF_STAGE = 'say: the narration singles out a different syllable from the one this Step\'s stress marks, "{marked}" ("syllable": {index}) of "{word}", the word on stage; make "syllable" the index of the syllable the narration means, or rewrite "say" to name the syllable the stage marks, and when the narration means a syllable of another word, put that word on stage first; keep every other field as it is'
DECLARED_AGAIN = 'scene: {name} is declared again in the state it had before {moves} were played on it, so it would show a state the story has moved past and the narration would contradict the stage; keep {name} on stage and continue it with "do", or give a spec that shows its state now, such as the change those operations made, because a spec sets the object to exactly what it describes'
RECALLS_LEFT_OUT = 'say: the narration recalls something as already met that only a Step the Lesson left out told, so the learner never heard it; the left-out narration was {left_out}; rewrite "say" so it recalls only what earlier Steps told, or tells that fact afresh, and keep every other field as it is'
CHALLENGE_FLAW = re.compile(r"^(step \d+ )?challenge:")
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")
QUOTED = re.compile(r'"[^"]*"')
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
    practice: PracticeAuthor


@dataclass(frozen=True)
class Ask:
    text: str
    profile: Profile | None
    viewing: Viewing | None
    earlier_steps: list[dict[str, Any]]
    course: CourseContext | None = None
    link: tuple[Rule, Rule] | None = None


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
    disputed: list[str] = field(default_factory=list)
    still: bool = False
    plot_ended: tuple[str, str] | None = None


@dataclass(frozen=True)
class Spoiler:
    advice: str
    plot_ended: tuple[str, str] | None = None


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
        self._planned_labs: set[str] = set()
        self._op_docs: dict[str, dict[str, str]] = {}
        self._published = 0
        self._shown_steps = 0
        self._redone_for_child: set[int] = set()
        self._claims_disagreed: set[int] = set()
        self._remembered_values: dict[str, Any] = {}
        self._asked_challenge = False
        self._cut_question: tuple[int, str] | None = None
        self._told: list[str] = []
        self._left_out: list[str] = []
        self._stage = Stage()
        self._told_point: str | None = None
        self._refused = False
        self._point_check: asyncio.Task[str] | None = None
        self._practice_line: ParsedLine | None = None
        self._last_scene: Any = None
        self._lesson_steps: list[dict[str, Any]] = []
        self._case_keys: set[str] = set()

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
        self._op_docs = {lab.id: lab.ops for lab in snapshot.labs}
        plan = await kit.classifier.plan(self._ask.text, self._ask.profile, snapshot.labs, self._ask.viewing, self._record.id)
        self._stopwatch.mark("classified")
        self._refused = not plan.fine_for_young_child
        self._planned_labs = set(plan.labs)
        self._request_missing_lab(plan)
        photo_search = plan.photo_subject if "picture" in plan.labs else None
        photo = asyncio.ensure_future(kit.directive_tools.images.find(photo_search, not self._is_kid, self._record.id)) if photo_search else None
        start_scene = (await kit.validator.replay(self._ask.earlier_steps, self._reading)).scene if plan.follow_up else None
        outline = (await kid_outline(plan.algorithm, kit.directive_tools.tracer) if self._is_kid else await run_outline(plan.algorithm, kit.directive_tools.tracer, plan.shows_code)) if plan.algorithm else None
        self._last_scene = start_scene
        self._stage = Stage(start_scene, outline.runs if outline else Runs(), kid=self._is_kid, charts_quantities=plan.charts_quantities)
        self._told_point = outline.point if outline else None
        main_photo = await self._main_photo(photo_search, photo) if photo_search and photo else None
        brief = Brief(self._ask.text, self._ask.profile, plan, start_scene, self._ask.viewing.title if self._ask.viewing else None, self._ask.course, main_photo, outline.brief if outline else None, self._ask.link)
        pending: asyncio.Queue[PendingStep | None] = asyncio.Queue()
        ready: asyncio.Queue[ReadyStep | None] = asyncio.Queue()
        async with asyncio.TaskGroup() as group:
            group.create_task(self._read(brief, plan, start_scene, pending))
            group.create_task(self._settle(brief, start_scene, pending, ready))
            group.create_task(self._publish(ready))
        await self._finish(await self._practice(brief))

    async def _main_photo(self, query: str, search: asyncio.Future[Picture]) -> MainPhoto:
        search.add_done_callback(lambda done: done.cancelled() or done.exception())
        try:
            return MainPhoto(query, found=await asyncio.wait_for(asyncio.shield(search), MAIN_PHOTO_WAIT))
        except PictureNotFound:
            return MainPhoto(query, missing=True)
        except (TimeoutError, GatewayError, httpx.HTTPError) as error:
            LOG.warning("lesson %s writes before its photo of %r is found: %r", self._record.id, query, error)
            return MainPhoto(query)

    async def _read(self, brief: Brief, plan: Plan, start_scene: Any, pending: asyncio.Queue[PendingStep | None]) -> None:
        number = 0
        written: list[PendingStep] = []
        async for line in self._kit.writer.lines(brief, self._stopwatch, self._record.id):
            if isinstance(line, Header):
                if self._record.header:
                    raise LessonError("the writer sent a second lesson header")
                self._open(line, start_scene if plan.follow_up else None)
                continue
            if is_practice_line(line):
                self._practice_line = line
                continue
            if not self._record.header:
                why = f" ({line.reason}: {line.text[:300]})" if isinstance(line, Malformed) else f", it was {json.dumps(line)[:300]}"
                raise LessonError(f"the writer's first line was not a lesson header{why}, so the Lesson cannot start")
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
        header = header.model_copy(update={"labs": [lab for lab in header.labs if lab in self._catalog_labs], "start_scene": start_scene, "reading": self._reading, "point": self._told_point or header.point})
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
            if settled is None:
                continue
            if self._cut_question is not None and self._cut_question[0] < step.number:
                self._cut_question = None
            scene = settled.scene
            self._last_scene = scene
            self._asked_challenge = self._asked_challenge or "challenge" in settled.step
            self._told.append(settled.step["say"])
            self._stage.settle(settled.step)
            self._stopwatch.mark("first_step_checked")
            self._shown_steps += 1
            self._lesson_steps.append({**settled.step, "step": self._shown_steps})
            await ready.put(ReadyStep({**settled.step, "step": self._shown_steps}, self._voice(settled.step["say"])))
        await ready.put(None)

    async def _settle_step(self, brief: Brief, pending: PendingStep, scene: Any) -> SettledStep | None:
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
            if checked.still:
                self._log_repair(pending.number, attempt + 1, checked.advice, "dropped the still Step, which the writer could not make play")
                return self._leave_out(written)
            if isinstance(written, dict) and "challenge" in written and any(CHALLENGE_FLAW.match(advice) for advice in checked.advice):
                cut = (pending.number, _prompt_of(written["challenge"]))
                unasked = await self._unasked(brief, pending, written, scene)
                if unasked is not None:
                    self._log_repair(pending.number, attempt + 1, checked.advice, "dropped the Challenge, whose flaw the writer could not fix")
                    self._cut_question = cut
                    return unasked
                question = {field: value for field, value in (checked.step or {}).items() if field != "challenge"}
                if pending.number > 1 and not (question.get("do") or question.get("scene")) and await pending.followed:
                    self._log_repair(pending.number, attempt + 1, checked.advice, "left out the question Step, whose Challenge the writer could not fix and which plays nothing without it")
                    self._cut_question = cut
                    return self._leave_out(written)
            if (held := self._held_back(written, checked)) is not None:
                rechecked = await self._check(held, pending, scene)
                if not rechecked.errors and not rechecked.advice:
                    self._log_repair(pending.number, attempt + 1, checked.advice, "graphed the line only half way, since the writer kept drawing it to its end")
                    return self._accepted(held, rechecked)
            self._log_repair(pending.number, attempt + 1, checked.advice, "kept as written")
            return self._accepted(written, checked)
        if HONOR_CODE_ERROR in checked.errors:
            raise LessonError(f"Step {pending.number} still broke the honor code after {MAX_REPAIR_TRIES} rewrites")
        return await self._salvage(brief, pending, written, checked, scene)

    def _held_back(self, written: dict[str, Any] | Malformed, checked: Checked) -> dict[str, Any] | None:
        if not isinstance(written, dict) or checked.plot_ended is None or checked.step is None:
            return None
        plot, line = checked.plot_ended
        scene = checked.step.get("scene") if isinstance(checked.step.get("scene"), dict) else {}
        spec = scene[plot] if isinstance(scene.get(plot), dict) else self._stage.specs.get(plot, {})
        return graphed_half_way(written, plot, line, (spec.get("curves") or {}).get(line))

    async def _unasked(self, brief: Brief, pending: PendingStep, written: dict[str, Any], scene: Any) -> SettledStep | None:
        unasked = {field: value for field, value in written.items() if field != "challenge"}
        rewritten = await self._kit.writer.repair(brief, scene, unasked, [NARRATION_ONLY], self._record.id)
        say = rewritten.get("say") if isinstance(rewritten, dict) else None
        if not isinstance(say, str) or not say.strip() or PLACEHOLDER.search(say):
            return None
        unasked = retold(unasked, say)
        checked = await self._check(unasked, pending, scene)
        if checked.errors or checked.still or any(CHALLENGE_FLAW.match(advice) for advice in checked.advice) or OPEN_QUESTION in checked.advice:
            return None
        return self._accepted(unasked, checked)

    def _mended(self, written: dict[str, Any] | Malformed, number: int) -> dict[str, Any] | Malformed:
        if isinstance(written, Malformed):
            return written
        step = mended({**written, "step": number}, self._stage)
        return as_promise(with_one_figure_on_stage(step, self._stage) if self._is_kid else step)

    def _accepted(self, written: dict[str, Any] | Malformed, checked: Checked) -> SettledStep:
        self._stage.remember_trace(written, checked.step, checked.values)
        self._stage.remember_simulation(written)
        self._remembered_values.update(checked.values)
        if isinstance(written, dict):
            self._case_keys |= self._kit.practice.keys_of(written)
        self._case_keys |= self._kit.practice.keys_of(checked.step)
        return SettledStep(checked.step, checked.scene)

    async def _check(self, written: dict[str, Any] | Malformed, pending: PendingStep, scene: Any) -> Checked:
        number = pending.number
        if isinstance(written, Malformed):
            return Checked([coached(written.reason)], None, scene)
        step = written
        too_soon = self._side_run_too_soon(written)
        owned = self._stage.errors_in_written(written) + [error for again in self._stage.redeclared(written) if (error := await self._declared_as_before(again))]
        if owned:
            return Checked(owned, None, scene, too_soon)
        try:
            tools = replace(self._kit.directive_tools, lesson_id=self._record.id, young_child=self._is_kid, staged=self._stage.on_stage(), traced=frozenset(self._stage.traces), pictures=dict(self._stage.specs), played=tuple(self._stage.played))
            expanded, values = await expand_directives(step, tools, self._remembered_values)
            step = mended_cues(expanded)
        except DirectiveError as error:
            return Checked([coached(str(error))], None, scene, too_soon)
        known = {**self._remembered_values, **values}
        facts = computed_facts(known)
        step, verdict = await validated_and_mended(self._kit.validator, step, scene, self._reading, self._stage)
        arrays, figures = array_plays(scene, step), shapes_plays(scene, step)
        plays: list[StagePlay] = [*arrays, *figures]
        plots = plot_views(scene, step)
        events = event_plays(scene, step, self._op_docs)
        fine_for_child, keeps_honor_code, restates_point, claims_agree, asked_at_the_close, spoiler, still, *further_advice = await asyncio.gather(
            self._fine_for_child(step),
            self._keeps_honor_code(step),
            self._restates_point(step, number, pending.followed),
            self._claims_agree(step, written, known, facts),
            _asked_at_the_close(step, number, pending.followed),
            self._ends_before_hinge(step, scene, written, values, plots, pending.followed),
            self._still_stage(step, written, number, pending.followed),
            self._missing_hinge(step, number, pending.last_after),
            self._narration_off_stage(step, arrays, figures, events),
            self._card_off_stage(step, scene),
            self._stress_off_stage(step, scene),
            self._reveal_off_answer(step),
            self._answers_cut_question(step, pending.number),
            self._recalls_left_out(step),
            self._answer_on_stage(step, written, [play.shown() for play in plays] + [view.shown() for view in plots if view.lines] + [play.told() for play in events]),
            answer_told(self._kit.classifier, step, self._told, self._stage.cell_place(step), self._record.id),
            asks_another_question(self._kit.classifier, step, self._record.id),
            self._story_off_lab(step, number),
            _end_told_early(step, plots),
            _challenge_read_off(step, plots),
            self._run_left_unfinished(written, values, pending.followed),
            _picture_at_close(scene, verdict.scene, pending.followed, self._is_kid and brings_in_a_figure(step, self._stage)),
        )
        errors = [coached(error) for error in verdict.errors] + self._stage.errors_in(step, written, values)
        if asked_at_the_close:
            errors.append(ASKED_AT_THE_CLOSE)
        if not keeps_honor_code:
            errors.append(HONOR_CODE_ERROR)
        if not fine_for_child:
            self._redone_for_child.add(number)
            errors.append("say is not fine for a young child; rewrite the narration so it is gentle, true and free of frightening or adult content")
        if not claims_agree:
            self._claims_disagreed.add(number)
            errors.append(_claims_disagree(_claimed(step), facts))
        advice = [] if restates_point or number in self._claims_disagreed else [f'the last Step must say the Lesson\'s point again in plain words, and this narration does not; the point is "{self._record.header["point"]}"; rewrite "say" so it states that point simply as the close of the story, and keep the Step\'s scene and challenge']
        advice.extend(found for found in [spoiler.advice if spoiler else None, still, *further_advice] if found)
        advice.extend(too_soon)
        if number > 1 and "challenge" not in step and isinstance(step.get("say"), str) and step["say"].rstrip().endswith("?"):
            advice.append(OPEN_QUESTION)
        if number == 1 and not self._refused and isinstance(step.get("say"), str) and len(step["say"].split()) > PROMISE_WORDS:
            advice.append(f"the promise must be one question sentence of at most {PROMISE_WORDS} words, and this one runs longer; cut any setup sentence and keep the concrete example inside the question")
        return Checked(errors, step, verdict.scene, advice, values, [] if claims_agree else facts, still is not None, spoiler.plot_ended if spoiler else None)

    async def _declared_as_before(self, again: Redeclared) -> str | None:
        before, now = await asyncio.gather(self._kit.validator.declared(again.name, again.before, self._reading), self._kit.validator.declared(again.name, again.now, self._reading))
        if before is None or before != now:
            return None
        return DECLARED_AGAIN.format(name=again.name, moves=" and ".join(again.moves))

    async def _missing_hinge(self, step: dict[str, Any], number: int, last_after: asyncio.Future[dict[str, Any] | Malformed | None]) -> str | None:
        if number == 1 or self._asked_challenge or "challenge" in step:
            return None
        last = await last_after
        if last is None:
            return None
        say = last.get("say") if isinstance(last, dict) else None
        hinge = self._stage.open_hinge()
        planned = PLANNED_HINGE.format(until=hinge.until, on=hinge.on, question=hinge.asked) if hinge else ""
        return MISSING_HINGE + planned + (REVEALED_NEXT.format(say=say) if isinstance(say, str) else "")

    async def _story_off_lab(self, step: dict[str, Any], number: int) -> str | None:
        planned = self._planned_labs | set(self._record.labs)
        if number != 2 or not planned:
            return None
        scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
        kept = {lab for name, lab in self._stage.labs.items() if not (name in scene and not isinstance(scene[name], dict))}
        brought = {spec["lab"] for spec in scene.values() if isinstance(spec, dict) and isinstance(spec.get("lab"), str)}
        if kept | brought:
            return None
        return " ".join([STORY_OFF_LAB.format(labs=" or ".join(sorted(planned))), *directive_briefs(tuple(sorted(planned)))])

    async def _ends_before_hinge(self, step: dict[str, Any], scene: Any, written: dict[str, Any] | Malformed, values: dict[str, Any], plots: list[PlotView], followed: asyncio.Future[bool]) -> Spoiler | None:
        if self._asked_challenge or "challenge" in step:
            return None
        if trace_totals(values) and self._stage.plays_last_run(written):
            until = self._stage.until_shown_by(written)
            spoiler = Spoiler(RUN_ENDS_AFTER_STOP.format(until=until) if isinstance(until, int) and until > 0 else RUN_ENDS_BEFORE_HINGE)
        elif finished := next((view for view in plots if view.graphed and not view.unfinished), None):
            spoiler = Spoiler(PLOT_ENDS_BEFORE_HINGE.format(plot=finished.name, line=finished.graphed[-1]), (finished.name, finished.graphed[-1]))
        elif any(operation.get("op") == "fault" and self._stage.labs.get(next(iter(operation.get("on") or []), "")) == "address" for operation in step.get("do", []) if isinstance(operation, dict)):
            spoiler = Spoiler(LOADED_BEFORE_HINGE)
        elif right := next((match for match in card_matches(scene, step) if match.right), None):
            spoiler = Spoiler(MATCHED_BEFORE_HINGE.format(meaning=right.meanings[right.marked]))
        else:
            return None
        return spoiler if await followed else None

    async def _run_left_unfinished(self, written: dict[str, Any] | Malformed, values: dict[str, Any], followed: asyncio.Future[bool]) -> str | None:
        if (left := self._stage.run_left_unfinished(written, values)) is None:
            return None
        return None if await followed else RUN_LEFT_UNFINISHED.format(run=left.name, until=left.until)

    def _side_run_too_soon(self, written: dict[str, Any] | Malformed) -> list[str]:
        if (until := self._stage.main_stop_before_side_run(written)) is not None:
            return [SIDE_RUN_TOO_SOON.format(until=until)]
        if (until := self._stage.side_stop_before_main_run(written)) is not None:
            return [MAIN_RUN_TOO_SOON.format(until=until)]
        if (hinge := self._stage.misses_the_hinge(written)) is not None:
            return [OFF_THE_HINGE.format(until=hinge.until, on=hinge.on, question=hinge.asked)]
        return []

    async def _still_stage(self, step: dict[str, Any], written: dict[str, Any], number: int, followed: asyncio.Future[bool]) -> str | None:
        if number == 1 or (step.get("do") and not _only_emphasis(step)) or step.get("scene") or "challenge" in step:
            return None
        if not await followed:
            return None
        opening = EMPHASIS_OPENING if step.get("do") else STILL_OPENING
        staged = next(iter(staged_directives(written)), None)
        if staged:
            return opening + STILL_RUN.format(directive=staged)
        if running := self._stage.unfinished_simulation():
            return opening + STILL_SIMULATION.format(simulation=json.dumps(running))
        if (next_run := self._stage.run_to_play_next()) is None:
            return opening + STILL_STAGE
        if next_run.until is None:
            return opening + STILL_STAGE + STILL_SIDE_RUN
        return opening + STILL_STAGE + STILL_STOPPED_RUN.format(run=next_run.name, until=next_run.until)

    async def _narration_off_stage(self, step: dict[str, Any], arrays: list[ArrayPlay], figures: list[FigurePlay], events: list[EventPlay]) -> str | None:
        say = step.get("say")
        touched = {target for operation in step.get("do") or [] if isinstance(operation, dict) for target in operation_targets(operation)}
        moved_arrays = "; and ".join(play.told() for play in arrays if play.moves or play.name in touched)
        looking_arrays = "; and ".join(play.told() for play in arrays if play.looks)
        moved_figures = "; and ".join(play.told() for play in figures if play.moves)
        played_events = "; and ".join(play.told() for play in events)
        if not isinstance(say, str) or not (moved_arrays or moved_figures or played_events):
            return None
        classifier = self._kit.classifier
        try:
            off = await asyncio.gather(
                *([classifier.tells_other_moves(moved_arrays, say, self._record.id)] if moved_arrays else []),
                *([classifier.tells_other_looks(looking_arrays, say, self._record.id)] if looking_arrays else []),
                *([classifier.misnumbers_figures(moved_figures, say, self._record.id)] if moved_figures else []),
                *([classifier.tells_other_events(played_events, say, self._record.id)] if played_events else []),
            )
        except GatewayError as error:
            LOG.warning("lesson %s Step could not be checked against its stage: %s", self._record.id, error)
            return None
        return NARRATION_OFF_STAGE.format(played="; and ".join(filter(None, (moved_arrays, moved_figures, played_events)))) if any(off) else None

    async def _card_off_stage(self, step: dict[str, Any], scene: Any) -> str | None:
        say = step.get("say")
        if not isinstance(say, str):
            return None
        classifier = self._kit.classifier
        for match in card_matches(scene, step):
            marked = match.meanings[match.marked]
            try:
                named, denied = await asyncio.gather(
                    classifier.card_named(say, match.meanings, self._record.id),
                    classifier.card_mark_denied(say, marked, match.right, self._record.id),
                )
            except GatewayError as error:
                LOG.warning("lesson %s card match could not be checked against its narration: %s", self._record.id, error)
                return None
            if named is not None and named != match.marked:
                return CARD_OFF_STAGE.format(named=match.meanings[named], marked=marked, index=match.marked)
            if denied:
                mark, told = ("a check mark", "not the word's meaning") if match.right else ("a cross", "the word's meaning")
                return CARD_MARK_DENIED.format(mark=mark, marked=marked, answer=match.meanings[match.cards.answer], told=told)
        return None

    async def _stress_off_stage(self, step: dict[str, Any], scene: Any) -> str | None:
        say = step.get("say")
        if not isinstance(say, str):
            return None
        for mark in stress_marks(scene, step):
            try:
                off = await self._kit.classifier.stress_off_stage(say, mark.syllables, mark.marked, self._record.id)
            except GatewayError as error:
                LOG.warning("lesson %s stress could not be checked against its narration: %s", self._record.id, error)
                return None
            if off:
                return STRESS_OFF_STAGE.format(marked=mark.syllables[mark.marked], index=mark.marked, word="-".join(mark.syllables))
        return None

    async def _reveal_off_answer(self, step: dict[str, Any]) -> str | None:
        answers, say = self._stage.answers_to_open_challenge(), step.get("say")
        if answers is None or not isinstance(say, str) or "challenge" in step:
            return None
        try:
            confirmed = await self._kit.classifier.answer_confirmed(say, answers.asked, answers.options, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s reveal could not be checked against its Challenge: %s", self._record.id, error)
            return None
        if confirmed == answers.right:
            return None
        return REVEAL_OFF_ANSWER.format(asked=answers.asked, answer=answers.options[answers.right])

    async def _answers_cut_question(self, step: dict[str, Any], number: int) -> str | None:
        say = step.get("say")
        if self._cut_question is None or self._cut_question[0] >= number or not self._cut_question[1] or not isinstance(say, str) or "challenge" in step:
            return None
        try:
            answers = await self._kit.classifier.answers_unasked(say, self._cut_question[1], self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s narration could not be checked against the cut Challenge: %s", self._record.id, error)
            return None
        return ANSWERS_CUT_QUESTION.format(asked=self._cut_question[1]) if answers else None

    def _leave_out(self, written: dict[str, Any] | Malformed) -> None:
        if isinstance(written, dict) and isinstance(written.get("say"), str):
            self._left_out.append(written["say"])

    async def _recalls_left_out(self, step: dict[str, Any]) -> str | None:
        say = step.get("say")
        if not self._left_out or not isinstance(say, str):
            return None
        try:
            recalls = await self._kit.classifier.recalls_left_out(say, self._told, self._left_out, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s narration could not be checked against the left-out Steps: %s", self._record.id, error)
            return None
        return RECALLS_LEFT_OUT.format(left_out=" and ".join(json.dumps(line) for line in self._left_out)) if recalls else None

    async def _answer_on_stage(self, step: dict[str, Any], written: dict[str, Any], views: list[str]) -> str | None:
        asked = predicted(step, self._stage.cell_place(step))
        if not views or asked is None or self._stage.asks_the_planned_hinge(written):
            return None
        shown = "; and ".join(views)
        try:
            readable = await self._kit.classifier.answer_on_stage(shown, asked, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s Challenge could not be checked against its stage: %s", self._record.id, error)
            return None
        return ANSWER_ON_STAGE.format(shown=shown) if readable else None

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
        return await self._claim_holds(_claimed({**step, "say": say}), facts)

    async def _claim_holds(self, claimed: str, facts: list[str]) -> bool:
        try:
            return await self._kit.classifier.claims_agree(claimed, facts, self._record.id)
        except GatewayError as error:
            LOG.warning("lesson %s Step could not be checked against its computed facts: %s", self._record.id, error)
            return True

    async def _true_say(self, brief: Brief, step: dict[str, Any], say: str, facts: list[str], scene: Any) -> str | None:
        sentences = SENTENCE_BREAK.split(say)
        holds = await asyncio.gather(*(self._claim_holds(sentence, facts) for sentence in sentences))
        if kept := " ".join(sentence for sentence, true in zip(sentences, holds, strict=True) if true):
            return kept
        for _ in range(MAX_REPAIR_TRIES):
            rewritten = await self._kit.writer.repair(brief, scene, {**step, "say": say}, [TRUE_NARRATION.format(facts="; ".join(facts))], self._record.id)
            retold = rewritten.get("say") if isinstance(rewritten, dict) else None
            if isinstance(retold, str) and retold.strip() and not PLACEHOLDER.search(retold) and await self._claim_holds(retold, facts):
                return retold
        return None

    async def _fine_for_child(self, step: dict[str, Any]) -> bool:
        if not self._is_kid or not isinstance(step.get("say"), str):
            return True
        return await self._kit.classifier.fine_for_young_child(step["say"], self._record.id)

    async def _keeps_honor_code(self, step: dict[str, Any]) -> bool:
        if not self._ask.course:
            return True
        shown = json.dumps({field: step[field] for field in ("say", "scene", "challenge") if field in step})
        return await self._kit.classifier.keeps_honor_code(shown, self._ask.course.honor_code, self._record.id)

    async def _salvage(self, brief: Brief, pending: PendingStep, written: dict[str, Any] | Malformed, last: Checked, scene: Any) -> SettledStep | None:
        number = pending.number
        step = last.step or {}
        self._remembered_values.update(last.values)
        recovered = _recover_say(step, written, self._remembered_values)
        say = await self._true_say(brief, step, recovered, last.disputed, scene) if last.disputed else recovered
        if say is None:
            self._log_repair(number, MAX_REPAIR_TRIES + 1, last.errors, f"left the Step out, since its narration, rewritten {MAX_REPAIR_TRIES} more times, still disagreed with what running the Lesson's examples computed")
            return self._leave_out(written)
        validator = self._kit.validator
        lost_before = self._stage.lost_runs
        self._stage.lost_runs = lost_before or ran_something(written)
        answerable = not self._stage.unran_values(step, False) and not any(CHALLENGE_FLAW.match(error) for error in last.errors + last.advice)
        if answerable and last.disputed and "challenge" in step:
            answerable = await self._claim_holds(_claimed({"say": say, "challenge": step["challenge"]}), last.disputed)
        candidate: dict[str, Any] | None = None
        for kept_fields in (("scene", "challenge"), ("challenge",), ("scene",), ()):
            if "challenge" in kept_fields and not answerable:
                continue
            trial = {"step": number, "say": say, **{field: step[field] for field in kept_fields if field in step}}
            verdict = await validator.check(trial, scene, self._reading, replay=not kept_fields)
            if verdict.ok and not self._salvage_flaws(trial, written, last.values):
                candidate = trial
                break
        kept_ops: list[dict[str, Any]] = []
        for operation in step.get("do", []) if candidate is not None else []:
            trial = retold({**candidate, "do": [*kept_ops, operation]}, candidate["say"])
            checked = await validator.check(trial, scene, self._reading)
            if checked.ok and not self._salvage_flaws(trial, written, last.values):
                kept_ops = trial["do"]
                verdict = checked
        told = "kept the narration" if say == recovered else f"narrated only what the computed facts bear out, {json.dumps(say)}"
        if candidate is None or (number > 1 and not kept_ops and set(candidate) == {"step", "say"} and _plays_something(step, written)):
            plain = await self._plainly(number, step, scene, written, last.values)
            if plain is not None:
                candidate, kept_ops, verdict = plain
                told = f"told the play plainly, {json.dumps(candidate['say'])}"
            elif number > 1 and await pending.followed:
                self._log_repair(number, MAX_REPAIR_TRIES + 1, last.errors, "left the Step out, since none of its play could be kept and its narration told that play")
                return self._leave_out(written)
            else:
                if number > 1 and self._record.header.get("point"):
                    say, told = self._record.header["point"], "closed on the Lesson's point"
                candidate, kept_ops = {"step": number, "say": say}, []
                verdict = await validator.check(candidate, scene, self._reading, replay=True)
                if not verdict.ok:
                    raise LessonError(f"Step {number} could not be repaired, and even its narration alone failed: {'; '.join(verdict.errors)}")
        if question_without_challenge(candidate):
            told_step, verdict = await self._told_not_asked(brief, {**candidate, **({"do": kept_ops} if kept_ops else {})}, verdict, scene)
            candidate, kept_ops = {key: value for key, value in told_step.items() if key != "do"}, told_step.get("do", [])
        outcome = f"{told}, dropped fields {sorted(set(step) - set(candidate) - {'do'})} and {len(step.get('do', [])) - len(kept_ops)} operations"
        self._log_repair(number, MAX_REPAIR_TRIES + 1, last.errors, outcome)
        settled = {**candidate, **({"do": kept_ops} if kept_ops else {})}
        if ran_something(written) and kept_ops == step.get("do", []) and candidate.get("scene") == step.get("scene"):
            self._stage.lost_runs = lost_before
            self._stage.remember_trace(written, settled, last.values)
            self._stage.remember_simulation(written)
        return SettledStep(settled, verdict.scene)

    async def _plainly(self, number: int, step: dict[str, Any], scene: Any, written: dict[str, Any] | Malformed, values: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], Verdict] | None:
        plain = self._stage.hops.plain_step(step)
        if plain is None:
            return None
        trial = {"step": number, **plain}
        verdict = await self._kit.validator.check(trial, scene, self._reading)
        if not verdict.ok or self._salvage_flaws(trial, written, values):
            return None
        return {key: value for key, value in trial.items() if key != "do"}, trial.get("do", []), verdict

    def _salvage_flaws(self, candidate: dict[str, Any], written: dict[str, Any] | Malformed, values: dict[str, Any]) -> list[str]:
        asked_aloud = set(question_without_challenge(candidate))
        return [error for error in self._stage.errors_in(candidate, written, values) if error not in asked_aloud]

    async def _told_not_asked(self, brief: Brief, candidate: dict[str, Any], verdict: Verdict, scene: Any) -> tuple[dict[str, Any], Verdict]:
        rewritten = await self._kit.writer.repair(brief, scene, candidate, [NARRATION_ONLY], self._record.id)
        say = rewritten.get("say") if isinstance(rewritten, dict) else None
        if not isinstance(say, str) or not say.strip() or PLACEHOLDER.search(say):
            return candidate, verdict
        told = retold(candidate, say)
        if question_without_challenge(told):
            return candidate, verdict
        checked = await self._kit.validator.check(told, scene, self._reading, replay="scene" not in told)
        return (told, checked) if checked.ok else (candidate, verdict)

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

    async def _practice(self, brief: Brief) -> str | None:
        if self._refused:
            return "not needed: a refusal has no practice"
        standing = self._kit.practice.standing(self._stage, self._last_scene, dict(self._remembered_values), frozenset(self._case_keys), self._reading)
        try:
            authored = await self._kit.practice.settle(self._practice_line, brief, self._record.header, self._lesson_steps, standing, self._record.id)
            if authored.practice is not None:
                voiced = await self._kit.practice.voiced(authored.practice)
                wire = self._kit.store.save_practice(self._record.id, voiced, self._record.topic_id)
                items = [{**item, "step": self._shown_steps + number} for number, item in enumerate(wire["items"], start=1)]
                self._live.publish("practice", {**wire, "items": items})
        except (GatewayError, PlayerCrash) as error:
            LOG.warning("lesson %s has no practice: %s", self._record.id, error)
            return f"missed: {error}"
        finally:
            self._stopwatch.mark("practice")
        return authored.check

    async def _finish(self, practice_check: str | None) -> None:
        marks = self._stopwatch.marks
        drawn = [lab for lab in self._stage.drawn_labs if lab in self._catalog_labs]
        point_check = await self._point_check if self._point_check else "not needed: a refusal has no point" if self._refused else "missed: the writer sent no point"
        record = replace(
            self._record, labs=drawn, header={**(self._record.header or {}), "labs": drawn, "point_check": point_check, **({"practice_check": practice_check} if practice_check else {})}, status="ready", first_step_seconds=marks["first_step_published"], done_seconds=self._stopwatch.elapsed(),
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


async def _picture_at_close(scene_before: Any, scene_after: Any, followed: asyncio.Future[bool], swapped_for_one_figure: bool) -> str | None:
    before, after = shown_pictures(scene_before), shown_pictures(scene_after)
    gone = [] if swapped_for_one_figure else [name for name in before if name not in after]
    zoomed = [name for name, zoomed_in in after.items() if zoomed_in]
    if not (gone or zoomed) or await followed:
        return None
    if gone:
        return CLOSED_WITHOUT_PICTURE.format(pictures=_named(gone))
    return CLOSED_ZOOMED_IN.format(pictures=_named(zoomed))


def _named(names: list[str]) -> str:
    return " and ".join(f'"{name}"' for name in names)


async def _asked_at_the_close(step: dict[str, Any], number: int, followed: asyncio.Future[bool]) -> bool:
    return number > 1 and "challenge" in step and not await followed


def _only_emphasis(step: dict[str, Any]) -> bool:
    return all(isinstance(operation, dict) and operation.get("op") in EMPHASIS_OPERATIONS and all("[" not in str(target) for target in operation.get("on") or []) for operation in step.get("do") or [])


def _plays_something(step: dict[str, Any], written: dict[str, Any] | Malformed) -> bool:
    shown = [step, *([written] if isinstance(written, dict) else [])]
    return any(source.get("do") or source.get("scene") or "challenge" in source for source in shown) or (isinstance(written, dict) and carries_directive(written))


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


async def _challenge_read_off(step: dict[str, Any], plots: list[PlotView]) -> str | None:
    challenge = step.get("challenge")
    asked = challenge.get("prompt") if isinstance(challenge, dict) else None
    if not isinstance(asked, str):
        return None
    for view in plots:
        if (at := view.read_off_at(asked)) is not None:
            return CHALLENGE_READ_OFF.format(x=view.x, at=_said_number(at), plot=view.name, end=_said_number(view.last_x))
    return None


def _said_number(value: float) -> str:
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def _prompt_of(challenge: Any) -> str:
    prompt = challenge.get("prompt") if isinstance(challenge, dict) else None
    return prompt if isinstance(prompt, str) else ""
