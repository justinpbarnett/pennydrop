from __future__ import annotations

from typing import Any

from ....tracer import Trace
from .._support import DirectiveError, TracedRun

PROBE_POINTER = "probe"
COUNTED_EVENTS = ("comparisons", "swaps")

GUIDE = "\n".join([
    "The `array` Lab plays a trace as compares, swaps and writes on its cells.",
    "Set one `array` object with `values` equal to the input list, so the trace starts from known values. The counters `comparisons` and `swaps` are added for you.",
])


def apply(step: dict[str, Any], object_id: str, run: TracedRun) -> dict[str, Any]:
    array = step["scene"][object_id]
    values = _traced_list(run.input)
    if values is None or array.get("values") != values:
        raise DirectiveError(f"trace directive: array '{object_id}' must have values equal to the traced list {values}, found {array.get('values')}")
    return {
        **step,
        "scene": {**step["scene"], object_id: _with_counters(array)},
        "do": [*step.get("do", []), *_operations(run.trace, object_id)],
    }


def _traced_list(arguments: Any) -> list | None:
    if isinstance(arguments, dict):
        return next((item for item in arguments.values() if isinstance(item, list)), None)
    return arguments if isinstance(arguments, list) else None


def _with_counters(array: dict[str, Any]) -> dict[str, Any]:
    counters = array.get("counters", [])
    if isinstance(counters, dict):
        return {**array, "counters": {**{name: 0 for name in COUNTED_EVENTS}, **counters}}
    return {**array, "counters": [*counters, *(name for name in COUNTED_EVENTS if name not in counters)]}


def _operations(trace: Trace, array_id: str) -> list[dict[str, Any]]:
    cell = lambda index: f"{array_id}[{index}]"  # noqa: E731
    operations: list[dict[str, Any]] = []
    for event in trace.events:
        if event.type == "compare":
            if event.i is not None and event.j is not None:
                operations.append({"op": "compare", "on": [cell(event.i), cell(event.j)], "count": "comparisons"})
            else:
                probed = event.i if event.i is not None else event.j
                operations.append({"op": "pointer", "name": PROBE_POINTER, "on": [cell(probed)]})
                operations.append({"op": "counter", "on": [array_id], "name": "comparisons", "add": 1})
        elif event.type == "swap":
            operations.append({"op": "swap", "on": [cell(event.i), cell(event.j)], "count": "swaps"})
        elif event.type == "set":
            operations.append({"op": "set", "on": [cell(event.index)], "value": event.value})
    return operations
