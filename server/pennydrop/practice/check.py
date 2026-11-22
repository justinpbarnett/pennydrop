from __future__ import annotations

import asyncio
import copy
import json
import logging
from dataclasses import dataclass, replace
from typing import Any

from ..asks.challenge_words import answer_told, asks_another_question
from ..asks.classify import Classifier
from ..asks.coaching import coached
from ..asks.directives import DIRECTIVES, DirectiveError, DirectiveTools, carries_directive, computed_facts, expand_directives
from ..asks.directives.curves import hidden_plots, with_every_line_graphed
from ..asks.directives.trace import totals_for
from ..asks.mending import mended, mended_cues, validated_and_mended
from ..asks.stage import Stage, answer_given_away
from ..asks.validator import Validator
from . import Direction, Form, Practice, Rule

CASE_DIRECTIVES = ("trace", "simulate", "math")
UNKEYED = ("until", "on", "name")
KID_FRESH_TYPES = ("click", "yesno")
LOG = logging.getLogger(__name__)

CASE_ONLY_FIELDS = ("form", "direction", "inputs", "reveal")
REVEAL_WORDS = ("say", "do", "scene")
REVEAL_COACHING = 'the fresh item holds its run back, so it carries "reveal": one sentence said while the stage plays the rest of the run, which states the answer and the because the Rule gives, such as "Insertion sort made 5 comparisons, because each card moved left only past the cards bigger than it."'
REVEAL_CONTRADICTION = 'the reveal sentence claims something the computed values of the rest of the run contradict: {facts}; rewrite the claim, or leave the numbers out of the reveal and state the because'
RUN_STAGE_NUMBER = 2
SAY_FIELDS = {"say", "challenge"}
ASKED_FIELDS = ("prompt", "type", "choices", "answer")
RULE_COACHING = {
    "general": 'the Rule ("{rule}") retells the Lesson\'s example; state the reusable pattern under it, one sentence that holds for any case of its slots, such as "binary search halves the range at every look"',
    "condition": 'the condition ("{condition}") must be a property of the input or setup that a case can lack, so the Rule\'s claim fails without it, such as "the list is sorted"; it may not repeat the Rule\'s claim or subject, describe how the process works, or hold for every case',
}
NEAR_MISS_COACHING = {
    "new": "the near miss replays a case the Lesson's Steps already showed; make a case no Step ran that lacks the condition ({condition})",
    "one_change": "the near miss keeps the worked example's setup and changes only the one detail the condition ({condition}) is about, such as the same list shuffled, never a whole new setup or a second change",
}
FRESH_COACHING = {
    "from_the_rule": 'the fresh case must be answered by applying the Rule ("{rule}") to the case on stage: ask what the Rule predicts there, never something the Rule does not cover or a recall of what a Step showed',
    "one_slot": "the fresh case changes exactly one slot of the Rule ({slots}) from the Lesson's worked example and keeps the others as the example had them",
}


@dataclass(frozen=True)
class Standing:
    stage: Stage
    scene: Any
    remembered: dict[str, Any]
    cases: frozenset[str]
    reading: bool

    @classmethod
    def empty(cls, reading: bool) -> Standing:
        return cls(Stage(kid=not reading), None, {}, frozenset(), reading)

    @property
    def young_child(self) -> bool:
        return not self.reading

    @property
    def first_step(self) -> int:
        return 1 if self.scene is None else RUN_STAGE_NUMBER


@dataclass(frozen=True)
class Revealed:
    errors: list[str]
    reveal: dict[str, Any] | None
    scene: Any
    values: dict[str, Any]


@dataclass(frozen=True)
class ItemCheck:
    errors: list[str]
    item: dict[str, Any] | None
    standing: Standing


@dataclass(frozen=True)
class LineCheck:
    errors: list[str]
    practice: Practice | None


@dataclass(frozen=True)
class Seen:
    keys: frozenset[str]
    told: str

    @classmethod
    def lesson(cls, steps: list[dict[str, Any]]) -> Seen:
        told = "\n".join(_told(number, step) for number, step in enumerate(steps, 1) if isinstance(step.get("say"), str))
        return cls(_keys_of(steps), told)

    @classmethod
    def cases(cls, items: list[dict[str, Any]]) -> Seen:
        return cls(_keys_of(items), "")


def _keys_of(steps: list[dict[str, Any]]) -> frozenset[str]:
    return frozenset().union(*(case_keys(step) for step in steps))


def case_keys(step: dict[str, Any]) -> frozenset[str]:
    return _directed_keys(step) | _shown_keys(step)


def _input_keys(step: dict[str, Any]) -> frozenset[str]:
    return _directed_keys(step) or _shown_keys(step)


def _directed_keys(step: dict[str, Any]) -> frozenset[str]:
    return frozenset(_key(_input_of(spec)) for name in CASE_DIRECTIVES if isinstance(spec := step.get(name), dict))


def _shown_keys(step: dict[str, Any]) -> frozenset[str]:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    return frozenset(_key(spec["values"]) for spec in scene.values() if isinstance(spec, dict) and "values" in spec)


def _told(number: int, step: dict[str, Any]) -> str:
    inputs = sorted(_input_keys(step))
    return f"Step {number}: {step['say']}" + (f" (input: {'; '.join(inputs)})" if inputs else "")


def _input_of(spec: dict[str, Any]) -> Any:
    return spec["input"] if "input" in spec else {name: value for name, value in spec.items() if name not in UNKEYED}


def _key(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


class PracticeChecker:
    def __init__(self, validator: Validator, tools: DirectiveTools, classifier: Classifier):
        self._validator = validator
        self._tools = tools
        self._classifier = classifier

    async def line(self, line: dict[str, Any], standing: Standing, steps: list[dict[str, Any]], lesson_id: str) -> LineCheck:
        body = line["practice"]
        rule = Rule(body["rule"], body["condition"], tuple(body["slots"]))
        seen = Seen.lesson(steps)
        rule_faults, checked = await asyncio.gather(self._rule_faults(rule, seen, lesson_id), self._items(body["challenges"], rule, standing, seen, lesson_id))
        return LineCheck([*rule_faults, *checked.errors], checked.practice)

    async def _items(self, challenges: list[dict[str, Any]], rule: Rule, standing: Standing, seen: Seen, lesson_id: str) -> LineCheck:
        errors: list[str] = []
        items: list[dict[str, Any]] = []
        for written in challenges:
            checked = await self.item(written, rule, standing, seen, lesson_id)
            errors += [f"{written['form']} item: {error}" for error in checked.errors]
            if checked.item is None:
                return LineCheck(errors, None)
            items.append(checked.item)
            standing = checked.standing
        return LineCheck(errors, Practice(rule, tuple(items)))

    async def _rule_faults(self, rule: Rule, seen: Seen, lesson_id: str) -> list[str]:
        if not seen.told:
            return []
        faults = await self._classifier.rule_faults(rule.statement, rule.condition, seen.told, lesson_id)
        return [RULE_COACHING[fault].format(rule=rule.statement, condition=rule.condition) for fault in faults]

    async def item(self, written: dict[str, Any], rule: Rule, standing: Standing, seen: Seen, lesson_id: str) -> ItemCheck:
        form = Form(written["form"])
        direction = Direction(written["direction"]) if "direction" in written else None
        body = {name: value for name, value in written.items() if name not in CASE_ONLY_FIELDS}
        if errors := _shape_errors(form, direction, body, standing):
            return ItemCheck(errors, None, standing)
        body = _with_stand_in_answer(_with_applies_answer(body, form), direction)
        stage = copy.deepcopy(standing.stage)
        tools = self._tools_on(stage, standing, lesson_id)
        mended_body = mended({**body, "step": RUN_STAGE_NUMBER}, stage)
        try:
            expanded, values = await expand_directives(mended_body, tools, standing.remembered)
        except DirectiveError as error:
            return ItemCheck([coached(str(error))], None, standing)
        if form is Form.FRESH and (hidden := hidden_plots(expanded)):
            return ItemCheck([f'the fresh case brings the plot {next(iter(hidden))} on stage but graphs none of its lines, so the learner sees empty axes; graph the lines the case stands on, and hold back with "to" only the part the learner predicts'], None, standing)
        expanded = with_every_line_graphed(expanded)
        step, verdict = await validated_and_mended(self._validator, {**mended_cues(expanded), "step": standing.first_step}, standing.scene, standing.reading, stage)
        if verdict.errors:
            return ItemCheck([coached(error) for error in verdict.errors], None, standing)
        if form is not Form.SAY and stage.labs and not _labs_left(stage.labs, step):
            return ItemCheck([f"the {form.value} case takes every Lab off the stage and leaves only captions, so the learner has nothing to work the case out on; keep the Lab the Lesson ran on and show the case on it"], None, standing)
        keys = case_keys(mended_body) | case_keys(step)
        taken = standing.cases | seen.keys
        errors, step = await self._form_errors(form, direction, rule, step, mended_body, written.get("inputs"), values, taken, tools, lesson_id)
        if not errors and form is Form.FRESH:
            errors = await self._giveaway_errors(step, stage.cell_place(step), lesson_id)
        facts = computed_facts(values)
        if not errors and facts and form is not Form.APPLIES and not await self._classifier.claims_agree(step["say"], facts, lesson_id):
            errors = [f'the narration claims something the computed values contradict: {"; ".join(facts)}; rewrite the claim, or leave the numbers out of "say" and ask instead']
        if errors:
            return ItemCheck(errors, None, standing)
        faults = await self._faults(form, rule, step, mended_body, values, taken, seen, lesson_id)
        stage.settle(step)
        stage.remember_trace(mended_body, step, values)
        remembered = {**standing.remembered, **values}
        revealed = await self._revealed(form, direction, written.get("reveal"), mended_body, stage, replace(standing, scene=verdict.scene, remembered=remembered), lesson_id)
        if revealed.errors:
            return ItemCheck(revealed.errors, None, standing)
        if _reveal_missing(form, direction, written.get("reveal"), mended_body):
            faults = [*faults, REVEAL_COACHING]
        item = {**{name: value for name, value in step.items() if name != "step"}, "form": form.value, **({"direction": direction.value} if direction else {}), **({"reveal": revealed.reveal} if revealed.reveal else {})}
        return ItemCheck(faults, item, replace(standing, stage=stage, scene=revealed.scene if revealed.reveal else verdict.scene, remembered={**remembered, **revealed.values}, cases=standing.cases | keys))

    def _tools_on(self, stage: Stage, standing: Standing, lesson_id: str) -> DirectiveTools:
        return replace(self._tools, lesson_id=lesson_id, young_child=standing.young_child, staged=stage.on_stage(), traced=frozenset(stage.traces), pictures=dict(stage.specs), played=tuple(stage.played))

    async def _revealed(self, form: Form, direction: Direction | None, told: Any, held_body: dict[str, Any], stage: Stage, standing: Standing, lesson_id: str) -> Revealed:
        nothing = Revealed([], None, standing.scene, {})
        if not _reveal_wanted(form, direction, held_body) or not _said(told):
            return nothing
        continuation = mended({**_continued(held_body), "say": told, "step": RUN_STAGE_NUMBER}, stage)
        try:
            expanded, values = await expand_directives(continuation, self._tools_on(stage, standing, lesson_id), standing.remembered)
        except DirectiveError as error:
            LOG.warning("lesson %s has no reveal: %s", lesson_id, error)
            return nothing
        step, verdict = await validated_and_mended(self._validator, {**mended_cues(expanded), "step": RUN_STAGE_NUMBER}, standing.scene, standing.reading, stage)
        if verdict.errors:
            LOG.warning("lesson %s has no reveal: %s", lesson_id, "; ".join(verdict.errors))
            return nothing
        facts = computed_facts(values)
        if facts and not await self._classifier.claims_agree(step["say"], facts, lesson_id):
            return Revealed([REVEAL_CONTRADICTION.format(facts="; ".join(facts))], None, standing.scene, {})
        stage.settle(step)
        stage.remember_trace(continuation, step, values)
        return Revealed([], {name: step[name] for name in REVEAL_WORDS if step.get(name)}, verdict.scene, values)

    async def _faults(self, form: Form, rule: Rule, step: dict[str, Any], written: dict[str, Any], values: dict[str, Any], taken: frozenset[str], seen: Seen, lesson_id: str) -> list[str]:
        case = _case_text(step, values)
        if form is Form.APPLIES:
            repeated = sorted(_input_keys(written) & taken)
            faults = [f"the near miss's input is {repeated[0]}, which the Lesson already used; keep the worked example's setup and change only what the condition is about, to a value no Step used"] if repeated else []
            found = await self._classifier.near_miss_faults(case, rule.condition, seen.told, lesson_id) if seen.told else []
            return faults + [NEAR_MISS_COACHING[fault].format(condition=rule.condition) for fault in found]
        if form is Form.FRESH:
            found = await self._classifier.fresh_faults(case, rule.statement, rule.slots if seen.told and len(rule.slots) > 1 else (), seen.told, lesson_id)
            return [FRESH_COACHING[fault].format(rule=rule.statement, slots=", ".join(rule.slots)) for fault in found]
        return []

    async def _form_errors(self, form: Form, direction: Direction | None, rule: Rule, step: dict[str, Any], written: dict[str, Any], inputs: Any, values: dict[str, Any], taken: frozenset[str], tools: DirectiveTools, lesson_id: str) -> tuple[list[str], dict[str, Any]]:
        if form is Form.SAY:
            asks = await self._classifier.asks_why_the_rule_holds(step["say"], rule.statement, lesson_id)
            return ([] if asks else ['the say item must ask the learner to say, in their own words with a "because", why the Rule holds or why what it explains happens, and must not state the reason itself'], step)
        if form is Form.APPLIES:
            return await self._applies_errors(rule, step, values, lesson_id), step
        repeated = sorted(_input_keys(written) & taken)
        if repeated:
            return [f"the fresh case's input is {repeated[0]}, which the worked example or an earlier case already used; change exactly one slot of the Rule ({', '.join(rule.slots)}) to a value none of them used"], step
        if direction is Direction.BACK:
            return await self._back_errors(step, written, inputs, tools)
        return [], step

    async def _giveaway_errors(self, step: dict[str, Any], place: str | None, lesson_id: str) -> list[str]:
        found = await asyncio.gather(answer_told(self._classifier, step, [], place, lesson_id), asks_another_question(self._classifier, step, lesson_id))
        return answer_given_away(step) + [error for error in found if error]

    async def _applies_errors(self, rule: Rule, step: dict[str, Any], values: dict[str, Any], lesson_id: str) -> list[str]:
        if await self._classifier.breaks_the_condition(_case_text(step, values), rule.condition, lesson_id):
            return []
        return [f'the near miss must break the Rule\'s condition ("{rule.condition}") so the Rule does not apply to it. When the condition describes how the algorithm works, no case can break it: rewrite the whole line with a Rule whose condition is a property of the input or setup that a case can lack, such as "the list is sorted", and make the near miss lack exactly that']

    async def _back_errors(self, step: dict[str, Any], written: dict[str, Any], inputs: Any, tools: DirectiveTools) -> tuple[list[str], dict[str, Any]]:
        if "trace" in written:
            return await self._traced_back_errors(step, written, tools)
        computing = next((name for name in ("math", "simulate") if isinstance(written.get(name), dict)), None)
        if computing is None:
            return ['a fresh item that runs back carries the directive that computes its result: a "trace" with no "until", or a "math" or "simulate" directive plus "inputs"'], step
        if "until" in written[computing]:
            return [f'a fresh item that runs back carries its {computing} directive with no "until", so the stage shows the finished result'], step
        challenge = step["challenge"]
        choices = challenge.get("choices", []) if challenge.get("type") == "choice" else []
        if len(choices) < 2 or not isinstance(inputs, dict) or set(inputs) != set(choices):
            return ['a fresh item that runs back asks a "choice" of at least two candidate inputs, and carries "inputs", an object that maps each choice, letter for letter, to the full ' + computing + ' directive that candidate gives'], step
        reference = await _result(computing, written[computing], tools)
        if reference is None:
            return [f"the {computing} directive of the item gives no result"], step
        matching = [choice for choice in choices if await _result(computing, inputs[choice], tools) == reference]
        return _answered_by_the_one_match(step, reference, matching)

    async def _traced_back_errors(self, step: dict[str, Any], written: dict[str, Any], tools: DirectiveTools) -> tuple[list[str], dict[str, Any]]:
        trace = written["trace"]
        if not isinstance(trace, dict) or "until" in trace:
            return ['a fresh item that runs back carries a "trace" with no "until", so the stage shows the finished run and its result, and the learner picks the input that made it'], step
        challenge = step["challenge"]
        reference = await totals_for(trace, tools.tracer)
        if not reference:
            return ["the trace makes no comparisons, swaps or writes, so no result tells its inputs apart; trace an algorithm whose result depends on its input"], step
        candidates = _candidate_inputs(challenge, trace["input"], step)
        if len(candidates) < 2:
            return ['a fresh item that runs back asks a "choice" of at least two candidate inputs written as JSON, such as "[4, 9, 2]", or a "click" on one of at least two arrays on stage'], step
        matching = [label for label, candidate in candidates.items() if await _gives(trace, candidate, reference, tools)]
        return _answered_by_the_one_match(step, reference, matching)


def _reveal_wanted(form: Form, direction: Direction | None, body: dict[str, Any]) -> bool:
    return form is Form.FRESH and direction is not Direction.BACK and _holds_run_back(body)


def _said(told: Any) -> bool:
    return isinstance(told, str) and bool(told.strip())


def _reveal_missing(form: Form, direction: Direction | None, told: Any, body: dict[str, Any]) -> bool:
    return _reveal_wanted(form, direction, body) and not _said(told)


def _holds_run_back(body: dict[str, Any]) -> bool:
    directed = any(isinstance(body.get(name), dict) and "until" in body[name] for name in CASE_DIRECTIVES)
    return directed or bool(_held_graphs(body))


def _held_graphs(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [operation for operation in body.get("do") or [] if isinstance(operation, dict) and operation.get("op") == "graph" and "to" in operation]


def _continued(body: dict[str, Any]) -> dict[str, Any]:
    directives = {name: {key: value for key, value in body[name].items() if key != "until"} for name in CASE_DIRECTIVES if isinstance(body.get(name), dict)}
    graphs = [{key: value for key, value in operation.items() if key not in ("to", "cue")} for operation in _held_graphs(body)]
    return {**directives, **({"do": graphs} if graphs else {})}


def _labs_left(labs: dict[str, str], step: dict[str, Any]) -> set[str]:
    scene = step.get("scene") or {}
    kept = {name for name in labs if name not in scene or (isinstance(scene[name], dict) and isinstance(scene[name].get("lab"), str))}
    return kept | {name for name, spec in scene.items() if isinstance(spec, dict) and isinstance(spec.get("lab"), str)}


def _case_text(step: dict[str, Any], values: dict[str, Any]) -> str:
    challenge = step.get("challenge") if isinstance(step.get("challenge"), dict) else {}
    asked = {name: value for name, value in challenge.items() if name in ASKED_FIELDS}
    return "\n".join([f"Case: {step['say']}", f"Challenge: {json.dumps(asked)}", f"Case on the stage: {json.dumps(step.get('scene') or {})[:600]}", *(f"Fact: {fact}" for fact in computed_facts(values))])


def _answered_by_the_one_match(step: dict[str, Any], reference: Any, matching: list[str]) -> tuple[list[str], dict[str, Any]]:
    if len(matching) != 1:
        return [f"exactly one candidate input must give the shown result {json.dumps(reference)}, and {len(matching)} do ({', '.join(matching) or 'none'}); change the candidates so a single one gives it"], step
    return [], {**step, "challenge": {**step["challenge"], "answer": matching[0]}}


async def _result(name: str, spec: Any, tools: DirectiveTools) -> str | None:
    try:
        _, found = await DIRECTIVES[name].expand({"scene": {}}, spec, tools)
    except DirectiveError:
        return None
    return json.dumps({key: round(value, 6) if isinstance(value, float) else value for key, value in found.items()}, sort_keys=True, default=str)


def _shape_errors(form: Form, direction: Direction | None, body: dict[str, Any], standing: Standing) -> list[str]:
    young_child = standing.young_child
    challenge = body.get("challenge") if isinstance(body.get("challenge"), dict) else {}
    kind = challenge.get("type")
    if form is Form.SAY:
        allowed = SAY_FIELDS if standing.scene is not None else SAY_FIELDS | {"scene"}
        return [] if kind == "words" and set(body) <= allowed else ['the say item holds only "say" and a words challenge: it stays on the Lesson\'s proof, so it has no scene, do or directive' if standing.scene is not None else 'the say item holds only "say", a "scene" that shows the Rule\'s proof on the empty stage, and a words challenge, with no do or directive']
    if form is Form.APPLIES:
        errors = []
        if kind != "yesno":
            errors.append(f'the applies item\'s "challenge" is a {{"kind": "predict", "type": "yesno", "prompt": "..."}} asking whether the Rule still works on the near miss, and this one is {json.dumps(challenge)[:120] if challenge else "missing"}')
        if "scene" not in body and not carries_directive(body):
            errors.append('the applies item shows its near miss on the stage: it must carry a "scene" that declares the objects of the case, or a directive')
        return errors
    errors = []
    if kind in ("words", None):
        errors.append("the fresh item asks a predict Challenge of a type the Lesson's Labs allow, never words")
    if young_child and kind not in KID_FRESH_TYPES:
        errors.append("a kid's fresh item is a click or yesno Challenge, with nothing to read")
    if kind == "number" and not isinstance(challenge.get("answer"), str):
        errors.append('a number answer names a directive value such as "trace.comparisons" and is never a number you work out: carry the directive that computes it')
    if direction is Direction.BACK and kind not in ("choice", "click"):
        errors.append("a fresh item that runs back is a choice, or for a kid a click, among candidate inputs")
    return errors


def _with_applies_answer(body: dict[str, Any], form: Form) -> dict[str, Any]:
    challenge = body.get("challenge")
    if form is not Form.APPLIES or not isinstance(challenge, dict) or challenge.get("type") != "yesno":
        return body
    return {**body, "challenge": {**challenge, "kind": "predict", "answer": "no"}}


def _with_stand_in_answer(body: dict[str, Any], direction: Direction | None) -> dict[str, Any]:
    challenge = body.get("challenge")
    if direction is not Direction.BACK or not isinstance(challenge, dict) or "answer" in challenge:
        return body
    scene = body.get("scene") if isinstance(body.get("scene"), dict) else {}
    options = challenge.get("choices") if challenge.get("type") == "choice" else [name for name, spec in scene.items() if isinstance(spec, dict) and "values" in spec]
    return {**body, "challenge": {**challenge, "answer": options[0]}} if options else body


def _candidate_inputs(challenge: dict[str, Any], traced: Any, step: dict[str, Any]) -> dict[str, Any]:
    if challenge.get("type") == "click":
        scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
        return {name: _beside(traced, spec["values"]) for name, spec in scene.items() if isinstance(spec, dict) and "values" in spec}
    return {text: _beside(traced, _parsed(text)) for text in challenge.get("choices", [])}


def _parsed(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            return json.loads(f"[{text}]")
        except json.JSONDecodeError:
            return text


def _beside(traced: Any, candidate: Any) -> Any:
    if not isinstance(traced, dict):
        return candidate
    listed = next((name for name, value in traced.items() if isinstance(value, list)), None)
    return {**traced, listed: candidate} if listed else traced


async def _gives(trace: dict[str, Any], candidate: Any, reference: dict[str, Any], tools: DirectiveTools) -> bool:
    try:
        return await totals_for({**trace, "input": candidate}, tools.tracer) == reference
    except DirectiveError:
        return False

