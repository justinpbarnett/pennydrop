from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ....tracer import ALGORITHMS, Tracer
from ....tracer.library import BREAK, NORMAL_CASE
from .._support import MAX_STEP_OPERATIONS, TracedRun, trace_key
from ._stages import Window
from .array import COUNTED_EVENTS
from . import CONTRAST_RUN, MAIN_RUN, SEARCHES, TARGETS, TraceSpec, _run, _with_search_target, code, outline_lab

MAX_LISTED = 6
CODE_LINE_ROOM = 12
CODE_OBJECT_WARNING = f" Show no `code` object beside it: a code object adds a line operation for every step of the run, and a turn of this run would then pass the {MAX_STEP_OPERATIONS} operation limit of a Step."
CODE_OBJECT = "code"
GRAPH_BESIDE_CODE = "The Ask asks to see the code run, and a graph and the code each fill the stage, so this Lesson plays the run on the code object alone: show no `graph` object, and let the code's variables, such as the queue, the stack and the visited nodes, show where the run is. Narrate the lines the code runs as well as what they do."
SPINE_PART = {
    (NORMAL_CASE, True): "the normal case, in the Steps right after the promise, where the cost its own counter shows is the break, so say that cost plainly before the main run solves it",
    (NORMAL_CASE, False): "the normal case, in the Steps right after the promise, where the order it plays shows the break, so say plainly what that order gets wrong before the main run solves it",
    (BREAK, True): "the break, in the Steps after the main run's normal case, where the learner's assumption fails",
    (BREAK, False): "the break, in the Steps after the main run's normal case, where the learner's assumption fails",
}
SIDE_BY_SIDE_LABS = frozenset({"array"})
_OUTLINES: dict[tuple[str, bool], Outline] = {}


@dataclass(frozen=True)
class Outline:
    brief: str
    side_runs: frozenset[str] = frozenset()
    main_first: bool = False
    kept_on_stage: frozenset[str] = frozenset()
    hinge: tuple[str, int] | None = None


@dataclass(frozen=True)
class Turn:
    operations: list[dict[str, Any]]
    run: TracedRun
    end: int
    values: list[Any]
    cost: int


@dataclass(frozen=True)
class Told:
    spec: TraceSpec
    run: TracedRun
    lab: str
    turns: list[Turn]
    code_beside: bool = False

    def lines(self, prefix: str) -> list[str]:
        return [f'- {prefix}"until": {number} adds: {TURN_TEXT[self.lab](turn)}' for number, turn in enumerate(self.turns, 1)]

    def stops(self, hinge: int | None = None) -> list[int]:
        stops: list[int] = []
        played = 0
        for number, turn in enumerate(self.turns, 1):
            if played and played + turn.cost > MAX_STEP_OPERATIONS:
                stops.append(number - 1)
                played = 0
            played += turn.cost
            if number == hinge and number < len(self.turns):
                stops.append(number)
                played = 0
        return stops

    def hinge(self, counted: bool) -> int:
        settling = [number for number, turn in enumerate(self.turns, 1) if any(not counted or operation.get("op") == "compare" for operation in turn.operations)]
        return (settling[-1] if settling else len(self.turns)) - 1

    def key(self) -> str:
        return trace_key({"code": self.spec.code, "input": self.spec.input}) or ""

    def parted_from(self, other: Told) -> int | None:
        return next((index for index, (mine, theirs) in enumerate(zip(self.order(), other.order())) if mine != theirs), None)

    def order(self) -> list[str | None]:
        return [next((str(operation["node"]) for operation in turn.operations if operation.get("op") != "push" and "node" in operation), None) for turn in self.turns]

    def crowded(self) -> bool:
        return self.lab != "code" and not self.code_beside and any(len(turn.operations) > CODE_LINE_ROOM for turn in self.turns)


async def run_outline(algorithm: str, tracer: Tracer, shows_code: bool = False) -> Outline:
    key = (algorithm, shows_code and outline_lab(algorithm) != "code")
    if key not in _OUTLINES:
        _OUTLINES[key] = await _outline(algorithm, tracer, key[1])
    return _OUTLINES[key]


async def _outline(algorithm: str, tracer: Tracer, shows_code: bool) -> Outline:
    known = ALGORITHMS[algorithm]
    lab = outline_lab(algorithm)
    if shows_code and lab == "graph":
        main = await _told(algorithm, known.example, tracer, "code", False)
        return Outline("\n".join([*_run_brief(main, None, main.stops()), GRAPH_BESIDE_CODE]))
    contrast = known.contrast
    if not contrast:
        main = await _told(algorithm, known.example, tracer, lab, shows_code)
        return Outline("\n".join(_run_brief(main, None, main.stops())))
    main, side = await asyncio.gather(_told(algorithm, known.example, tracer, lab, shows_code), _told(contrast.algorithm, contrast.input, tracer, outline_lab(contrast.algorithm), False))
    return _contrast_outline(main, side, contrast)


async def _told(algorithm: str, example: Any, tracer: Tracer, lab: str, shows_code: bool) -> Told:
    spec = _with_search_target(TraceSpec(code=algorithm, input=example))
    run = await _run(spec, tracer)
    if shows_code:
        followed = _turns(run, lab, example, code_beside=True)
        if all(turn.cost <= MAX_STEP_OPERATIONS for turn in followed):
            return Told(spec, run, lab, followed, code_beside=True)
    return Told(spec, run, lab, _turns(run, lab, example, code_beside=False))


def _turns(run: TracedRun, lab: str, example: Any, code_beside: bool) -> list[Turn]:
    target = TARGETS[lab]
    by_event = target.operations_by_event(run, "stage")
    event_count = len(run.trace.events)
    stops = target.turns(run)
    bounds = [0, *stops[1:], event_count] if stops else [0, event_count]
    values = list(_array_of(example)) if lab == "array" else []
    turns = []
    for start, end in zip(bounds, bounds[1:]):
        window = Window(start, end, finished=False)
        operations = window.of(by_event)
        cost = _followed_cost(run, by_event, window) if code_beside else len(operations)
        turns.append(Turn(operations, run, end, values, cost))
    return turns


def _followed_cost(run: TracedRun, by_event: list[tuple[int, list[dict[str, Any]]]], window: Window) -> int:
    full = len(code.follow({"do": []}, CODE_OBJECT, run, by_event, window)["do"])
    return full if full <= MAX_STEP_OPERATIONS else len(code.follow({"do": []}, CODE_OBJECT, run, by_event, window, lines_only=True)["do"])


def _contrast_outline(main: Told, side: Told, contrast: Any) -> Outline:
    beside = main.lab in SIDE_BY_SIDE_LABS and side.lab in SIDE_BY_SIDE_LABS
    counted = bool(main.run.trace.counters.comparisons and side.run.trace.counters.comparisons)
    asked, other = (main, side) if contrast.serves == NORMAL_CASE else (side, main)
    parted = None if counted else asked.parted_from(other)
    hinge = parted or asked.hinge(counted)
    main_stops = main.stops(hinge if asked is main else None)
    side_stops = side.stops(hinge if asked is side else None)
    brief = "\n".join([*_run_brief(main, MAIN_RUN, main_stops), *_contrast_brief(side, contrast, side_stops, main.code_beside, counted, beside), _story_order(main, side, contrast, counted, beside, bool(parted), hinge, len(main_stops) + len(side_stops) + 3)])
    return Outline(
        brief,
        frozenset({side.key()}),
        contrast.serves != NORMAL_CASE,
        frozenset({MAIN_RUN, CONTRAST_RUN}) if beside else frozenset(),
        (asked.key(), hinge) if parted else None,
    )


def _staging(run: str, stops: list[int]) -> str:
    if not stops:
        return f'The whole {run} fits one Step, so the Step that plays it leaves "until" out; to tell it in two or three Steps, stop the earlier ones at any "until" from its list.'
    shown = ", then ".join(f'"until": {stop}' for stop in stops)
    return f'Play the {run} in {len(stops) + 1} Steps, with {shown}, then no "until" for the Step that plays the end. Each stop keeps a Step within the {MAX_STEP_OPERATIONS} operations it may play, so use every one of these stops and never play past the next one; a Step may stop sooner at an "until" between two of them, and the Step after it plays on to the next stop.'


def _run_brief(told: Told, named: str | None, stops: list[int]) -> list[str]:
    spec = told.spec
    example = ALGORITHMS[spec.code].example
    shown = json.dumps({"code": spec.code, "input": example, **({"on": named} if named else {})})
    stage = STAGES[told.lab].format(values=json.dumps(_array_of(example)), source=spec.code, named=f' with the id "{named}"' if named else "")
    if told.code_beside:
        stage += f', and beside it, from Step 1 to the last Step, {STAGES["code"].format(source=spec.code, named=f' with the id "{CODE_OBJECT}"')}, which steps the code line by line in time with the run, since the Ask asks to see the code run; narrate the lines the code runs as well as what they do'
    alone = CODE_OBJECT_WARNING if told.crowded() else ""
    return [
        f"Real run to teach: the Ask is about {ALGORITHMS[spec.code].summary}. The server already ran it on a fixed example, and it has {len(told.turns)} turns. Carry exactly `\"trace\": {shown}` in every Step that moves the run, on {stage}, and write none of its operations by hand.{alone} Use exactly this input and never values of your own, so that each Step narrates only the turns it plays and every number matches the stage. Step 1 carries the trace with \"until\": 0. {_staging("main run" if named else "run", stops)} Its turns are:",
        *told.lines(""),
        _ending(told),
        *_promise_hint(spec.code),
    ]


def _promise_hint(algorithm: str) -> list[str]:
    promise = ALGORITHMS[algorithm].promise
    return [f'Step 1, the promise, can be as close to this as the Ask allows, which is one question in the learner\'s own world of at most 14 words: "{promise}"'] if promise else []


def _contrast_brief(told: Told, contrast: Any, stops: list[int], code_beside: bool, counted: bool, beside: bool) -> list[str]:
    spec = told.spec
    shown = json.dumps({"code": spec.code, "input": contrast.input, "on": CONTRAST_RUN})
    stage = STAGES[told.lab].format(values=json.dumps(_array_of(contrast.input)), source=spec.code, named=f' with the id "{CONTRAST_RUN}"')
    if told.lab == "array":
        stage += f' and whose `counters` are {json.dumps([name for name in COUNTED_EVENTS if getattr(told.run.trace.counters, name)])}, the ones its run counts, so the two counters match from Step 1'
    placed = (
        f"Play it beside the main run, on a second object, {stage}"
        if beside
        else f"Play it on a second object, {stage}. The stage fits one {told.lab} at a time, so a Step that brings one run on stage sets the other run's object to null, and a run that comes back replays its trace from the start up to its stop"
    )
    staying = "keep both objects on stage through to the last Step, never setting either to null, so that the two runs side by side are the proof" if beside else "the two runs never share the stage, so the proof is the two orders told one after the other"
    proof = (
        f"{staying}: the last Step highlights the two counters while it says the point. Say a total with the run's own placeholder, {{trace.{MAIN_RUN}.comparisons}} for the main run and {{trace.{CONTRAST_RUN}.comparisons}} for the contrast run, never the plain {{trace.comparisons}}. Name no total in the Step before the hinge that the learner is asked to predict."
        if counted
        else f"{staying}: the last Step says the point over the main run's finished {told.lab} and names both orders. These runs count nothing, so name no total and use no placeholder; tell each run by the order it plays."
    )
    alone = " The code object steps only the main run, so a Step that plays the contrast run leaves the code where the main run left it." if code_beside else CODE_OBJECT_WARNING if told.crowded() else ""
    return [
        f"Contrast run, which serves {SPINE_PART[contrast.serves, counted]}: {contrast.why}. It is {ALGORITHMS[spec.code].summary}, and it has {len(told.turns)} turns. {placed}, and carry exactly `\"trace\": {shown}` in every Step that plays it.{alone} A Step carries one trace, so each Step plays one of the two runs, and a Step that returns to a run repeats that run's whole trace. {_staging("contrast run", stops)} Its turns are:",
        *told.lines("contrast "),
        _ending(told),
        f"Show the contrast run in its own Steps for that part of the story, and {proof}",
    ]


def _story_order(main: Told, side: Told, contrast: Any, counted: bool, beside: bool, parted: bool, hinge: int, least_steps: int) -> str:
    versus = f"the hinge is a choice Challenge, its answer is \"{_more_or_fewer(main, side, contrast.serves)}\" and its Step never says it" if counted else "the hinge Challenge asks what the run does at its next turn, and its Step never says it"
    next_turn = "at its next turn, the first turn where its order parts from the other run's, so the answer is the node where the two orders differ" if parted else "at its last turn"
    asked_break = "whether the contrast run will end with more, fewer or the same comparisons as the main run, which it has already finished" if counted else f"which node the contrast run takes {next_turn}"
    asked = "whether the main run will end with more, fewer or the same comparisons as the contrast run" if counted else f"which node the main run takes {next_turn}"
    last = "the last Step highlights the main run's counter and the contrast run's counter, which both stay on stage, while it says the point" if counted else f"the last Step says the point over the main run's finished {main.lab} and names both orders"
    shown = "so its counter shows its total, and say what that costs" if counted else "so its whole order shows, and say what that order gets wrong"
    compared = "the two totals" if counted else "the two orders"
    start = 'Step 1 is the promise, with the main trace at "until": 0' + (" and the contrast object on stage beside it" if beside else "")
    if contrast.serves == NORMAL_CASE:
        order = f'{start}; the next Steps play the whole contrast run at its stops, {shown}; the next Steps play the main run; the hinge Step plays the main run up to "until": {hinge}, then asks the learner to predict {asked}; {versus}; the reveal Step plays the rest of the main run and compares {compared}; {last}'
    else:
        order = f'{start}; the next Steps play the main run, which is the normal case; then the contrast run plays at its stops, which is the break; the hinge Step plays the contrast run up to "until": {hinge}, then asks the learner to predict {asked_break}; {versus}; the reveal Step plays the end of the contrast run and compares {compared}; {last}'
    return f'Suggested order of the Steps: {order}. With the promise, these stops make {least_steps} Steps, so add at most {max(0, 8 - least_steps)} more and keep the Lesson within 8 Steps. The order is a guide, and the Steps in it must follow from one another by cause.'


def _more_or_fewer(main: Told, side: Told, serves: str) -> str:
    mine, theirs = main.run.trace.counters.comparisons, side.run.trace.counters.comparisons
    asked, other = (mine, theirs) if serves == NORMAL_CASE else (theirs, mine)
    return "more" if asked > other else "fewer" if asked < other else "the same"


STAGES = {
    "array": "one `array` object{named} whose `values` are {values}",
    "graph": 'one `{{"lab":"graph"}}` object{named} with no nodes or edges',
    "code": 'one `code` object{named} whose `source` is "{source}"',
}


def _array_of(example: Any) -> list[Any]:
    return next((item for item in example.values() if isinstance(item, list)), []) if isinstance(example, dict) else example


def _index(on: str) -> int:
    return int(re.search(r"\[(\d+)\]", on).group(1))


@dataclass
class Moves:
    values: list[Any]
    before: list[Any]
    pivot_held: bool
    probes: list[str] = field(default_factory=list)
    compares: list[tuple[Any, Any]] = field(default_factory=list)
    swaps: list[tuple[Any, Any]] = field(default_factory=list)
    writes: list[str] = field(default_factory=list)
    placed: list[str] = field(default_factory=list)
    frame: tuple[int, int] | None = None

    def told(self) -> list[str]:
        moved = self.values != self.before
        return [
            *self.probes,
            *_compare_text(self.compares),
            *_swap_text(self.swaps),
            *_write_text(self.writes),
            *self.placed,
            *([f"the array is then {json.dumps(self.values)}"] if moved else []),
            *([_range_text(self.frame)] if self.frame else []),
        ]


def _probe(moves: Moves, operation: dict[str, Any]) -> None:
    if operation["name"] != "probe":
        return
    slot = _index(operation["on"][0])
    probe = f"checks {moves.values[slot]} at index {slot}"
    if probe not in moves.probes:
        moves.probes.append(probe)


def _compare(moves: Moves, operation: dict[str, Any]) -> None:
    first, second = (_index(on) for on in operation["on"])
    moves.compares.append((moves.values[first], moves.before[second] if moves.pivot_held else moves.values[second]))


def _swap(moves: Moves, operation: dict[str, Any]) -> None:
    first, second = (_index(on) for on in operation["on"])
    moves.swaps.append((moves.values[first], moves.values[second]))
    moves.values[first], moves.values[second] = moves.values[second], moves.values[first]


def _write(moves: Moves, operation: dict[str, Any]) -> None:
    slot = _index(operation["on"][0])
    moves.writes.append(f"{operation['value']} at index {slot}")
    moves.values[slot] = operation["value"]


def _place(moves: Moves, operation: dict[str, Any]) -> None:
    if not re.search(r"\[\d+\]", operation["on"][0]):
        moves.placed.append("the whole array is now in its final order")
        return
    slot = _index(operation["on"][0])
    moves.placed.append(f"{moves.values[slot]} is in its final place at index {slot}")


def _frame(moves: Moves, operation: dict[str, Any]) -> None:
    moves.frame = (_index(operation["on"][0]), _index(operation["on"][1]))


def _unframe(moves: Moves, operation: dict[str, Any]) -> None:
    if operation.get("what") == "window":
        moves.frame = None


ARRAY_MOVES: dict[str, Callable[[Moves, dict[str, Any]], None]] = {"pointer": _probe, "compare": _compare, "swap": _swap, "set": _write, "sorted": _place, "window": _frame, "clear": _unframe}


def _array_turn(turn: Turn) -> str:
    compared = {operation["on"][1] for operation in turn.operations if operation["op"] == "compare"}
    moves = Moves(turn.values, list(turn.values), pivot_held=len(compared) == 1)
    for operation in turn.operations:
        ARRAY_MOVES.get(operation["op"], lambda *_: None)(moves, operation)
    return "; ".join(moves.told()) or "nothing moves, the loop ends"


def _range_text(frame: tuple[int, int]) -> str:
    low, high = frame
    return f"the range is now index {low} alone" if low == high else f"the range is now index {low} to {high}"


def _write_text(writes: list[str]) -> list[str]:
    if not writes:
        return []
    return [f"writes {', '.join(writes)}" if len(writes) <= MAX_LISTED else f"writes {len(writes)} values"]


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


def _ending(told: Told) -> str:
    spec, run = told.spec, told.run
    counters = {name: getattr(run.trace.counters, name) for name in ("comparisons", "swaps", "writes")}
    written = any(operation["op"] == "set" for turn in told.turns for operation in turn.operations)
    totals = [f"{count} {name}" for name, count in counters.items() if count and (name != "writes" or (written and not counters["swaps"]))]
    has_target = isinstance(spec.input, dict) and "target" in spec.input
    searched = f" It searches for {spec.input['target']}, the last value." if has_target and spec.code in SEARCHES else ""
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
