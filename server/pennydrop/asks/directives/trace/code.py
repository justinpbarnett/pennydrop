from __future__ import annotations

import re
from typing import Any

from .._support import DirectiveError, TracedRun, plain_output, plain_repr
from ._stages import Window, loop_turns

MARKER_FUNCTIONS = ("visit", "push", "pop", "relax")
OPERATIONS = frozenset({"line", "call", "set", "return", "print"})

GUIDE = "\n".join([
    "The `code` Lab steps the traced source line by line: a line marker, the call stack, the variables and the output.",
    'Set one object `{"lab":"code"}` in the Step. The directive fills in its `source` (the traced code, so line numbers match), `language` and `vars`, and writes every `line`, `call`, `set`, `return` and `print` operation from the real run.',
    "Never write `line`, `call`, `set`, `return` or `print` operations yourself: write `{\"trace\": {\"code\": \"<the function source>\", \"input\": {\"n\": 3}}}`, where `input` maps each parameter name to its value.",
    "To show the code before it runs, write the name of the library algorithm you trace as `source` (`\"source\": \"<the library algorithm you trace>\"`), and the stage shows the exact code the trace will run. Trace it with that same name and the same `input` as the graph or array already on stage, so the run matches the picture. In the Step that carries `trace`, the code object always shows the traced algorithm, whatever `source` says, and it steps its lines in time with the array, graph or tree.",
    "A Step plays at most 40 operations, and each executed line costs one or two, so a function with a loop tells its run in stages with `until`, a turn or two of the loop per Step.",
    "A function with no loop of its own, such as a recursive factorial, plays whole: past 40 operations it stops on a line, with the stack and variables exactly as the real run had them there, so narrate how it starts, and claim the final answer only for a tiny input such as factorial of 3.",
])


def apply(step: dict[str, Any], object_id: str, run: TracedRun, window: Window) -> dict[str, Any]:
    first_call = next((event for event in run.trace.events if event.type == "call"), None)
    if first_call is None:
        raise DirectiveError("trace directive: the traced code made no function call to step through")
    code = {"language": "python", **step["scene"][object_id], "vars": _traced_variables(run), "source": shown_source(run.source)}
    return {
        **step,
        "scene": {**step["scene"], object_id: code},
        "do": [*step.get("do", []), *window.of(operations_by_event(run, object_id))],
    }


def turns(run: TracedRun) -> list[int]:
    return loop_turns(run)


def follow(step: dict[str, Any], object_id: str, run: TracedRun, data_operations: list[tuple[int, list[dict[str, Any]]]], window: Window, lines_only: bool = False) -> dict[str, Any]:
    by_event = dict(data_operations)
    operations: list[dict[str, Any]] = [*by_event.get(-1, [])] if window.holds(-1) else []
    frames: list[dict[str, Any]] = []
    on = [object_id]
    marker_depth = 0
    last_line = None
    final_position = max((position for position in by_event if window.holds(position)), default=-1)
    opened = False
    for position, event in enumerate(run.trace.events[: window.end]):
        shown = window.holds(position)
        if event.type in ("call", "return") and event.function in MARKER_FUNCTIONS:
            marker_depth += 1 if event.type == "call" else -1
        elif not marker_depth:
            if event.type == "call":
                frames.append(dict(event.arguments))
                if shown and (not lines_only or not opened):
                    operations.append({"op": "call", "on": on, "name": event.function, "args": {name: plain_repr(value) for name, value in event.arguments.items()}})
                opened = True
            elif event.type == "line":
                last_line = event
            elif event.type == "return":
                if shown and not lines_only and last_line is not None:
                    operations.extend(_stepped_to(last_line, frames[-1] if frames else {}, on, run))
                last_line = None
                if frames:
                    frames.pop()
                if shown and not lines_only:
                    operations.append({"op": "return", "on": on, **({} if event.value is None else {"value": plain_repr(event.value)})})
            elif event.type == "print" and shown:
                operations.append({"op": "print", "on": on, "text": plain_output(event.text)})
        if position in by_event:
            if last_line is not None:
                known = frames[-1] if frames else {}
                for name, value in last_line.locals.items():
                    if name in known and known[name] == value:
                        continue
                    if not shown:
                        known[name] = value
                    elif not lines_only or position == final_position:
                        operations.append({"op": "set", "on": on, "name": name, "value": plain_repr(value)})
                        known[name] = value
                if shown:
                    operations.append({"op": "line", "on": on, "n": last_line.line - _stripped_lines(run.source)})
            if shown:
                operations.extend(by_event[position])
    if final_position >= 0 and not marker_depth:
        operations.extend(_caught_up(run, window.end, frames[-1] if frames else {}, on))
    return {**step, "do": [*step.get("do", []), *operations]}


def _stepped_to(line: Any, known: dict[str, Any], on: list[str], run: TracedRun) -> list[dict[str, Any]]:
    changed = {name: value for name, value in line.locals.items() if name not in known or known[name] != value}
    known.update(changed)
    return [*({"op": "set", "on": on, "name": name, "value": plain_repr(value)} for name, value in changed.items()), {"op": "line", "on": on, "n": line.line - _stripped_lines(run.source)}]


def _caught_up(run: TracedRun, end: int, known: dict[str, Any], on: list[str]) -> list[dict[str, Any]]:
    resumes_at = run.trace.events[end] if end < len(run.trace.events) else None
    if resumes_at is None or resumes_at.type != "line":
        return []
    changed = [{"op": "set", "on": on, "name": name, "value": plain_repr(value)} for name, value in resumes_at.locals.items() if name not in known or known[name] != value]
    return [*changed, {"op": "line", "on": on, "n": resumes_at.line - _stripped_lines(run.source)}]


def drawn(step: dict[str, Any], object_id: str, run: TracedRun) -> dict[str, Any]:
    code = {"language": "python", **step["scene"][object_id], "vars": _traced_variables(run), "source": shown_source(run.source)}
    return {**step, "scene": {**step["scene"], object_id: code}}


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


def within_budget(operations: list[dict[str, Any]], budget: int) -> list[dict[str, Any]]:
    if len(operations) <= budget:
        return operations
    lines = [index for index, operation in enumerate(operations[:budget]) if operation["op"] == "line"]
    return operations[: lines[-1] + 1] if lines else operations[:budget]


def operations_by_event(run: TracedRun, object_id: str) -> list[tuple[int, list[dict[str, Any]]]]:
    found: list[tuple[int, list[dict[str, Any]]]] = []
    frames: list[dict[str, Any]] = []
    on = [object_id]
    marker_depth = 0
    for position, event in enumerate(run.trace.events):
        if event.type in ("call", "return") and event.function in MARKER_FUNCTIONS:
            marker_depth += 1 if event.type == "call" else -1
            continue
        if marker_depth:
            continue
        operations: list[dict[str, Any]] = []
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
        if operations:
            found.append((position, operations))
    return found
