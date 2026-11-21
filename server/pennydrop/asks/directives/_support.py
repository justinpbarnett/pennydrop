from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from types import ModuleType
from typing import Any

from pydantic import BaseModel, ValidationError

from ...tracer import Tracer
from ..lesson_format import describe


class DirectiveError(ValueError):
    pass


@dataclass(frozen=True)
class DirectiveTools:
    tracer: Tracer


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


def fill_values(step: dict[str, Any], values: dict[str, int | float]) -> dict[str, Any]:
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
