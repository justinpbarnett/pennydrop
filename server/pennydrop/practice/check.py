from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import dataclass, replace
from typing import Any

from ..asks.classify import Classifier
from ..asks.coaching import coached
from ..asks.directives import DirectiveError, DirectiveTools, carries_directive, computed_facts, expand_directives
from ..asks.directives.trace import totals_for
from ..asks.mending import mended, mended_cues, validated_and_mended
from ..asks.stage import Stage
from ..asks.validator import Validator
from . import Direction, Form, Practice, Rule

CASE_DIRECTIVES = ("trace", "simulate", "math")
UNKEYED = ("until", "on", "name")
PRESENTATION = ("at", "title", "counters", "pointers", "window", "sorted", "label")
KID_FRESH_TYPES = ("click", "yesno")
CASE_ONLY_FIELDS = ("form", "direction")
RUN_STAGE_NUMBER = 2
SAY_FIELDS = {"say", "challenge"}


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
class ItemCheck:
    errors: list[str]
    item: dict[str, Any] | None
    standing: Standing


@dataclass(frozen=True)
class LineCheck:
    errors: list[str]
    practice: Practice | None


def case_keys(step: dict[str, Any]) -> frozenset[str]:
    keys = {_key(_input_of(spec)) for name in CASE_DIRECTIVES if isinstance(spec := step.get(name), dict)}
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    keys |= {_key(spec["values"]) for spec in scene.values() if isinstance(spec, dict) and "values" in spec}
    return frozenset(keys)


def _input_of(spec: dict[str, Any]) -> Any:
    return spec["input"] if "input" in spec else {name: value for name, value in spec.items() if name not in UNKEYED}


def _key(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


class PracticeChecker:
    def __init__(self, validator: Validator, tools: DirectiveTools, classifier: Classifier):
        self._validator = validator
        self._tools = tools
        self._classifier = classifier

    async def line(self, line: dict[str, Any], standing: Standing, seen: list[dict[str, Any]], lesson_id: str) -> LineCheck:
        body = line["practice"]
        rule = Rule(body["rule"], body["condition"], tuple(body["slots"]))
        earlier = frozenset().union(*(case_keys(item) for item in seen))
        items: list[dict[str, Any]] = []
        for written in body["challenges"]:
            checked = await self.item(written, rule, standing, earlier, lesson_id)
            if checked.item is None:
                return LineCheck([f"{written['form']} item: {error}" for error in checked.errors], None)
            items.append(checked.item)
            standing = checked.standing
        return LineCheck([], Practice(rule, tuple(items)))

    async def item(self, written: dict[str, Any], rule: Rule, standing: Standing, earlier: frozenset[str], lesson_id: str) -> ItemCheck:
        form = Form(written["form"])
        direction = Direction(written["direction"]) if "direction" in written else None
        body = {name: value for name, value in written.items() if name not in CASE_ONLY_FIELDS}
        if errors := _shape_errors(form, direction, body, standing):
            return ItemCheck(errors, None, standing)
        body = _with_stand_in_answer(body, direction)
        stage = copy.deepcopy(standing.stage)
        tools = replace(self._tools, lesson_id=lesson_id, young_child=standing.young_child, staged=stage.on_stage(), traced=frozenset(stage.traces), pictures=dict(stage.specs), played=tuple(stage.played))
        mended_body = mended({**body, "step": RUN_STAGE_NUMBER}, stage)
        try:
            expanded, values = await expand_directives(mended_body, tools, standing.remembered)
        except DirectiveError as error:
            return ItemCheck([coached(str(error))], None, standing)
        step, verdict = await validated_and_mended(self._validator, {**mended_cues(expanded), "step": standing.first_step}, standing.scene, standing.reading, stage)
        if verdict.errors:
            return ItemCheck([coached(error) for error in verdict.errors], None, standing)
        keys = case_keys(mended_body) | case_keys(step)
        errors, step = await self._form_errors(form, direction, rule, step, mended_body, values, keys, standing.cases | earlier, tools, lesson_id)
        facts = computed_facts(values)
        if not errors and facts and not await self._classifier.claims_agree(step["say"], facts, lesson_id):
            errors = [f'the narration claims something the computed values contradict: {"; ".join(facts)}; rewrite the claim, or leave the numbers out of "say" and ask instead']
        if errors:
            return ItemCheck(errors, None, standing)
        stage.settle(step)
        stage.remember_trace(mended_body, step, values)
        item = {**{name: value for name, value in step.items() if name != "step"}, "form": form.value, **({"direction": direction.value} if direction else {})}
        return ItemCheck([], item, replace(standing, stage=stage, scene=verdict.scene, remembered={**standing.remembered, **values}, cases=standing.cases | keys))

    async def _form_errors(self, form: Form, direction: Direction | None, rule: Rule, step: dict[str, Any], written: dict[str, Any], values: dict[str, Any], keys: frozenset[str], taken: frozenset[str], tools: DirectiveTools, lesson_id: str) -> tuple[list[str], dict[str, Any]]:
        if form is Form.SAY:
            asks = await self._classifier.asks_why_the_rule_holds(step["say"], rule.statement, lesson_id)
            return ([] if asks else ['the say item must ask the learner to explain, in their own words with a "because", why the Rule holds, and must not state the reason itself'], step)
        if form is Form.APPLIES:
            return await self._applies_errors(rule, step, values, lesson_id), step
        repeated = sorted(keys & taken)
        if repeated:
            return [f"the fresh case's input is {repeated[0]}, which the worked example or an earlier case already used; change exactly one slot of the Rule ({', '.join(rule.slots)}) to a value none of them used"], step
        if direction is Direction.BACK:
            return await self._back_errors(step, written, tools)
        return [], step

    async def _applies_errors(self, rule: Rule, step: dict[str, Any], values: dict[str, Any], lesson_id: str) -> list[str]:
        facts = computed_facts(values)
        case = "\n".join([f"Case: {step['say']}", f"Case on the stage: {json.dumps(step.get('scene') or {})[:600]}", *(f"Fact: {fact}" for fact in facts)])
        breaks, *failing = await asyncio.gather(self._classifier.breaks_the_condition(case, rule.condition, lesson_id), *([self._classifier.shows_the_rule_failing(case, rule.statement, lesson_id)] if facts else []))
        errors = [] if breaks else [f'the near miss must break the Rule\'s condition ("{rule.condition}") by exactly one condition, so the Rule does not apply to it; change the case so it does']
        if facts and not all(failing):
            errors.append("the computed facts do not show the Rule failing in this case; change the case so running it shows the Rule failing, or pick a case where the Rule fails")
        return errors

    async def _back_errors(self, step: dict[str, Any], written: dict[str, Any], tools: DirectiveTools) -> tuple[list[str], dict[str, Any]]:
        trace = written.get("trace")
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
        if len(matching) != 1:
            return [f"exactly one candidate input must give the shown result {json.dumps(reference)}, and {len(matching)} do ({', '.join(matching) or 'none'}); change the candidates so a single one gives it"], step
        return [], {**step, "challenge": {**challenge, "answer": matching[0]}}


def _shape_errors(form: Form, direction: Direction | None, body: dict[str, Any], standing: Standing) -> list[str]:
    young_child = standing.young_child
    challenge = body.get("challenge") if isinstance(body.get("challenge"), dict) else {}
    kind = challenge.get("type")
    if form is Form.SAY:
        allowed = SAY_FIELDS if standing.scene is not None else SAY_FIELDS | {"scene"}
        return [] if kind == "words" and set(body) <= allowed else ['the say item holds only "say" and a words challenge: it stays on the Lesson\'s proof, so it has no scene, do or directive' if standing.scene is not None else 'the say item holds only "say", a "scene" that shows the Rule\'s proof on the empty stage, and a words challenge, with no do or directive']
    if form is Form.APPLIES:
        if kind != "yesno" or challenge.get("answer") != "no":
            return ['the applies item\'s challenge is {"kind": "predict", "type": "yesno", "answer": "no"}, because the near miss breaks the Rule\'s condition']
        return [] if "scene" in body or carries_directive(body) else ["the applies item shows its case on the stage, with a scene or a directive"]
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

