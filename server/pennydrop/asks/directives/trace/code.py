from __future__ import annotations

import re
from typing import Any

from .._support import MAX_STEP_OPERATIONS, DirectiveError, TracedRun, plain_output, plain_repr

MARKER_FUNCTIONS = ("visit", "push", "pop", "relax")

GUIDE = "\n".join([
    "The `code` Lab steps the traced source line by line: a line marker, the call stack, the variables and the output.",
    'Set one object `{"lab":"code"}` in the Step. The directive fills in its `source` (the traced code, so line numbers match), `language` and `vars`, and writes every `line`, `call`, `set`, `return` and `print` operation from the real run.',
    "Never write `line`, `call`, `set`, `return` or `print` operations yourself: write `{\"trace\": {\"code\": \"<the function source>\", \"input\": {\"n\": 3}}}` and the whole run plays in that one Step, so give it a full 20 to 25 word narration that walks through the run. `input` maps each parameter name to its value.",
    "To show the code before it runs, write the name of the library algorithm you trace as `source` (`\"source\": \"<the library algorithm you trace>\"`), and the stage shows the exact code the trace will run. Trace it with that same name and the same `input` as the graph or array already on stage, so the run matches the picture. In the Step that carries `trace`, the code object always shows the traced algorithm, whatever `source` says, and it steps its lines in time with the array, graph or tree.",
    "Shape a Lesson on this Lab like this: early Steps explain the code with the object set in `scene`; one later Step, which sets the object again in its own `scene` and carries `trace`, plays the whole run with narration that follows it; the Steps after it recap and ask the Challenge.",
    "A Step plays at most 40 operations, and each executed line costs one or two. A longer run plays its first 40 operations and stops on a line, with the stack and variables exactly as the real run had them there, so for a long run narrate how it starts, and do not claim the final answer unless the input is tiny, such as factorial of 3 or a loop of 3 turns.",
])


def apply(step: dict[str, Any], object_id: str, run: TracedRun) -> dict[str, Any]:
    first_call = next((event for event in run.trace.events if event.type == "call"), None)
    if first_call is None:
        raise DirectiveError("trace directive: the traced code made no function call to step through")
    code = {"language": "python", **step["scene"][object_id], "vars": _traced_variables(run), "source": shown_source(run.source)}
    return {
        **step,
        "scene": {**step["scene"], object_id: code},
        "do": [*step.get("do", []), *_within_budget(_operations(run, object_id), MAX_STEP_OPERATIONS - len(step.get("do", [])))],
    }


def follow(step: dict[str, Any], object_id: str, run: TracedRun, data_operations: list[tuple[int, list[dict[str, Any]]]], lines_only: bool = False) -> dict[str, Any]:
    code = {"language": "python", **step["scene"][object_id], "vars": _traced_variables(run), "source": shown_source(run.source)}
    by_event = dict(data_operations)
    operations: list[dict[str, Any]] = [*by_event.get(-1, [])]
    frames: list[dict[str, Any]] = []
    on = [object_id]
    marker_depth = 0
    last_line = None
    final_position = max(by_event, default=-1)
    opened = False
    for position, event in enumerate(run.trace.events):
        if event.type in ("call", "return") and event.function in MARKER_FUNCTIONS:
            marker_depth += 1 if event.type == "call" else -1
        elif not marker_depth:
            if event.type == "call":
                frames.append(dict(event.arguments))
                if not lines_only or not opened:
                    opened = True
                    operations.append({"op": "call", "on": on, "name": event.function, "args": {name: plain_repr(value) for name, value in event.arguments.items()}})
            elif event.type == "line":
                last_line = event
            elif event.type == "return":
                if frames:
                    frames.pop()
                if not lines_only:
                    operations.append({"op": "return", "on": on, **({} if event.value is None else {"value": plain_repr(event.value)})})
            elif event.type == "print":
                operations.append({"op": "print", "on": on, "text": plain_output(event.text)})
        if position in by_event:
            if last_line is not None:
                known = frames[-1] if frames else {}
                for name, value in last_line.locals.items():
                    if (not lines_only or position == final_position) and (name not in known or known[name] != value):
                        operations.append({"op": "set", "on": on, "name": name, "value": plain_repr(value)})
                        known[name] = value
                operations.append({"op": "line", "on": on, "n": last_line.line - _stripped_lines(run.source)})
            operations.extend(by_event[position])
    return {**step, "scene": {**step["scene"], object_id: code}, "do": [*step.get("do", []), *operations]}


def _traced_variables(run: TracedRun) -> list[str]:
    names: dict[str, None] = {}
    marker_depth = 0
    for event in run.trace.events:
        if event.type in ("call", "return") and event.function in MARKER_FUNCTIONS:
            marker_depth += 1 if event.type == "call" else -1
        elif not marker_depth and event.type == "call":
            names.update(dict.fromkeys(event.arguments))
        elif not marker_depth and event.type == "line":
            names.update(dict.fromkeys(event.locals))
    return list(names)


def _stripped_lines(source: str) -> int:
    return len(source) - len(source.lstrip("\n"))


def shown_source(source: str) -> str:
    return re.split(rf"\n\n\ndef (?:{'|'.join(MARKER_FUNCTIONS)})\(", source, maxsplit=1)[0].strip("\n") + "\n"


def _within_budget(operations: list[dict[str, Any]], budget: int) -> list[dict[str, Any]]:
    if len(operations) <= budget:
        return operations
    lines = [index for index, operation in enumerate(operations[:budget]) if operation["op"] == "line"]
    return operations[: lines[-1] + 1] if lines else operations[:budget]


def _operations(run: TracedRun, object_id: str) -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    frames: list[dict[str, Any]] = []
    on = [object_id]
    marker_depth = 0
    for event in run.trace.events:
        if event.type in ("call", "return") and event.function in MARKER_FUNCTIONS:
            marker_depth += 1 if event.type == "call" else -1
            continue
        if marker_depth:
            continue
        if event.type == "call":
            frames.append(dict(event.arguments))
            operations.append({"op": "call", "on": on, "name": event.function, "args": {name: plain_repr(value) for name, value in event.arguments.items()}})
        elif event.type == "line":
            known = frames[-1] if frames else {}
            for name, value in event.locals.items():
                if name not in known or known[name] != value:
                    operations.append({"op": "set", "on": on, "name": name, "value": plain_repr(value)})
                    known[name] = value
            operations.append({"op": "line", "on": on, "n": event.line - _stripped_lines(run.source)})
        elif event.type == "return":
            if frames:
                frames.pop()
            operations.append({"op": "return", "on": on, **({} if event.value is None else {"value": repr(event.value)})})
        elif event.type == "print":
            operations.append({"op": "print", "on": on, "text": plain_output(event.text)})
    return operations
