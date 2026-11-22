from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


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

    kind: Literal["predict"]
    prompt: str | None = None


class NumberChallenge(_Challenge):
    type: Literal["number"]
    answer: int | float


class ChoiceChallenge(_Challenge):
    type: Literal["choice"]
    choices: list[str] = Field(min_length=2)
    answer: str


class ClickChallenge(_Challenge):
    type: Literal["click"]
    answer: str | list[str]


class OrderChallenge(_Challenge):
    type: Literal["order"]
    choices: list[str] = Field(min_length=2)
    answer: list[str]


class MatchChallenge(_Challenge):
    type: Literal["match"]
    pairs: list[tuple[str, str]] = Field(min_length=2)
    answer: list[tuple[str, str]] | None = None


Challenge = Annotated[
    NumberChallenge | ChoiceChallenge | ClickChallenge | OrderChallenge | MatchChallenge,
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


def parse_line(text: str) -> ParsedLine | None:
    stripped = text.strip()
    if not stripped or stripped.startswith("```"):
        return None
    try:
        value, end = json.JSONDecoder().raw_decode(stripped)
    except json.JSONDecodeError as error:
        return Malformed(stripped, f"the line is not valid JSON: {error}")
    if stripped[end:].strip(" \t,]}"):
        return Malformed(stripped, f"the line is not valid JSON: extra text after the object at character {end}")
    if not isinstance(value, dict):
        return Malformed(stripped, "the line is JSON but not an object")
    if "lesson" in value:
        try:
            return Header.model_validate(value["lesson"])
        except ValidationError as error:
            return Malformed(stripped, "bad lesson header: " + "; ".join(describe(error)))
    try:
        StepShape.model_validate(value)
    except ValidationError as error:
        return Malformed(stripped, "bad Step: " + "; ".join(describe(error)))
    return value


def describe(error: ValidationError) -> list[str]:
    messages = []
    for item in error.errors():
        where = ".".join(str(part) for part in item["loc"])
        if item["type"] == "extra_forbidden":
            messages.append(f"{where}: unknown field. A Step holds only step, say, scene, do, challenge and its directives")
        elif item["type"] == "union_tag_invalid":
            messages.append(f"{where}: unknown challenge type. Use number, choice, click, order or match")
        else:
            messages.append(f"{where}: {item['msg']}")
    return messages
