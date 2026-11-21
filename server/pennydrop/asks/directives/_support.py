from __future__ import annotations

import importlib
import json
import re
import pkgutil
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from ...pictures import PartLocator, PictureFinder
from ...tracer import Trace, Tracer
from ..lesson_format import describe


MAX_STEP_OPERATIONS = 40


class DirectiveError(ValueError):
    pass


@dataclass(frozen=True)
class DirectiveTools:
    tracer: Tracer
    images: PictureFinder
    locator: PartLocator
    lesson_id: str | None = None
    young_child: bool = False
    staged: dict[str, dict[str, Any]] = field(default_factory=dict)
    traced: frozenset[str] = frozenset()
    pictures: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True)
class TracedRun:
    trace: Trace
    input: Any
    source: str


@dataclass(frozen=True)
class Simulation:
    object_id: str
    scene: dict[str, Any]
    operations: list[dict[str, Any]]
    values: dict[str, int | float | str]


def trace_key(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    return json.dumps({"code": raw.get("code"), "input": raw.get("input")}, sort_keys=True, default=str)


def limit_operations(directive: str, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(operations) > MAX_STEP_OPERATIONS:
        raise DirectiveError(f"{directive} directive: this needs {len(operations)} operations and a Step plays at most {MAX_STEP_OPERATIONS}; use a smaller example")
    return operations


def discover(package: ModuleType) -> dict[str, ModuleType]:
    return {
        found.name: importlib.import_module(f"{package.__name__}.{found.name}")
        for found in pkgutil.iter_modules(package.__path__)
        if not found.name.startswith("_")
    }


def parse_spec(model: type[BaseModel], raw: Any, directive: str):
    try:
        return model.model_validate(raw)
    except ValidationError as error:
        raise DirectiveError(f"{directive} directive: " + "; ".join(describe(error))) from None


SHOWN_DECIMALS = 6
LONG_FRACTION = re.compile(rf"\d+\.\d{{{SHOWN_DECIMALS + 1},}}")


def plain_text(value: Any) -> str:
    if isinstance(value, float):
        return f"{round(value, SHOWN_DECIMALS):.{SHOWN_DECIMALS}f}".rstrip("0").rstrip(".")
    if isinstance(value, list):
        return "[" + ", ".join(plain_text(item) if isinstance(item, float) else repr(item) for item in value) + "]"
    return str(value)


def plain_repr(value: Any) -> str:
    if isinstance(value, float):
        return plain_text(value)
    if isinstance(value, list) and any(isinstance(item, float) for item in value):
        return plain_text(value)
    return repr(value)


def plain_output(text: str) -> str:
    return LONG_FRACTION.sub(lambda found: plain_text(float(found.group())), text)


def fill_values(step: dict[str, Any], values: dict[str, int | float | str]) -> dict[str, Any]:
    shown = {"{" + name + "}": plain_text(value) for name, value in values.items()}
    filled = _each_text(step, lambda text: _filled(text, shown))
    challenge = filled.get("challenge")
    if isinstance(challenge, dict) and isinstance(challenge.get("answer"), str) and challenge["answer"] in values:
        filled["challenge"] = {**challenge, "answer": values[challenge["answer"]]}
    return filled


NOT_PLURALS = {"series", "species"}


def _filled(text: str, shown: dict[str, str]) -> str:
    ones = [token for token, value in shown.items() if value == "1" and token in text]
    if ones:
        counted = re.compile("(" + "|".join(map(re.escape, ones)) + r")(\s+)([a-z]+s)\b")
        text = counted.sub(lambda found: found[1] + found[2] + _singular(found[3]), text)
    for token, value in shown.items():
        text = text.replace(token, value)
    return text


def _singular(noun: str) -> str:
    if noun in NOT_PLURALS or noun.endswith(("ss", "us", "is")):
        return noun
    if noun.endswith("ies"):
        return noun[:-3] + "y"
    return noun[:-2] if noun.endswith(("xes", "ches", "shes", "zes", "sses")) else noun[:-1]


def _each_text(value: Any, change: Callable[[str], str]) -> Any:
    if isinstance(value, str):
        return change(value)
    if isinstance(value, list):
        return [_each_text(item, change) for item in value]
    if isinstance(value, dict):
        return {key: _each_text(item, change) for key, item in value.items()}
    return value
