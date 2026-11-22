from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from ....tracer import ALGORITHMS, Tracer
from .._support import TracedRun
from . import TARGETS, TraceSpec, _run, _with_search_target, outline_lab

MAX_LISTED = 6
CODE_LINE_ROOM = 12
CODE_OBJECT_WARNING = " Show no `code` object beside it: a code object adds a line operation for every step of the run, and a turn of this run would then pass the 40 operation limit of a Step."
_OUTLINES: dict[str, str] = {}


@dataclass(frozen=True)
class Turn:
    operations: list[dict[str, Any]]
    run: TracedRun
    end: int
    values: list[Any]


async def run_outline(algorithm: str, tracer: Tracer) -> str:
    if algorithm not in _OUTLINES:
        _OUTLINES[algorithm] = await _outline(algorithm, tracer)
    return _OUTLINES[algorithm]


async def _outline(algorithm: str, tracer: Tracer) -> str:
    example = ALGORITHMS[algorithm].example
    spec = _with_search_target(TraceSpec(code=algorithm, input=example))
    run = await _run(spec, tracer)
    lab = outline_lab(algorithm)
    turns = _turns(run, lab, example)
    told = [f'- "until": {number} adds: {TURN_TEXT[lab](turn)}' for number, turn in enumerate(turns, 1)]
    return _brief(spec, run, lab, turns, told)


def _turns(run: TracedRun, lab: str, example: Any) -> list[Turn]:
    target = TARGETS[lab]
    by_event = target.operations_by_event(run, "stage") if lab != "code" else []
    event_count = len(run.trace.events)
    stops = target.turns(run)
    bounds = [0, *stops[1:], event_count] if stops else [0, event_count]
    values = list(_array_of(example)) if lab == "array" else []
    return [
        Turn([operation for position, found in by_event if _falls_in(position, start, end) for operation in found], run, end, values)
        for start, end in zip(bounds, bounds[1:])
    ]


def _falls_in(position: int, start: int, end: int) -> bool:
    return start <= position < end or (_before_first_event(position) and start == 0)


def _before_first_event(position: int) -> bool:
    return position < 0


def _brief(spec: TraceSpec, run: TracedRun, lab: str, turns: list[Turn], told: list[str]) -> str:
    algorithm = spec.code
    example = ALGORITHMS[algorithm].example
    shown = json.dumps({"code": algorithm, "input": example})
    stage = STAGES[lab].format(values=json.dumps(_array_of(example)), source=algorithm)
    crowded = any(len(turn.operations) > CODE_LINE_ROOM for turn in turns)
    alone = CODE_OBJECT_WARNING if crowded else ""
    return "\n".join([
        f"Real run to teach: the Ask is about {ALGORITHMS[algorithm].summary}. The server already ran it on a fixed example, and it has {len(told)} turns. Carry exactly `\"trace\": {shown}` in every Step that moves the run, on {stage}, and write none of its operations by hand.{alone} Use exactly this input and never values of your own, so that each Step narrates only the turns it plays and every number matches the stage. Step 1 carries the trace with \"until\": 0, each later Step plays more turns with a later \"until\" taken from the list below, and the Step that plays the end leaves \"until\" out.",
        *told,
        _ending(spec, run),
    ])


STAGES = {
    "array": "one `array` object whose `values` are {values}",
    "graph": 'one `{{"lab":"graph"}}` object with no nodes or edges',
    "code": 'one `code` object whose `source` is "{source}"',
}


def _array_of(example: Any) -> list[Any]:
    return next((item for item in example.values() if isinstance(item, list)), []) if isinstance(example, dict) else example


def _index(on: str) -> int:
    return int(re.search(r"\[(\d+)\]", on).group(1))


def _array_turn(turn: Turn) -> str:
    operations, values = turn.operations, turn.values
    before = list(values)
    held = len({operation["on"][1] for operation in operations if operation["op"] == "compare"}) == 1
    probes: list[str] = []
    compares: list[tuple[Any, Any]] = []
    swaps: list[tuple[Any, Any]] = []
    writes: list[str] = []
    for operation in operations:
        kind = operation["op"]
        if kind == "pointer" and operation["name"] == "probe":
            probe = f"checks {values[_index(operation['on'][0])]} at index {_index(operation['on'][0])}"
            if probe not in probes:
                probes.append(probe)
        elif kind == "compare":
            first, second = (_index(on) for on in operation["on"])
            compares.append((values[first], before[second] if held else values[second]))
        elif kind == "swap":
            first, second = (_index(on) for on in operation["on"])
            swaps.append((values[first], values[second]))
            values[first], values[second] = values[second], values[first]
        elif kind == "set":
            writes.append(f"{operation['value']} at index {_index(operation['on'][0])}")
            values[_index(operation["on"][0])] = operation["value"]
    parts = [*probes, *_compare_text(compares), *_swap_text(swaps)]
    if writes:
        parts.append(f"writes {', '.join(writes)}" if len(writes) <= MAX_LISTED else f"writes {len(writes)} values")
    moved = values != before
    return "; ".join(parts) + (f"; the array is then {json.dumps(values)}" if moved else "") if parts else "nothing moves, the loop ends"


def _compare_text(compares: list[tuple[Any, Any]]) -> list[str]:
    if not compares:
        return []
    if len(compares) > 1 and len({second for _, second in compares}) == 1:
        firsts = [first for first, _ in compares]
        return [f"compares {_listed(firsts)} with {compares[0][1]}" if len(firsts) <= MAX_LISTED + 2 else f"compares {len(firsts)} values with {compares[0][1]}"]
    if len(compares) > MAX_LISTED:
        return [f"{len(compares)} comparisons of neighbors"]
    return ["compares " + ", ".join(f"{first} with {second}" for first, second in compares)]


def _swap_text(swaps: list[tuple[Any, Any]]) -> list[str]:
    if not swaps:
        return []
    if len(swaps) > 3:
        return [f"{len(swaps)} swaps"]
    return ["swaps " + ", ".join(f"{first} with {second}" for first, second in swaps)]


def _listed(items: list[Any]) -> str:
    names = [str(item) for item in items]
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


GRAPH_VERBS = {"push": "pushes", "pop": "pops", "visit": "visits"}


def _graph_turn(turn: Turn) -> str:
    sentences: list[str] = []
    grouped: list[tuple[str, list[str]]] = []
    for operation in turn.operations:
        kind = operation["op"]
        if kind == "dist":
            sentences.append(f"sets the distance of {operation['node']} to {operation['value']}")
        elif kind == "relax":
            grouped.append((kind, [f"{operation['from']} to {operation['to']} with distance {operation['dist']}"]))
        else:
            name = f"{operation['node']} (key {operation['key']})" if "key" in operation else str(operation["node"])
            if grouped and grouped[-1][0] == kind:
                grouped[-1][1].append(name)
            else:
                grouped.append((kind, [name]))
    sentences.extend(f"{GRAPH_VERBS.get(kind, 'relaxes')} {_listed(names)}" for kind, names in grouped)
    return ", then ".join(sentences)


def _code_turn(turn: Turn) -> str:
    run, end = turn.run, turn.end
    after = next((event for event in run.trace.events[end:] if event.type == "line"), None) if end < len(run.trace.events) else None
    event = after or next(event for event in reversed(run.trace.events) if event.type == "line")
    scalars = {name: value for name, value in event.locals.items() if isinstance(value, int | float | str)}
    return "after it " + ", ".join(f"{name} is {json.dumps(value)}" for name, value in scalars.items()) if scalars else "the loop runs once more"


TURN_TEXT = {"array": _array_turn, "graph": _graph_turn, "code": _code_turn}


def _ending(spec: TraceSpec, run: TracedRun) -> str:
    counters = {name: getattr(run.trace.counters, name) for name in ("comparisons", "swaps", "writes")}
    totals = [f"{count} {name}" for name, count in counters.items() if count and (name != "writes" or not counters["swaps"])]
    has_target = isinstance(spec.input, dict) and "target" in spec.input
    searched = ""
    if has_target and spec.code == "binary_search":
        searched = f" It searches for {spec.input['target']}, the last value."
    returned = ""
    result = run.trace.result
    if result is not None:
        returned = f" It returns {json.dumps(result)}"
        if isinstance(result, int) and has_target:
            returned += f", the index of {spec.input['target']}."
        else:
            returned += "."
    if not totals:
        return f"The run ends.{searched}{returned}"
    return f"The whole run makes {', '.join(totals)}.{searched}{returned}"
