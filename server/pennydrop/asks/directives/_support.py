from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from types import ModuleType
from typing import Any

from pydantic import BaseModel, ValidationError

from ...tracer import Trace, Tracer
from ..lesson_format import describe


MAX_STEP_OPERATIONS = 40


class DirectiveError(ValueError):
    pass


@dataclass(frozen=True)
class DirectiveTools:
    tracer: Tracer


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


def fill_values(step: dict[str, Any], values: dict[str, int | float | str]) -> dict[str, Any]:
    filled = _fill_text(step, {"{" + name + "}": str(value) for name, value in values.items()})
    challenge = filled.get("challenge")
    if isinstance(challenge, dict) and challenge.get("answer") in values:
        filled["challenge"] = {**challenge, "answer": values[challenge["answer"]]}
    return filled


def _fill_text(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        for token, text in replacements.items():
            value = value.replace(token, text)
        return value
    if isinstance(value, list):
        return [_fill_text(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _fill_text(item, replacements) for key, item in value.items()}
    return value
