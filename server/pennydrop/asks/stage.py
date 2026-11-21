from __future__ import annotations

import re
from typing import Any

from .directives._support import trace_key

SHOWN_TEXT_FIELDS = ("text", "caption", "label", "title")
LAB_KEY_PREFIX = "lab:"
STANDS_ALONE = r"(?<![\w.]){}(?![\w]|\.\d)"


STRUCTURE_FIELDS = ("nodes", "values", "items", "edges", "cells", "rows")
INSERTED = re.compile(r"\binsert(?:s|ed|ing)?\s+(?:the\s+|a\s+)?(?:value\s+|number\s+|key\s+|item\s+|element\s+)?(\w+)", re.IGNORECASE)
NUMBER_WORDS = {word: str(number) for number, word in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}


def _as_value(word: str) -> str:
    return NUMBER_WORDS.get(word.lower(), word.lower())


def _scalars(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [item for inner in value.values() for item in _scalars(inner)]
    if isinstance(value, list):
        return [item for inner in value for item in _scalars(inner)]
    return [] if value is None or isinstance(value, bool) else [str(value).lower()]


def _holds_nothing(spec: dict[str, Any]) -> bool:
    lists = [value for key, value in spec.items() if key != "parts" and isinstance(value, list)]
    return bool(lists) and not any(lists)


class Stage:
    def __init__(self, snapshot: Any = None):
        self.specs: dict[str, dict[str, Any]] = {}
        self.labs: dict[str, str] = {}
        self.traces: set[str] = set()
        self.trace_counters: dict[str, set[str]] = {}
        self.in_flight: set[str] = set()
        self.lost_runs = False
        self.retired: dict[str, dict[str, Any]] = {}
        for thing in (snapshot or {}).get("objects", []):
            key = str(thing.get("defKey", ""))
            if key.startswith(LAB_KEY_PREFIX):
                self.labs[thing["id"]] = key.removeprefix(LAB_KEY_PREFIX)

    def remember_trace(self, written: Any, settled: dict[str, Any]) -> None:
        key = trace_key(written.get("trace")) if isinstance(written, dict) else None
        if key is None:
            return
        self.traces.add(key)
        for name, spec in (settled.get("scene") or {}).items():
            counters = spec.get("counters") if isinstance(spec, dict) else None
            if counters:
                self.trace_counters[name] = {str(counter) for counter in counters}

    def errors_in_written(self, written: Any) -> list[str]:
        operations = written.get("do") if isinstance(written, dict) else None
        if not isinstance(operations, list) or not self.trace_counters:
            return []
        changed = {
            (target, counter)
            for operation in operations
            if isinstance(operation, dict)
            for target in (operation.get("on") if isinstance(operation.get("on"), list) else [])
            for counter in (operation.get("count"), operation.get("name") if operation.get("op") == "counter" else None)
            if isinstance(counter, str)
        }
        owned = sorted(f"{counter} on {name}" for name, counters in self.trace_counters.items() for counter in counters if (name, counter) in changed)
        return [f"the trace owns the counter {entry}, and its value is final; remove the operation that changes it, and let the narration state the trace's own count" for entry in owned]

    def on_stage(self) -> dict[str, dict[str, Any]]:
        return {name: self.specs.get(name, {"lab": lab}) for name, lab in self.labs.items() if not _holds_nothing(self.specs.get(name, {"lab": lab}))}

    def settle(self, step: dict[str, Any]) -> None:
        self.attach_parts(step)
        self.in_flight -= {name for name, spec in (step.get("scene") or {}).items() if not isinstance(spec, dict) or name in self.specs}
        for operation in step.get("do", []):
            targets = operation.get("on")
            if operation.get("op") in ("send", "retransmit", "receive", "drop") and isinstance(targets, list) and len(targets) == 1:
                (self.in_flight.add if operation["op"] in ("send", "retransmit") else self.in_flight.discard)(targets[0])
        for name, spec in (step.get("scene") or {}).items():
            if not isinstance(spec, dict):
                if name in self.specs:
                    self.retired[name] = self.specs[name]
                self.specs.pop(name, None)
                self.labs.pop(name, None)
                continue
            self.retired.pop(name, None)
            self.specs[name] = spec
            if isinstance(spec.get("lab"), str):
                self.labs[name] = spec["lab"]
            else:
                self.labs.pop(name, None)

    def attach_parts(self, step: dict[str, Any]) -> None:
        for operation in step.get("do", []):
            if operation.get("op") == "found" and operation.get("on", [None])[0] in self.specs:
                name = operation["on"][0]
                self.specs[name] = {**self.specs[name], "parts": operation.get("parts", [])}

    def errors_in(self, step: dict[str, Any], ran: bool = False) -> list[str]:
        return answer_given_away(step) + self._insert_already_shown(step) + self._empty_figures(step) + self.unran_values(step, ran)

    def _empty_figures(self, step: dict[str, Any]) -> list[str]:
        scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
        empty = [name for name, spec in scene.items() if isinstance(spec, dict) and isinstance(spec.get("lab"), str) and _holds_nothing(spec)]
        return [f"step {step.get('step')} scene: {name} is a {scene[name]['lab']} Lab figure with nothing in it; fill it with its data, or let a directive fill it, or remove it" for name in empty]

    def unran_values(self, step: dict[str, Any], ran: bool) -> list[str]:
        challenge = step.get("challenge")
        answer = challenge.get("answer") if isinstance(challenge, dict) else None
        if not self.lost_runs or ran or isinstance(answer, bool) or not isinstance(answer, int | float):
            return []
        return ["the challenge answer comes from a trace or simulation that a shipped Step never ran; first show the run in this Step (with the trace or simulate directive) and make the answer the value it ends with, or ask a Challenge that needs no run"]

    def _insert_already_shown(self, step: dict[str, Any]) -> list[str]:
        challenge = step.get("challenge")
        say = step.get("say")
        if not isinstance(challenge, dict) or not isinstance(say, str):
            return []
        scene = {name: spec for name, spec in {**self.specs, **(step.get("scene") or {})}.items() if isinstance(spec, dict)}
        shown = {value for spec in scene.values() for key in STRUCTURE_FIELDS for value in _scalars(spec.get(key))}
        announced = [value for value in map(_as_value, INSERTED.findall(say)) if value.isdigit()]
        already = [value for value in dict.fromkeys(announced) if value in shown]
        shown_errors = [
            f'this Step asks the viewer to predict an insert of {value}, but the Scene already shows {value}, so the frame gives the result away; show the structure without {value} here and let a later Step add it'
            for value in already
        ]
        replayed = [
            f'this Step asks the viewer to predict an insert of {value}, but an earlier Step already played that run with a trace, so the result is known; put the prediction in a Step before the Step that carries the trace'
            for value in dict.fromkeys(announced)
            if self.traces and value not in already
        ]
        return shown_errors + replayed


def answer_given_away(step: dict[str, Any]) -> list[str]:
    challenge = step.get("challenge")
    if not isinstance(challenge, dict):
        return []
    answer = challenge.get("answer")
    if isinstance(answer, bool) or not isinstance(answer, (int, float, str)):
        return []
    token = str(answer)
    if len(token) < (4 if isinstance(answer, str) else 2):
        return []
    shown = [step.get("say", ""), *_shown_texts(step.get("scene"))]
    pattern = re.compile(STANDS_ALONE.format(re.escape(token)), re.IGNORECASE)
    if not any(isinstance(text, str) and pattern.search(text) for text in shown):
        return []
    return [f'the Challenge answer "{token}" appears in this Step\'s narration or text; a Challenge Step asks the question and never states or hints at the answer, so reword "say" and any text without "{token}", and let the next Step reveal it']


def _shown_texts(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [item for key, inner in value.items() for item in ([inner] if key in SHOWN_TEXT_FIELDS else _shown_texts(inner))]
    if isinstance(value, list):
        return [item for inner in value for item in _shown_texts(inner)]
    return []
