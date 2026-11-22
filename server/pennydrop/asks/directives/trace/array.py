from __future__ import annotations

from typing import Any

from .._support import DirectiveError, TracedRun
from ._stages import Window, loop_turns

PROBE_POINTER = "probe"
COUNTED_EVENTS = ("comparisons", "swaps", "writes")

OPERATIONS = frozenset({"compare", "pointer", "counter", "swap", "set", "window", "sorted"})

GUIDE = "\n".join([
    "The `array` Lab plays a trace as compares, swaps and writes on its cells.",
    "Set one `array` object with `values` equal to the input list, so the trace starts from known values. The counters `comparisons`, `swaps` and `writes` are added for you when the algorithm changes them, so name no counters yourself.",
    "The trace also draws what the algorithm keeps in its range: a bracket over the cells still in play, such as the live low to high range of binary_search and quick_sort, and a sorted mark on each cell that reaches its final place, such as the pivot of quick_sort, so set no `window` or `sorted` on a traced array either.",
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
    framed: tuple[int, int] | None = None
    settled: set[int] = set()
    found: list[tuple[int, list[dict[str, Any]]]] = []
    last_line = None
    for position, event in enumerate(run.trace.events):
        operations: list[dict[str, Any]] = []
        if event.type == "line":
            moved = [(name, index) for name in run.pointers if _is_slot(index := event.locals.get(name), len(values)) and pointed.get(name) != index]
            pointed.update(moved)
            operations = [{"op": "pointer", "name": name, "on": [cell(index)]} for name, index in moved]
            frame = _range_of(run.window, event.locals, len(values))
            if frame and frame != framed:
                framed = frame
                operations.append({"op": "window", "on": [cell(frame[0]), cell(frame[1])]})
            looped_back = last_line is not None and last_line.stack == event.stack and last_line.line > event.line
            _add(found, position - 1 if looped_back else position, operations)
            last_line = event
            continue
        if event.type == "call" and run.placed and last_line is not None and event.function == last_line.stack[-1]:
            index = last_line.locals.get(run.placed)
            if _is_slot(index, len(values)) and index not in settled:
                settled.add(index)
                operations.append({"op": "sorted", "on": [cell(index)]})
        elif event.type == "compare":
            operations = _compare_operations(event, array_id)
        elif event.type == "swap":
            values[event.i], values[event.j] = values[event.j], values[event.i]
            operations.append({"op": "swap", "on": [cell(event.i), cell(event.j)], "count": "swaps"})
            if run.trace.counters.writes:
                operations.append(_writes(array_id, 2))
        elif event.type == "set":
            if event.index >= len(values) or values[event.index] != event.value:
                if event.index < len(values):
                    values[event.index] = event.value
                operations.append({"op": "set", "on": [cell(event.index)], "value": event.value, "count": "writes"})
            else:
                operations.append(_writes(array_id, 1))
        _add(found, position, operations)
    _add(found, len(run.trace.events) - 1, _closing(found, run, array_id, framed is not None))
    return found


def _writes(array_id: str, amount: int) -> dict[str, Any]:
    return {"op": "counter", "on": [array_id], "name": "writes", "add": amount}


def _is_slot(index: Any, size: int) -> bool:
    return isinstance(index, int) and not isinstance(index, bool) and 0 <= index < size


def _range_of(names: tuple[str, str] | None, scope: dict[str, Any], size: int) -> tuple[int, int] | None:
    if names is None:
        return None
    low, high = (scope.get(name) for name in names)
    return (low, high) if _is_slot(low, size) and _is_slot(high, size) and low <= high else None


def _compare_operations(event: Any, array_id: str) -> list[dict[str, Any]]:
    if event.i is not None and event.j is not None:
        return [{"op": "compare", "on": [f"{array_id}[{event.i}]", f"{array_id}[{event.j}]"], "count": "comparisons"}]
    probed = event.i if event.i is not None else event.j
    probe = {"op": "pointer", "name": PROBE_POINTER, "on": [f"{array_id}[{probed}]"]}
    return [probe, {"op": "counter", "on": [array_id], "name": "comparisons", "add": 1}] if event.counted else [probe]


def _closing(found: list[tuple[int, list[dict[str, Any]]]], run: TracedRun, array_id: str, framed: bool) -> list[dict[str, Any]]:
    moved = any(operation["op"] in ("compare", "swap") for _, operations in found for operation in operations)
    closing = [{"op": "clear", "on": [array_id]}] if moved else []
    if run.placed:
        closing += [*([{"op": "clear", "on": [array_id], "what": "window"}] if framed else []), {"op": "sorted", "on": [array_id]}]
    return closing


def _add(found: list[tuple[int, list[dict[str, Any]]]], position: int, operations: list[dict[str, Any]]) -> None:
    if not operations:
        return
    last = found[-1][1][-1] if found else None
    if len(operations) == 1 and _same_counter(last, operations[0]):
        last["add"] += operations[0]["add"]
        return
    if found and found[-1][0] == position:
        found[-1][1].extend(operations)
    else:
        found.append((position, operations))


def _same_counter(last: dict[str, Any] | None, operation: dict[str, Any]) -> bool:
    return last is not None and last["op"] == operation["op"] == "counter" and last["on"] == operation["on"] and last["name"] == operation["name"]
