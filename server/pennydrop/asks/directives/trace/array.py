from __future__ import annotations

from typing import Any

from .._support import DirectiveError, TracedRun
from ._stages import Window, loop_turns

PROBE_POINTER = "probe"
COUNTED_EVENTS = ("comparisons", "swaps")

OPERATIONS = frozenset({"compare", "pointer", "counter", "swap", "set"})

GUIDE = "\n".join([
    "The `array` Lab plays a trace as compares, swaps and writes on its cells.",
    "Set one `array` object with `values` equal to the input list, so the trace starts from known values. The counters `comparisons` and `swaps` are added for you when the algorithm changes them, so name no counters yourself.",
    "The trace slides the pointers its algorithm keeps, such as `boundary` and `j` for partition and quick_sort, under the cells they index, so set no `pointers` on a traced array: a pointer the run does not move would stand still while the narration moves on.",
])


def apply(step: dict[str, Any], object_id: str, run: TracedRun, window: Window) -> dict[str, Any]:
    array = step["scene"][object_id]
    values = _traced_list(run.input)
    if values is None or array.get("values") != values:
        raise DirectiveError(f"trace directive: array '{object_id}' must have values equal to the traced list {values}, found {array.get('values')}")
    if array.get("pointers"):
        moved = f"slides its own pointers, {' and '.join(run.pointers)}," if run.pointers else "moves no pointers"
        raise DirectiveError(f"trace directive: the traced array '{object_id}' sets pointers, and the run {moved} so a pointer you set would stand still; leave \"pointers\" out of the array")
    return {
        **step,
        "scene": {**step["scene"], object_id: _with_counters(array, [name for name in COUNTED_EVENTS if getattr(run.trace.counters, name)])},
        "do": [*step.get("do", []), *window.of(operations_by_event(run, object_id))],
    }


def turns(run: TracedRun) -> list[int]:
    return loop_turns(run)


def holds_input(array: dict[str, Any], arguments: Any) -> bool:
    values = _traced_list(arguments)
    return values is not None and array.get("values") == values


def _traced_list(arguments: Any) -> list | None:
    if isinstance(arguments, dict):
        return next((item for item in arguments.values() if isinstance(item, list)), None)
    return arguments if isinstance(arguments, list) else None


def _with_counters(array: dict[str, Any], changing: list[str]) -> dict[str, Any]:
    counters = array.get("counters", [])
    still = lambda name: name in COUNTED_EVENTS and name not in changing  # noqa: E731
    if isinstance(counters, dict):
        return {**array, "counters": {**{name: 0 for name in changing}, **{name: value for name, value in counters.items() if not still(name)}}}
    return {**array, "counters": [*(name for name in counters if not still(name)), *(name for name in changing if name not in counters)]}


def operations_by_event(run: TracedRun, array_id: str) -> list[tuple[int, list[dict[str, Any]]]]:
    cell = lambda index: f"{array_id}[{index}]"  # noqa: E731
    values = list(_traced_list(run.input) or [])
    pointed: dict[str, int] = {}
    found: list[tuple[int, list[dict[str, Any]]]] = []
    last_line = None
    for position, event in enumerate(run.trace.events):
        operations: list[dict[str, Any]] = []
        if event.type == "line":
            moved = [(name, index) for name in run.pointers if isinstance(index := event.locals.get(name), int) and 0 <= index < len(values) and pointed.get(name) != index]
            pointed.update(moved)
            looped_back = last_line is not None and last_line.stack == event.stack and last_line.line > event.line
            _add(found, position - 1 if looped_back else position, [{"op": "pointer", "name": name, "on": [cell(index)]} for name, index in moved])
            last_line = event
            continue
        if event.type == "compare":
            if event.i is not None and event.j is not None:
                operations.append({"op": "compare", "on": [cell(event.i), cell(event.j)], "count": "comparisons"})
            else:
                probed = event.i if event.i is not None else event.j
                operations.append({"op": "pointer", "name": PROBE_POINTER, "on": [cell(probed)]})
                if event.counted:
                    operations.append({"op": "counter", "on": [array_id], "name": "comparisons", "add": 1})
        elif event.type == "swap":
            values[event.i], values[event.j] = values[event.j], values[event.i]
            operations.append({"op": "swap", "on": [cell(event.i), cell(event.j)], "count": "swaps"})
        elif event.type == "set" and (event.index >= len(values) or values[event.index] != event.value):
            if event.index < len(values):
                values[event.index] = event.value
            operations.append({"op": "set", "on": [cell(event.index)], "value": event.value})
        _add(found, position, operations)
    if any(operation["op"] in ("compare", "swap") for _, operations in found for operation in operations):
        _add(found, len(run.trace.events) - 1, [{"op": "clear", "on": [array_id]}])
    return found


def _add(found: list[tuple[int, list[dict[str, Any]]]], position: int, operations: list[dict[str, Any]]) -> None:
    if not operations:
        return
    if found and found[-1][0] == position:
        found[-1][1].extend(operations)
    else:
        found.append((position, operations))
