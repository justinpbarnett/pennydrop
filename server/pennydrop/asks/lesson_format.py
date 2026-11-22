from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ..practice import FORMS, Direction, Form
from .directives import DIRECTIVES
from .writer_errors import describe


class Header(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = Field(min_length=1)
    point: str = ""
    goal: str = ""
    labs: list[str] = []
    start_scene: Any = None
    reading: bool = True


class StepOp(BaseModel):
    model_config = ConfigDict(extra="allow")

    cue: str | None = None
    op: str = Field(min_length=1)
    on: list[str] | None = None


class _Challenge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str | None = None


class _Prediction(_Challenge):
    kind: Literal["predict"]


class NumberChallenge(_Prediction):
    type: Literal["number"]
    answer: int | float


class ChoiceChallenge(_Prediction):
    type: Literal["choice"]
    choices: list[str] = Field(min_length=2)
    answer: str


class ClickChallenge(_Prediction):
    type: Literal["click"]
    answer: str | list[str]


class OrderChallenge(_Prediction):
    type: Literal["order"]
    choices: list[str] = Field(min_length=2)
    answer: list[str]


class MatchChallenge(_Prediction):
    type: Literal["match"]
    pairs: list[tuple[str, str]] = Field(min_length=2)
    answer: list[tuple[str, str]] | None = None


class YesNoChallenge(_Prediction):
    type: Literal["yesno"]
    answer: Literal["yes", "no"]


class WordsChallenge(_Challenge):
    kind: Literal["explain"]
    type: Literal["words"]


Challenge = Annotated[
    NumberChallenge | ChoiceChallenge | ClickChallenge | OrderChallenge | MatchChallenge | YesNoChallenge | WordsChallenge,
    Field(discriminator="type"),
]


class Step(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step: int
    say: str = Field(min_length=1)
    scene: dict[str, dict[str, Any] | None] | None = None
    do: list[StepOp] | None = None
    challenge: Challenge | None = None

    @field_validator("say")
    @classmethod
    def say_is_plain_words(cls, say: str) -> str:
        if "{" in say or "}" in say:
            raise ValueError(f"'say' still holds an unresolved placeholder in braces: {say!r}. A placeholder is filled only by a directive in the same Step")
        return say

    def as_wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude_none=True)


class PracticeItem(BaseModel):
    model_config = ConfigDict(extra="allow")

    form: Form
    say: str = Field(min_length=1)
    direction: Direction | None = None
    challenge: dict[str, Any]
    scene: dict[str, dict[str, Any] | None] = {}
    do: list[OperationShape] = []

    @field_validator("challenge")
    @classmethod
    def challenge_names_a_known_type(cls, challenge: dict[str, Any]) -> dict[str, Any]:
        if challenge.get("type") not in CHALLENGE_TYPES:
            raise ValueError(f"unknown challenge type {challenge.get('type')!r}. Use {', '.join(CHALLENGE_TYPES)}")
        return challenge

    @model_validator(mode="after")
    def direction_only_for_fresh(self) -> PracticeItem:
        if (self.form is Form.FRESH) != (self.direction is not None):
            raise ValueError("'direction' belongs to the fresh item and to no other")
        return self


class PracticeLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rule: str = Field(min_length=1)
    condition: str = Field(min_length=1)
    slots: list[str] = Field(min_length=1)
    challenges: list[PracticeItem]

    @model_validator(mode="after")
    def one_item_per_form_in_order(self) -> PracticeLine:
        if tuple(item.form for item in self.challenges) != FORMS:
            raise ValueError("'challenges' holds exactly one item per form, in the order say, applies, fresh")
        return self


class OperationShape(BaseModel):
    model_config = ConfigDict(extra="allow")

    op: str = Field(min_length=1)
    on: list[str] = []


class StepShape(BaseModel):
    model_config = ConfigDict(extra="allow")

    scene: dict[str, dict[str, Any] | None] = {}
    do: list[OperationShape] = []


@dataclass(frozen=True)
class Malformed:
    text: str
    reason: str


ParsedLine = Header | dict[str, Any] | Malformed
BAD_PRACTICE = "bad practice line: "


EXTRA_SHOWN = 60
CHALLENGE_TYPES = ("number", "choice", "click", "order", "match", "yesno", "words")
PRACTICE_FIELDS = "A practice line holds only rule, condition, slots and challenges"
MAX_STRAY_CLOSERS = 4


def parse_line(text: str) -> ParsedLine | None:
    stripped = text.strip()
    if "{" not in stripped:
        return None
    try:
        read, value, end = _decoded(stripped)
    except json.JSONDecodeError as error:
        return Malformed(stripped, f"the line is not valid JSON: {error}")
    read, value, end = _reopened(read, value, end)
    extra = read[end:].strip(" \t,]}")
    if extra:
        return Malformed(stripped, f"the line is not valid JSON: extra text after the object at character {end}, starting {extra[:EXTRA_SHOWN]!r}; write one complete JSON object per line and nothing after it")
    if not isinstance(value, dict):
        return Malformed(stripped, "the line is JSON but not an object")
    if "lesson" in value:
        try:
            return Header.model_validate(value["lesson"])
        except ValidationError as error:
            return Malformed(stripped, "bad lesson header: " + "; ".join(describe(error)))
    if "practice" in value:
        return _practice_line(stripped, value)
    value = _reshaped(value)
    try:
        StepShape.model_validate(value)
    except ValidationError as error:
        return Malformed(stripped, "bad Step: " + "; ".join(describe(error)))
    return value


def is_practice_line(parsed: ParsedLine) -> bool:
    return (isinstance(parsed, dict) and "practice" in parsed) or (isinstance(parsed, Malformed) and parsed.reason.startswith(BAD_PRACTICE))


def _practice_line(text: str, value: dict[str, Any]) -> dict[str, Any] | Malformed:
    body = value["practice"]
    if isinstance(body, dict) and isinstance(body.get("challenges"), list):
        body = {**body, "challenges": [_reshaped(item) if isinstance(item, dict) else item for item in body["challenges"]]}
    try:
        PracticeLine.model_validate(body)
    except ValidationError as error:
        return Malformed(text, BAD_PRACTICE + "; ".join(describe(error, PRACTICE_FIELDS)))
    return {"practice": body}


def _reshaped(step: dict[str, Any]) -> dict[str, Any]:
    step = _with_trace_out_of_scene(step)
    step = _without_operations_naming_a_carried_directive(step)
    step = _with_directives_out_of_operations(step)
    step = _with_trace_named_by_code(step)
    step = _with_until_in_staged_directive(step)
    return _without_empty_fields(step)


def _decoded(text: str) -> tuple[str, Any, int]:
    for _ in range(MAX_STRAY_CLOSERS):
        try:
            value, end = json.JSONDecoder().raw_decode(text)
            return text, value, end
        except json.JSONDecodeError as error:
            if not (error.msg.startswith("Expecting ',' delimiter") and text[error.pos : error.pos + 1] in ("}", "]")):
                raise
            text = text[: error.pos] + text[error.pos + 1 :]
    value, end = json.JSONDecoder().raw_decode(text)
    return text, value, end


def _reopened(text: str, value: Any, end: int) -> tuple[str, Any, int]:
    while isinstance(value, dict) and text[end:].lstrip(" \t,").startswith('"'):
        joined = text[: end - 1].rstrip() + ", " + text[end:].lstrip(" \t,")
        try:
            joined, merged, merged_end = _decoded(joined)
        except json.JSONDecodeError:
            break
        if not isinstance(merged, dict) or any(merged.get(key) != kept for key, kept in value.items()):
            break
        text, value, end = joined, merged, merged_end
    return text, value, end


def _without_empty_fields(step: dict[str, Any]) -> dict[str, Any]:
    empty = [name for name in (*DIRECTIVES, "scene", "do") if name in step and step[name] in (None, {}, [], "")]
    return {key: value for key, value in step.items() if key not in empty} if empty else step


def _with_trace_out_of_scene(step: dict[str, Any]) -> dict[str, Any]:
    scene = step.get("scene")
    inside = scene.get("trace") if isinstance(scene, dict) else None
    if not isinstance(inside, dict) or "trace" in step or not {"code", "input"} <= inside.keys() or {"lab", "kind"} & inside.keys():
        return step
    kept = {name: spec for name, spec in scene.items() if name != "trace"}
    return {**{key: value for key, value in step.items() if key != "scene"}, **({"scene": kept} if kept else {}), "trace": inside}


def _without_operations_naming_a_carried_directive(step: dict[str, Any]) -> dict[str, Any]:
    operations = step.get("do")
    if not isinstance(operations, list):
        return step
    kept = [operation for operation in operations if not (isinstance(operation, dict) and operation.get("op") in DIRECTIVES and operation["op"] in step and operation.keys() <= {"op", "on", "cue"})]
    return {**step, "do": kept} if len(kept) < len(operations) else step


def _with_directives_out_of_operations(step: dict[str, Any]) -> dict[str, Any]:
    operations = step.get("do")
    if not isinstance(operations, list):
        return step
    written = [(operation, found) for operation in operations if (found := _directive_written_as_operation(operation)) and found[0] not in step]
    directives = dict(found for _, found in written)
    if len(directives) < len(written):
        return step
    return {**step, "do": [operation for operation in operations if not any(operation is moved for moved, _ in written)], **directives}


def _directive_written_as_operation(operation: Any) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(operation, dict):
        return None
    if operation.get("op") in DIRECTIVES:
        return operation["op"], {key: value for key, value in operation.items() if key not in ("op", "on", "cue")}
    held = {name: spec for name in DIRECTIVES if (spec := _directive_spec(name, operation.get(name))) is not None}
    if "op" in operation or len(held) != 1:
        return None
    ((name, spec),) = held.items()
    beside = {key: value for key, value in operation.items() if key not in (name, "cue")}
    return name, {**beside, **spec}


def _directive_spec(name: str, value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    return {"code": value} if name == "trace" and isinstance(value, str) else None


def _with_trace_named_by_code(step: dict[str, Any]) -> dict[str, Any]:
    return {**step, "trace": {"code": step["trace"]}} if isinstance(step.get("trace"), str) else step


def _with_until_in_staged_directive(step: dict[str, Any]) -> dict[str, Any]:
    staged = [name for name in ("simulate", "trace") if isinstance(step.get(name), dict)]
    if "until" not in step or len(staged) != 1 or "until" in step[staged[0]]:
        return step
    return {**{key: value for key, value in step.items() if key != "until"}, staged[0]: {**step[staged[0]], "until": step["until"]}}
