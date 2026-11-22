from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ....tracer import ALGORITHMS, Tracer
from ....tracer.library import FOUND, NEXT_LOOK, NORMAL_CASE, PLACED, SHORTEST_HOME, Contrast
from .._support import MAX_STEP_OPERATIONS, Hinge, Runs, TracedRun, trace_key, with_answer
from ._stages import Window
from .array import COUNTED_EVENTS, PROBE_POINTER
from . import CONTRAST_RUN, MAIN_RUN, SEARCHES, TARGETS, TraceSpec, _run, _with_search_target, code, outline_lab

MAX_LISTED = 6
CODE_LINE_ROOM = 12
CELL = re.compile(r"\[(\d+)\]")
CODE_OBJECT_WARNING = f" Show no `code` object beside it: a code object adds a line operation for every step of the run, and a turn of this run would then pass the {MAX_STEP_OPERATIONS} operation limit of a Step."
CODE_OBJECT = "code"
GRAPH_BESIDE_CODE = "The Ask asks to see the code run, and a graph and the code each fill the stage, so this Lesson plays the run on the code object alone: show no `graph` object, and let the code's variables, such as the queue, the stack and the visited nodes, show where the run is. Narrate the lines the code runs as well as what they do."
SIDE_BY_SIDE_LABS = frozenset({"array"})
KID_RUN = "bars"
KID_HINGE = 1
_OUTLINES: dict[tuple[str, bool], Outline] = {}
_KID_OUTLINES: dict[str, Outline | None] = {}


@dataclass(frozen=True)
class Outline:
    brief: str
    runs: Runs = Runs()
    point: str | None = None


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
    example: Any
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

    def hinge(self, total: str | None) -> int:
        settling = [number for number, turn in enumerate(self.turns, 1) if any(total is None or _adds_to(operation, total) for operation in turn.operations)]
        return (settling[-1] if settling else len(self.turns)) - 1

    def landing(self, number: int) -> tuple[int, Any] | None:
        turn = self.turns[number - 1]
        cells = [_index(operation["on"][0]) for operation in turn.operations if operation["op"] == "sorted" and CELL.search(operation["on"][0])]
        return (cells[-1], _played(turn.values, turn.operations).values[cells[-1]]) if cells else None

    def key(self) -> str:
        return trace_key({"code": self.spec.code, "input": self.example}) or ""

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


async def kid_outline(algorithm: str, tracer: Tracer) -> Outline | None:
    if algorithm not in _KID_OUTLINES:
        _KID_OUTLINES[algorithm] = await _kid_outline(algorithm, tracer)
    return _KID_OUTLINES[algorithm]


async def _kid_outline(algorithm: str, tracer: Tracer) -> Outline | None:
    known = ALGORITHMS[algorithm]
    kid = known.kid
    if kid is None:
        return None
    told = await _told(algorithm, kid.example, tracer, "array", False)
    answer = f"{KID_RUN}[{KID_ANSWERS[kid.answer](told)}]"
    shown = json.dumps({"code": algorithm, "input": kid.example, "on": KID_RUN})
    hinge = Hinge(told.key(), KID_RUN, KID_HINGE, f'the predict Challenge of type "click" that asks the child to tap {kid.question}', answer)
    last_stop = len(kid.reveal) - 1
    point = f"{kid.point[0].upper()}{kid.point[1:]}."
    reveal = [f"Step {4 + offset} plays the run {f'to \"until\": {KID_HINGE + 1 + offset}' if offset < last_stop else 'to its end, with no \"until\"'}, and {said}" for offset, said in enumerate(kid.reveal)]
    brief = [
        f"Real run to tell: the Ask is about {known.summary}. The server already ran it on fixed bars, and it has {len(told.turns)} turns. Carry exactly `\"trace\": {shown}` in every Step that plays it, on one `array` object with the id \"{KID_RUN}\" whose `values` are {json.dumps(_array_of(kid.example))}, which a child sees as bars as tall as their values, and write none of its operations by hand. Its turns are:",
        *told.lines(""),
        _ending(told),
        f'Tell it in this order: Step 1 brings in the bars with the trace at "until": 0, plays nothing, and its narration asks the child\'s own question, told about bars, and says that {kid.opening}; Step 2 plays {kid.first_turn}, with "until": {KID_HINGE}; Step 3 keeps "until": {KID_HINGE} and is {hinge.asked}, and its narration asks only that, without giving the answer or saying anything else about the bars; {"; ".join(reveal)}; and the last Step, Step {4 + len(reveal)}, says the point in a child\'s words. The Lesson\'s "point" is "{point}", word for word.',
        "A child sees bars as tall as their values and no numbers, so speak of bars, how tall they are and where they stand, never of a number, an index, a cell, an array, a pointer or a comparison, and never name the algorithm. Say only what the bars on stage do, and bring in no other search or sort the stage does not play. Never ask a child how many: a child answers by tapping a bar or a spot.",
    ]
    return Outline("\n".join(brief), Runs(hinge=hinge, told=frozenset({told.key()})), point)


def _shortest_home(told: Told) -> int:
    values = told.turns[0].values
    return sorted(values).index(min(values))


def _next_look(told: Told) -> int:
    return next(_index(operation["on"][0]) for operation in told.turns[KID_HINGE].operations if operation["op"] == "pointer" and operation.get("name") == PROBE_POINTER)


def _found(told: Told) -> int:
    return next(_index(operation["on"][0]) for turn in told.turns for operation in turn.operations if operation["op"] == "found")


KID_ANSWERS: dict[str, Callable[[Told], int]] = {SHORTEST_HOME: _shortest_home, NEXT_LOOK: _next_look, FOUND: _found}


async def _outline(algorithm: str, tracer: Tracer, shows_code: bool) -> Outline:
    known = ALGORITHMS[algorithm]
    lab = outline_lab(algorithm)
    if shows_code and lab == "graph":
        main = await _told(algorithm, known.example, tracer, "code", False)
        return Outline("\n".join([*_run_brief(main, None, main.stops()), GRAPH_BESIDE_CODE]), Runs(told=frozenset({main.key()})))
    contrast = known.contrast
    if not contrast:
        main = await _told(algorithm, known.example, tracer, lab, shows_code)
        return Outline("\n".join(_run_brief(main, None, main.stops())), Runs(told=frozenset({main.key()})))
    main, side = await asyncio.gather(_told(algorithm, known.example, tracer, lab, shows_code), _told(contrast.algorithm, contrast.input, tracer, outline_lab(contrast.algorithm), False))
    return _contrast_outline(main, side, contrast)


async def _told(algorithm: str, example: Any, tracer: Tracer, lab: str, shows_code: bool) -> Told:
    spec = _with_search_target(TraceSpec(code=algorithm, input=example))
    run = await _run(spec, tracer)
    if shows_code:
        followed = _turns(run, lab, example, code_beside=True)
        if all(turn.cost <= MAX_STEP_OPERATIONS for turn in followed):
            return Told(spec, example, run, lab, followed, code_beside=True)
    return Told(spec, example, run, lab, _turns(run, lab, example, code_beside=False))


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
        if lab == "array":
            values = _played(values, operations).values
    return turns


def _followed_cost(run: TracedRun, by_event: list[tuple[int, list[dict[str, Any]]]], window: Window) -> int:
    full = len(code.follow({"do": []}, CODE_OBJECT, run, by_event, window)["do"])
    return full if full <= MAX_STEP_OPERATIONS else len(code.follow({"do": []}, CODE_OBJECT, run, by_event, window, lines_only=True)["do"])


def _contrast_outline(main: Told, side: Told, contrast: Contrast) -> Outline:
    beside = main.lab in SIDE_BY_SIDE_LABS and side.lab in SIDE_BY_SIDE_LABS
    asked = main if contrast.serves == NORMAL_CASE else side
    proof = _proof(main, side, contrast)
    main_stops = main.stops(proof.hinge if asked is main else None)
    side_stops = side.stops(proof.hinge if asked is side else None)
    brief = "\n".join([*_run_brief(main, MAIN_RUN, main_stops), *_contrast_brief(side, contrast, side_stops, main.code_beside, proof, beside), *_caption_brief(main, side, beside), _story_order(contrast, proof, beside, len(main_stops) + 1, len(side_stops) + 1)])
    return Outline(
        brief,
        Runs(
            frozenset({side.key()}),
            contrast.serves != NORMAL_CASE,
            frozenset({MAIN_RUN, CONTRAST_RUN}) if beside else frozenset(),
            Hinge(asked.key(), MAIN_RUN if asked is main else CONTRAST_RUN, proof.hinge, f"{proof.question}, which the learner can work out from what the other run did; {proof.versus}", proof.answer) if proof.pinned else None,
            frozenset({main.key(), side.key()}),
            tuple((name, told.run) for name, told in ((MAIN_RUN, main), (CONTRAST_RUN, side)) if told.lab == "array"),
        ),
    )


@dataclass(frozen=True)
class Proof:
    hinge: int
    pinned: bool
    breaks: str
    told_apart: str
    versus: str
    question: str
    last: str
    shown: str
    compared: str
    answer: str | None = None


def _proof(main: Told, side: Told, contrast: Contrast) -> Proof:
    asked, other = (main, side) if contrast.serves == NORMAL_CASE else (side, main)
    names = (MAIN_RUN, CONTRAST_RUN) if asked is main else (CONTRAST_RUN, MAIN_RUN)
    if contrast.measure == PLACED:
        return _placed_proof(main, side, asked, names[0], contrast)
    if getattr(main.run.trace.counters, contrast.measure) and getattr(side.run.trace.counters, contrast.measure):
        return _total_proof(asked, other, names, contrast.measure)
    return _order_proof(main, asked, other, names[0])


def _total_proof(asked: Told, other: Told, names: tuple[str, str], total: str) -> Proof:
    mine, theirs = (getattr(told.run.trace.counters, total) for told in (asked, other))
    answer = "more" if mine > theirs else "fewer" if mine < theirs else "the same"
    return Proof(
        hinge=asked.hinge(total),
        pinned=False,
        breaks="the cost its own counter shows is the break, so say that cost plainly before the main run solves it",
        told_apart=f"the last Step highlights the two {total} counters while it says the point. Say a total with the run's own placeholder, {{trace.{MAIN_RUN}.{total}}} for the main run and {{trace.{CONTRAST_RUN}.{total}}} for the contrast run, never the plain {{trace.{total}}}. Name no total in the Step before the hinge that the learner is asked to predict.",
        versus="the hinge is a choice Challenge and its Step never says the answer",
        question=f"whether the {names[0]} run will end with more, fewer or the same {total} as the {names[1]} run, which it has already finished",
        last=f"the last Step highlights the main run's {total} counter and the contrast run's {total} counter, which both stay on stage, while it says the point",
        shown="so its counter shows its total, and say what that costs",
        compared="the two totals",
        answer=answer,
    )


def _order_proof(main: Told, asked: Told, other: Told, name: str) -> Proof:
    parted = asked.parted_from(other)
    next_turn = "at its next turn, the first turn where its order parts from the other run's, so the answer is the node where the two orders differ" if parted else "at its last turn"
    return Proof(
        hinge=parted or asked.hinge(None),
        pinned=bool(parted),
        breaks="the order it plays shows the break, so say plainly what that order gets wrong before the main run solves it",
        told_apart=f"the last Step says the point over the main run's finished {main.lab} and names both orders. These runs count nothing, so name no total and use no placeholder; tell each run by the order it plays.",
        versus="the hinge Challenge asks what the run does at its next turn, and its Step never says it",
        question=f"which node the {name} run takes {next_turn}",
        last=f"the last Step says the point over the main run's finished {main.lab} and names both orders",
        shown="so its whole order shows, and say what that order gets wrong",
        compared="the two orders",
    )


def _placed_proof(main: Told, side: Told, asked: Told, name: str, contrast: Contrast) -> Proof:
    hinge = asked.hinge(None)
    runs = ((MAIN_RUN, main, main.landing(len(main.turns))), (CONTRAST_RUN, side, side.landing(len(side.turns))))
    if any(landing is None for _, _, landing in runs):
        raise ValueError(f"the {contrast.algorithm} contrast is told by where its last value lands, but a run's last turn puts no cell in its final place")
    cell, value = next(landing for run, _, landing in runs if run == name)
    if _array_of(asked.example)[cell] == value:
        raise ValueError(f"the {contrast.algorithm} contrast asks where {value} lands, but {value} already sits in that cell before the run, so the stage shows the answer")
    lands = "; ".join(f"the {run} run puts {landed} at index {at}, with {_counted(at, 'value')} on its left and {_counted(len(told.turns[0].values) - at - 1, 'value')} on its right" for run, told, (at, landed) in runs)
    comparisons = {told.run.trace.counters.comparisons for told in (main, side)}
    totals = f"Both runs make the same {comparisons.pop()} comparisons, so" if len(comparisons) == 1 else "Their totals are not the proof, so"
    return Proof(
        hinge=hinge,
        pinned=True,
        breaks="the cell its last value lands in shows the break, so say plainly where it lands before the main run solves it",
        told_apart=f"the last Step says the point over both finished arrays, where the cell each run's last turn puts in its final place tells the two runs apart: {lands}. {totals} the Lesson's point and every Step name no total, use no placeholder and never say one run does more or less work; the point is where the last value lands and what that leaves on each side of it.",
        versus='the hinge is a predict Challenge of type "click", which the learner answers by tapping a cell, and its Step never says the answer',
        question=f"which cell {value} lands in when the {name} run's last turn puts it in its final place",
        last="the last Step says the point over both finished arrays, which both stay on stage, and names the cell where each run's last value landed",
        shown="so the cell where its last value lands shows, and say what that costs",
        compared="where the two runs' last values landed",
        answer=f"{name}[{cell}]",
    )


def _spine_part(serves: str, proof: Proof) -> str:
    if serves == NORMAL_CASE:
        return f"the normal case, in the Steps right after the promise, where {proof.breaks}"
    return "the break, in the Steps after the main run's normal case, where the learner's assumption fails"


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


def _contrast_brief(told: Told, contrast: Contrast, stops: list[int], code_beside: bool, proof: Proof, beside: bool) -> list[str]:
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
    alone = " The code object steps only the main run, so a Step that plays the contrast run leaves the code where the main run left it." if code_beside else CODE_OBJECT_WARNING if told.crowded() else ""
    return [
        f"Contrast run, which serves {_spine_part(contrast.serves, proof)}: {contrast.why}. It is {ALGORITHMS[spec.code].summary}, and it has {len(told.turns)} turns. {placed}, and carry exactly `\"trace\": {shown}` in every Step that plays it.{alone} A Step carries one trace, so each Step plays one of the two runs, and a Step that returns to a run repeats that run's whole trace. {_staging("contrast run", stops)} Its turns are:",
        *told.lines("contrast "),
        _ending(told),
        f"Show the contrast run in its own Steps for that part of the story, and {staying}: {proof.told_apart}",
    ]


def _caption_brief(main: Told, side: Told, beside: bool) -> list[str]:
    if not beside:
        return []
    names = "the story name of each input, such as \"mixed hand\" and \"ordered hand\"" if main.spec.code == side.spec.code else "the name of each algorithm, such as \"binary search\" and \"linear search\""
    return [f'Both runs sit side by side, so give each object a `"caption"` in Step 1, where you declare it: a name of two to four words, {names}. Use the same words for that run in "say", and keep each caption as it is in every later Step.']


def _story_order(contrast: Contrast, proof: Proof, beside: bool, main_steps: int, side_steps: int) -> str:
    start = 'Step 1 is the promise, with the main trace at "until": 0' + (" and the contrast object on stage beside it" if beside else "")
    if contrast.serves == NORMAL_CASE:
        order = f'{start}; the next Steps play the whole contrast run at its stops, {proof.shown}; the next Steps play the main run; the hinge Step plays the main run up to "until": {proof.hinge}, then asks the learner to predict {with_answer(proof.question, proof.answer)}; {proof.versus}; the reveal Step plays the rest of the main run and compares {proof.compared}; {proof.last}'
    else:
        order = f'{start}; the next Steps play the main run, which is the normal case; then the contrast run plays at its stops, which is the break; the hinge Step plays the contrast run up to "until": {proof.hinge}, then asks the learner to predict {with_answer(proof.question, proof.answer)}; {proof.versus}; the reveal Step plays the end of the contrast run and compares {proof.compared}; {proof.last}'
    first, second, second_steps = (CONTRAST_RUN, MAIN_RUN, main_steps) if contrast.serves == NORMAL_CASE else (MAIN_RUN, CONTRAST_RUN, side_steps)
    least_steps = main_steps + side_steps + 2
    budget = f"With the promise and the last Step, these stops make {least_steps} Steps, so add at most {max(0, MAX_LESSON_STEPS - least_steps)} more and keep the Lesson within {MAX_LESSON_STEPS} Steps: the {first} run ends by Step {MAX_LESSON_STEPS - second_steps - 1}, the {second} run ends by Step {MAX_LESSON_STEPS - 1}, and the last Step, which says the point, is Step {MAX_LESSON_STEPS} at the latest. Plan each run's Steps to fit, and never start the {second} run before the {first} run ends."
    return f"Suggested order of the Steps: {order}. {budget} {RUNS_CAPTIONED if beside else RUNS_UNNAMED} The order is a guide, and the Steps in it must follow from one another by cause."


MAX_LESSON_STEPS = 8
RUNS_CAPTIONED = 'The learner sees each run under its "caption", so "main" and "contrast" are words for you alone: never say them in "say", and call each run by its caption.'
RUNS_UNNAMED = 'The learner sees the two runs with no names, so "main" and "contrast" are words for you alone: never say them in "say", and call each run by what the learner sees, such as its list ("the first list", "the reversed list") or its algorithm ("binary search", "linear search").'
STAGES = {
    "array": "one `array` object{named} whose `values` are {values}",
    "graph": 'one `{{"lab":"graph"}}` object{named} with no nodes or edges',
    "code": 'one `code` object{named} whose `source` is "{source}"',
}


def _array_of(example: Any) -> list[Any]:
    return next((item for item in example.values() if isinstance(item, list)), []) if isinstance(example, dict) else example


def _index(on: str) -> int:
    return int(CELL.search(on).group(1))


def _adds_to(operation: dict[str, Any], total: str) -> bool:
    return operation.get("count") == total or (operation.get("op") == "counter" and operation.get("name") == total)


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


def _played(values: list[Any], operations: list[dict[str, Any]]) -> Moves:
    compared = {operation["on"][1] for operation in operations if operation["op"] == "compare"}
    moves = Moves(list(values), list(values), pivot_held=len(compared) == 1)
    for operation in operations:
        ARRAY_MOVES.get(operation["op"], lambda *_: None)(moves, operation)
    return moves


def _array_turn(turn: Turn) -> str:
    return "; ".join(_played(turn.values, turn.operations).told()) or "nothing moves, the loop ends"


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


def _counted(count: int, noun: str) -> str:
    return f"no {noun}s" if count == 0 else f"1 {noun}" if count == 1 else f"{count} {noun}s"


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
    last = told.turns[-1] if told.turns else None
    still = " No value in this run changes place: only its pointers move along it, so never say a value moves." if told.lab == "array" and last and _played(last.values, last.operations).values == told.turns[0].values else ""
    if not totals:
        return f"The run ends.{searched}{returned}{still}"
    return f"The whole run makes {', '.join(totals)}.{searched}{returned}{still}"
