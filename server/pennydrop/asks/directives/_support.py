from __future__ import annotations

import importlib
import json
import re
import pkgutil
from collections.abc import Iterator
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from ...pictures import PartLocator, PictureFinder
from ...tracer import Trace, Tracer
from ..writer_errors import describe


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
    played: tuple[tuple[str, dict[str, Any]], ...] = ()


@dataclass(frozen=True)
class TracedRun:
    trace: Trace
    input: Any
    source: str
    pointers: tuple[str, ...] = ()
    window: tuple[str, str] | None = None
    placed: str | None = None
    settles: str | None = None


@dataclass(frozen=True)
class Simulation:
    object_id: str
    scene: dict[str, Any]
    timeline: list[tuple[int, dict[str, Any]]]
    values: dict[str, int | float | str]
    known_at: dict[str, int] = field(default_factory=dict)
    objects: dict[str, Any] = field(default_factory=dict)
    until: int | None = None
    stops: dict[int, str] = field(default_factory=dict)
    run: str | None = None
    side_by_side: bool = False

    def stop(self, moment: int) -> str:
        return self.stops.get(moment, str(moment))

    def value_names(self) -> dict[str, str]:
        return {key: name for name in self.values for key in (f"simulate.{name}", *([f"simulate.{self.run}.{name}"] if self.run else []))}


def operation_targets(operation: dict[str, Any]) -> set[str]:
    targets = operation.get("on")
    return {str(target).split("[")[0] for target in targets} if isinstance(targets, list) else set()


def with_nested_trace_lifted(raw: Any) -> Any:
    nested = raw.get("trace") if isinstance(raw, dict) else None
    if not isinstance(nested, dict):
        return raw
    return {**nested, **{key: value for key, value in raw.items() if key != "trace"}}


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


def parse_spec(model: type[BaseModel], raw: Any, directive: str, read_before: tuple[str, ...] = ()):
    try:
        return model.model_validate(raw)
    except ValidationError as error:
        fields = f"The {directive} directive takes only {', '.join([*read_before, *model.model_fields])}"
        raise DirectiveError(f"{directive} directive: " + "; ".join(describe(error, fields))) from None


SHOWN_DECIMALS = 6
SPOKEN_FIGURES = 3
SPOKEN_WHOLE_FROM = 100
LONG_FRACTION = re.compile(rf"\d+\.\d{{{SHOWN_DECIMALS + 1},}}")


def plain_text(value: Any) -> str:
    if isinstance(value, float):
        return f"{round(value, SHOWN_DECIMALS):.{SHOWN_DECIMALS}f}".rstrip("0").rstrip(".")
    if isinstance(value, list):
        return "[" + ", ".join(plain_text(item) if isinstance(item, float) else repr(item) for item in value) + "]"
    return str(value)


def spoken_text(value: Any) -> str:
    if isinstance(value, float) and abs(value) >= SPOKEN_WHOLE_FROM:
        return str(round(value))
    if isinstance(value, float):
        return plain_text(float(f"{value:.{SPOKEN_FIGURES}g}"))
    return plain_text(value)


def plain_repr(value: Any) -> str:
    if isinstance(value, float):
        return plain_text(value)
    if isinstance(value, list) and any(isinstance(item, float) for item in value):
        return plain_text(value)
    return repr(value)


def plain_output(text: str) -> str:
    return LONG_FRACTION.sub(lambda found: plain_text(float(found.group())), text)


def fill_values(step: dict[str, Any], values: dict[str, int | float | str]) -> dict[str, Any]:
    named = {**_bare_names(values), **values}
    shown = {"{" + name + "}": plain_text(value) for name, value in named.items()}
    spoken = {"{" + name + "}": spoken_text(value) for name, value in named.items()}
    filled = {key: _each_text(item, lambda text, key=key: _filled(text, spoken if key == "say" else shown)) for key, item in step.items()}
    challenge = filled.get("challenge")
    if isinstance(challenge, dict) and isinstance(challenge.get("answer"), str) and challenge["answer"] in values:
        filled["challenge"] = {**challenge, "answer": values[challenge["answer"]]}
    return filled


NOT_PLURALS = {"series", "species"}
SINGULAR_VERBS = {"were": "was", "are": "is", "have": "has"}


def _bare_names(values: dict[str, int | float | str]) -> dict[str, int | float | str]:
    by_bare: dict[str, list[str]] = {}
    for name in values:
        if "." in name:
            by_bare.setdefault(name.split(".", 1)[1], []).append(name)
    return {bare: values[names[0]] for bare, names in by_bare.items() if len(names) == 1}


def _filled(text: str, shown: dict[str, str]) -> str:
    ones = [token for token, value in shown.items() if value == "1" and token in text]
    if ones:
        counted = re.compile("(" + "|".join(map(re.escape, ones)) + r")(\s+)([a-z]+s)\b(?:(\s+)(were|are|have)\b)?")
        text = counted.sub(lambda found: found[1] + found[2] + _singular(found[3]) + (found[4] + SINGULAR_VERBS[found[5]] if found[5] else ""), text)
    for token, value in shown.items():
        text = text.replace(token, value)
    return text


PLACEHOLDER = re.compile(r"\{(\w+(?:\.\w+)+)\}")
VALUE_NAME = re.compile(r"\w+(?:\.\w+)+")


def unclear_values(step: dict[str, Any], known: dict[str, Any], on_stage: set[str]) -> list[str]:
    errors: list[str] = []
    for name in _value_names_in(step):
        kind, _, rest = name.partition(".")
        run, _, value = rest.rpartition(".")
        runs = sorted(key for key in known if key.count(".") == 2 and key.startswith(f"{kind}.") and key.rsplit(".", 1)[1] == value)
        if run and name not in known and (run in on_stage or any(key.startswith(f"{kind}.{run}.") for key in known)):
            errors.append(f"{{{name}}} is not known by this Step, because the {run} run has not played far enough to compute it; play that run further in this Step or an earlier one, or leave the number out, and never state another run's value in its place")
        elif run and name not in known and (played := ", ".join(sorted({key.split(".")[1] for key in known if key.count(".") == 2 and key.startswith(f"{kind}.")}))):
            errors.append(f"{{{name}}} names no run played by this Step, and the runs played so far are {played}; if the Step means one of those, write that run's name, and otherwise play the {run} run in an earlier Step or leave the number out, but never state another run's value in its place")
        elif not run and len({str(known[key]) for key in runs}) > 1:
            listed = ", ".join("{" + key + "}" for key in runs)
            errors.append(f"{{{name}}} differs between the runs played so far ({listed}), so the Step would give the latest run's number whichever run it means; write the name of the run it means, as in {listed}")
    return errors


def _value_names_in(step: dict[str, Any]) -> list[str]:
    challenge = step.get("challenge")
    answer = challenge.get("answer") if isinstance(challenge, dict) else None
    named = [answer] if isinstance(answer, str) and VALUE_NAME.fullmatch(answer) else []
    return sorted({*named, *(name for text in _texts_in(step) for name in PLACEHOLDER.findall(text))})


def values_used(step: dict[str, Any], names: list[str]) -> list[str]:
    said = values_said(step, names)
    return [name for name in names if name in said or _answer(step) == name]


def values_said(step: dict[str, Any], names: list[str]) -> list[str]:
    texts = list(_texts_in(step))
    return [name for name in names if any("{" + name + "}" in text for text in texts)]


def with_answer_from(step: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    answer = _answer(step)
    if not isinstance(answer, str) or answer not in values:
        return step
    return {**step, "challenge": {**step["challenge"], "answer": values[answer]}}


def _answer(step: dict[str, Any]) -> Any:
    challenge = step.get("challenge")
    return challenge.get("answer") if isinstance(challenge, dict) else None


def _texts_in(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list | dict):
        for item in value.values() if isinstance(value, dict) else value:
            yield from _texts_in(item)


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
