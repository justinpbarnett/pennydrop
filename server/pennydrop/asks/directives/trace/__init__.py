from __future__ import annotations

import ast
import re
import sys
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ....spoken import comparable_script
from ....tracer import ALGORITHMS, TraceError, Tracer
from . import _stages as stages
from . import code
from ._stages import Window
from .array import PROBE_POINTER
from .code import shown_source
from .._support import MAX_STEP_OPERATIONS, DirectiveError, DirectiveTools, TracedRun, discover, limit_operations, operation_targets, parse_spec, trace_key, values_said, with_answer_from, with_nested_trace_lifted

TRACE_TOTALS = ("comparisons", "swaps", "writes")
RUN_LABS = ("array", "code")
RUN_OPERATIONS = ("compare", "swap", "set", "line", "call", "return", "print")
ALGORITHM_MOVES = ("compare", "swap")
MAIN_RUN = "main"
CONTRAST_RUN = "contrast"
SEARCHES = ("binary_search", "linear_search")
CELL_INDEX = re.compile(r"\[(\d+)\]")
CODE_ONLY = ("two_pointers_pair_sum", "sliding_window_max_sum")
TARGETS = discover(sys.modules[__name__])

BRIEF = 'The trace directive plays the {lab} Labs whenever a library algorithm or a short function of your own fits the Ask, and it writes every operation of the run: compare, swap and set on an array, line, call, set, return and print on code, and visit, push, pop and relax on a graph search. Then carry the same trace in every Step that moves the run, each with a later "until", and write none of those operations yourself, even though the Catalog lists them. When none fits, such as a tree you build by hand, show the idea with plain objects and operations.'
PLAYS_IN_STAGES = True

GUIDE = "\n".join([
    "### Directive `trace`",
    '`"trace": {"code": "bubble_sort", "input": [4, 3, 2, 1]}` runs real code and plays every compare, swap and write of it on an object of a Lab, in order.',
    "`code` is the name of a library algorithm or the Python source of one function. Library algorithms and their input:",
    *(f"- `{algorithm.name}`: {algorithm.input_help}" for algorithm in ALGORITHMS.values()),
    "The first Step that carries the trace sets the traced object in its own `scene`, and `on` names it when the scene holds several objects of those Labs; without `on`, the first Lab below that can play the algorithm is traced. Labs that can play a trace: " + ", ".join(TARGETS) + ".",
    "A Step that carries a trace plays the whole run, unless the trace has an `until`. To tell one run across several Steps, repeat the same trace, with the same `code` and `input`, in each Step, give every Step but the last a later `until` than the Step before, and leave `until` out of the Step that plays the end of the run. Each Step then plays only the part no earlier Step played, on the same objects, and its narration talks only about that part.",
    "`until` counts turns: one turn of the traced function's outer loop for the array and code Labs, and one node taken for the graph Lab, so `\"until\": 2` stops the run after its second turn. bubble_sort, selection_sort and insertion_sort take one turn fewer than the number of values, and their first turn already moves values: turn 1 of insertion_sort inserts the second value into the sorted first one, so a Step that only shows the first value as sorted uses `\"until\": 0`, and turn k inserts the value at index k; turn k of bubble_sort carries the k-th largest value to its place at the end, and turn k of selection_sort puts the k-th smallest value at index k - 1. So on 4 values `\"until\": 3` already plays the whole run, and the Step before a predict Challenge on their total stops at `\"until\": 2` or earlier. `\"until\": 0` draws the objects with the run's input and plays none of it, for Step 1 or any Step that asks a question before the run starts. A Step with the same `until` as the Step before keeps the stage as it is, which only the Step that asks the predict Challenge does: every other Step plays a later turn than the Step before. merge_sort and quick_sort call themselves, so one of their turns is one merge or one partition: `\"until\": 1` stops quick_sort after its first partition has placed the first pivot. partition is that first partition alone, told value by value: its pivot is the last value, turn k compares the value at index k - 1 with the pivot and, when it is smaller, swaps it onto the boundary and moves the boundary one cell right, and only the Step without `until` swaps the pivot onto the boundary at the end. So on 6 values `\"until\": 5` plays all 5 compares with the pivot still last, and the next Step, without `until`, places it. Trace partition when the Ask is about how one partition works, and quick_sort when it is about the whole sort. Turn k of binary_search makes its k-th middle check and keeps the half that can hold the target, so on `[1, 3, 5, 7, 9, 11, 13]` `\"until\": 1` checks 7 and `\"until\": 2` checks 11: play each check as its own Step this way, never with compares written by hand.",
    *(target.GUIDE for target in TARGETS.values()),
    "An `array` object is played only when its `values` equal the traced `input` list. A hash table, a stack or any other structure that the code builds is not that, so trace it on a `code` object alone, and show any array of buckets with plain operations after the run.",
    "The directive writes the operations and counters for you, so write no `do` entries for the traced run.",
    'Use the measured totals as `{trace.comparisons}`, `{trace.swaps}` or `{trace.writes}` inside `say` or text in the Step that plays the run to its end or in any later Step, so the narration never states a total before the stage shows it. Only the totals the run makes exist: insertion sort shifts and never swaps, so it has no `trace.swaps`, and a graph search has none of the three.',
    'A predict Challenge names a total as `"answer": "trace.comparisons"` (or `swaps`, `writes`) in a Step that repeats the trace with an `until`, before the run ends: the whole run is computed there, and the stage does not show the total yet. A Challenge waits after its Step plays, so in the Step that plays the run to its end, or any later Step, the counter already shows the total and the learner would read it off; that Step reveals it instead.',
    'For your own code, `code` is the whole source text of one function, such as `"def grow(balance, years):\\n    for _ in range(years):\\n        balance = balance * 1.05\\n    return balance"`, never a bare function name that is not in the library list',
    "Write the `input` with exactly the keys named above, such as `{\"array\": [2, 7, 11, 15], \"target\": 9}` for two_pointers_pair_sum, and never `arr` or other short names.",
    "For binary_search and linear_search leave `target` out of the input: the directive searches for the array's last value, which takes the most halvings and the most looks, since a search that finds its target at the first look shows nothing. So the narration names the last value as the target, such as thirteen in `[1, 3, 5, 7, 9, 11, 13]`, and never a value from the middle. Turn k of linear_search looks at the cell at index k - 1.",
    "A Lesson may play two runs, a contrast run beside the main one, when the brief outlines both. Each run plays on its own object of the Lab, which the Step's `scene` sets, and the trace's `on` names that object's id in every Step of the run, such as `\"on\": \"contrast\"`. Each Step carries one trace, and the Step that returns to the other run repeats that run's whole trace with its `code`, `input` and `on`. A run's totals are named by its object, as `{trace.contrast.comparisons}` and `{trace.main.comparisons}`: once two runs have ended, the plain `{trace.comparisons}` is refused as ambiguous. The Labs' notes on showing a Lab twice do not apply to a contrast run, which sits beside the main run's object.",
    "When the brief outlines a real run of a library algorithm, use exactly that input in every Step, whatever the examples above show; its turns say what each `until` plays. For any other input, keep it small, 3 to 6 numbers. A Step plays at most 40 operations, so stage a longer run with `until`.",
])


class TraceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    input: Any
    on: str | None = None
    until: int | None = Field(default=None, ge=0)


def prepare(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    step = _with_nested_trace_lifted(step)
    _require_trace_for_runs(step, tools)
    scene = step.get("scene")
    if not isinstance(scene, dict):
        return step
    return {**step, "scene": {name: _with_library_source(spec) for name, spec in scene.items()}}


def _require_trace_for_runs(step: dict[str, Any], tools: DirectiveTools) -> None:
    if "trace" in step:
        return
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    labs = {name: spec.get("lab") for name, spec in {**tools.staged, **scene}.items() if isinstance(spec, dict)}
    code_objects = sorted(name for name, lab in labs.items() if lab == "code")
    moves = RUN_OPERATIONS if code_objects else ALGORITHM_MOVES
    played = sorted({target for operation in step.get("do") or [] if isinstance(operation, dict) and operation.get("op") in moves for target in operation_targets(operation) if labs.get(target) in RUN_LABS})
    if not played:
        return
    if code_objects:
        raise DirectiveError(f'trace directive: {code_objects[0]} shows code, so its run plays only through the trace directive, never through "do" entries for {", ".join(played)}; carry the same "trace" as the Lesson\'s other Steps, with the code and input on stage and a later "until", and write no operations for the run yourself')
    raise DirectiveError(f'trace directive: compares and swaps on {", ".join(played)} are an algorithm\'s run, which plays only through the trace directive, so the stage moves exactly as the real code does; carry "trace": {{"code": "<library algorithm, such as insertion_sort, or the source of one short function>", "input": <the array\'s values>, "until": <turns played by the end of this Step>}} in every Step that moves the run, and write no compare, swap or set yourself')


def _with_nested_trace_lifted(step: dict[str, Any]) -> dict[str, Any]:
    return {**step, "trace": with_nested_trace_lifted(step["trace"])} if "trace" in step else step


def _with_library_source(spec: Any) -> Any:
    source = spec.get("source") if isinstance(spec, dict) and spec.get("lab") == "code" else None
    if isinstance(source, str) and source.strip() and source not in ALGORITHMS and len(source.split()) == 1:
        raise DirectiveError(f'trace directive: the code object\'s source "{source}" is neither code nor a library algorithm; write the real code, or one of {", ".join(ALGORITHMS)}')
    return library_filled(spec)


def library_filled(spec: Any) -> Any:
    if isinstance(spec, dict) and spec.get("lab") == "code" and spec.get("source") in ALGORITHMS:
        algorithm = ALGORITHMS[spec["source"]]
        return {"language": "python", **spec, "vars": _variables_of(algorithm.source, algorithm.entry), "source": shown_source(algorithm.source)}
    return spec


def _variables_of(source: str, entry: str) -> list[str]:
    function = next(node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.FunctionDef) and node.name == entry)
    names = [argument.arg for argument in function.args.args]
    names += [node.id for node in ast.walk(function) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)]
    return list(dict.fromkeys(names))


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    written = {name: obj for name, obj in (step.get("scene") or {}).items() if isinstance(obj, dict)}
    kept = {name: obj for name, obj in tools.staged.items() if name not in (step.get("scene") or {})}
    spec = _with_shown_source(_with_search_target(_aligned(parse_spec(TraceSpec, raw, "trace"))), {**kept, **written})
    _require_the_array_shown(spec, {**kept, **written})
    step = _with_traced_object(step, {**kept, **written}, spec, tools.young_child)
    written = {name: obj for name, obj in (step.get("scene") or {}).items() if isinstance(obj, dict)}
    object_id = _traced_object(written, kept, spec)
    pool = {**tools.staged, **written}
    target = TARGETS[pool[object_id]["lab"]]
    library = getattr(target, "LIBRARY", None)
    if library and spec.code not in library:
        raise DirectiveError(f"trace directive: this Lab plays only a library algorithm, so write `code` as one of {', '.join(library)} with its input, not your own code")
    run = await _run(spec, tools.tracer)
    _require_a_search_worth_watching(spec, run)
    by_event = target.operations_by_event(run, object_id)
    continuing = object_id in tools.staged and trace_key(raw) in tools.traced
    turns = target.turns(run)
    played_run = [operation for name, operation in tools.played if name == object_id and operation.get("op") in target.OPERATIONS] if continuing else []
    window = stages.window(_held_for_prediction(step, spec.until, turns), turns, by_event, played_run, run, spec.code)
    code_id = _following_code(pool, object_id)
    step = _without_hand_run(step, {object_id: target.OPERATIONS, **({code_id: code.OPERATIONS} if code_id else {})})
    played = len(step.get("do", []))
    if continuing and not window.of(by_event):
        return _settled(_without_replay(step, object_id), spec, run, window, object_id)
    if continuing:
        step = _without_replay(step, object_id)
        expanded = {**step, "do": [*step.get("do", []), *window.of(by_event)]}
    else:
        step = {**step, "scene": {**(step.get("scene") or {}), **{name: obj for name, obj in kept.items() if name in (object_id, code_id)}}}
        expanded = target.apply(step, object_id, run, window)
        if code_id:
            expanded = code.drawn(expanded, code_id, run)
    if target is code and not turns:
        expanded = {**expanded, "do": [*expanded["do"][:played], *code.within_budget(expanded["do"][played:], MAX_STEP_OPERATIONS)]}
    elif code_id:
        expanded = _with_code_following(expanded, played, code_id, by_event, run, window)
    if not window.finished and (pause := getattr(target, "paused", None)):
        expanded = {**expanded, "do": [*expanded["do"], *pause(expanded["do"][played:], object_id)]}
    _require_within_a_step(expanded.get("do", [])[played:], bool(turns))
    _require_the_next_turn_predicted(step, object_id, by_event, turns, window, len(run.trace.events))
    _require_one_middle_check(spec, expanded.get("do", [])[played:], pool[object_id], step.get("say"))
    return _settled(expanded, spec, run, window, object_id)


def _require_the_next_turn_predicted(step: dict[str, Any], object_id: str, by_event: list[tuple[int, list[dict[str, Any]]]], turns: list[int], window: Window, events: int) -> None:
    challenge = step.get("challenge")
    answer = challenge.get("answer") if isinstance(challenge, dict) and challenge.get("kind") == "predict" else None
    if not isinstance(answer, str):
        return
    nodes = {str(operation["node"]) for _, operations in by_event for operation in operations if "node" in operation}
    named = re.fullmatch(rf"{re.escape(object_id)}\[([^\]]+)\]", answer)
    node = named.group(1) if named else answer if answer in nodes else None
    if node is None:
        return
    following = Window(window.end, next((turn for turn in turns if turn > window.end), events), finished=False)
    taken = list(dict.fromkeys(str(operation["node"]) for operation in following.of(by_event) if "node" in operation))
    if taken and node not in taken:
        written = f"{object_id}[{taken[0]}]" if named else taken[0]
        raise DirectiveError(f'challenge: its answer {answer} names {node}, but the turn the run plays right after this Step\'s stop works on {" and ".join(taken)}, so the reveal would contradict the stage; make the answer one of those, such as "{written}", and ask about that turn, or stop this Step at the "until" just before the turn that works on {node}')


def _held_for_prediction(step: dict[str, Any], until: int | None, turns: list[int]) -> int | None:
    challenge = step.get("challenge")
    answer = challenge.get("answer") if isinstance(challenge, dict) and challenge.get("kind") == "predict" else None
    predicts_a_total = isinstance(answer, str) and answer.startswith("trace.") and answer.rsplit(".", 1)[1] in TRACE_TOTALS
    return len(turns) - 1 if predicts_a_total and until is not None and until >= len(turns) > 1 else until


def _settled(step: dict[str, Any], spec: TraceSpec, run: TracedRun, window: Window, object_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    inputs = _inputs_named(spec)
    if window.finished:
        return step, {**inputs, **_totals(run, object_id)}
    _require_totals_unsaid(step, spec.until, object_id)
    return with_answer_from(step, {**inputs, **_totals(run, object_id)}), inputs


def describe_value(name: str) -> str | None:
    return {"comparisons": "comparisons in the whole run", "swaps": "swaps in the whole run", "writes": "array writes in the whole run, counting every shift and placement", "target": "the value the search looks for"}.get(name)


def _inputs_named(spec: TraceSpec) -> dict[str, Any]:
    return {"trace.target": spec.input["target"]} if spec.code in SEARCHES and isinstance(spec.input, dict) and "target" in spec.input else {}


def _with_search_target(spec: TraceSpec) -> TraceSpec:
    values = spec.input.get("array") if isinstance(spec.input, dict) else None
    if spec.code not in SEARCHES or not isinstance(values, list) or not values or "target" in spec.input:
        return spec
    return spec.model_copy(update={"input": {**spec.input, "target": values[-1]}})


def _totals(run: TracedRun, object_id: str) -> dict[str, Any]:
    counts = {name: getattr(run.trace.counters, name) for name in TRACE_TOTALS}
    if not any(counts.values()):
        return {}
    return {**{f"trace.{name}": count for name, count in counts.items()}, **{f"trace.{object_id}.{name}": count for name, count in counts.items()}}


def _without_hand_run(step: dict[str, Any], owned: dict[str, frozenset[str]]) -> dict[str, Any]:
    kept = [operation for operation in step.get("do", []) if not any(operation.get("op") in owned.get(name, ()) for name in operation_targets(operation))]
    return {**step, "do": kept} if "do" in step else step


def _require_within_a_step(operations: list[dict[str, Any]], staged: bool) -> None:
    if staged and len(operations) > MAX_STEP_OPERATIONS:
        raise DirectiveError(f'trace directive: this Step plays {len(operations)} operations of the run and a Step plays at most {MAX_STEP_OPERATIONS}; tell the run in stages: give this Step an "until" that stops it after fewer turns, and play the rest in later Steps that repeat the same trace with a later "until", each narrating only its own part')
    limit_operations("trace", operations)


def _following_code(pool: dict[str, Any], data_id: str) -> str | None:
    if pool[data_id].get("lab") == "code" or data_id == CONTRAST_RUN:
        return None
    return next((name for name, obj in pool.items() if isinstance(obj, dict) and obj.get("lab") == "code" and name != data_id), None)


def _require_totals_unsaid(step: dict[str, Any], until: int | None, object_id: str) -> None:
    said = values_said(step, [f"trace.{prefix}{name}" for name in TRACE_TOTALS for prefix in ("", f"{object_id}.")])
    if said:
        raise DirectiveError(f'trace directive: {{{said[0]}}} is a total of the whole run, and this Step stops it after turn {until}, so the stage does not show it yet; leave the number out of the narration here, and say it in the Step that plays the run to its end, which carries the trace without "until". A predict Challenge here may still name it as its "answer"')


def _require_one_middle_check(spec: TraceSpec, operations: list[dict[str, Any]], traced: dict[str, Any], say: Any) -> None:
    if spec.code != "binary_search":
        return
    probed = [int(found[1]) for probe, counted in zip(operations, operations[1:]) if probe.get("name") == PROBE_POINTER and counted.get("op") == "counter" and (found := CELL_INDEX.search(str(probe.get("on")))) is not None]
    values = traced.get("values") if isinstance(traced.get("values"), list) else []
    middles = [str(values[index]) for index in probed if index < len(values)]
    if len(probed) < 2 or (spec.until is None and _tells_in_order(middles, say)):
        return
    listed = ", then ".join(middles)
    raise DirectiveError(f'trace directive: this Step plays {len(probed)} middle checks of binary_search ({listed}), and the learner follows the search one halving at a time; give this Step an "until" one turn later than the Step before ("until": 1 in the Step that starts the search), narrate only that check and the half it keeps, and play each later check in its own Step with the same trace. Only the Step that plays the search to its end, with no "until", may play several checks, and then "say" names each middle it checks in order: {listed}')


def _tells_in_order(values: list[str], say: Any) -> bool:
    remaining = iter(comparable_script(say) if isinstance(say, str) else [])
    return all(value in remaining for value in values)


def _require_a_search_worth_watching(spec: TraceSpec, run: TracedRun) -> None:
    values = spec.input.get("array") if isinstance(spec.input, dict) else None
    if spec.code == "binary_search" and isinstance(values, list) and len(values) >= 7 and run.trace.counters.comparisons < 3:
        raise DirectiveError(f"trace directive: binary_search found its target in {run.trace.counters.comparisons} comparisons, which shows no halving; leave \"target\" out of the trace's input in this Step and every later one, so the search looks for the last value, {values[-1]}, which it reaches only after {_binary_search_probes(values, values[-1])} halvings, and name {values[-1]} as the target wherever \"say\" names it")


def _binary_search_probes(values: list[Any], target: Any) -> int:
    low, high, probes = 0, len(values) - 1, 0
    while low <= high:
        middle = (low + high) // 2
        probes += 1
        if values[middle] == target:
            return probes
        if values[middle] < target:
            low = middle + 1
        else:
            high = middle - 1
    return probes


def _require_the_array_shown(spec: TraceSpec, pool: dict[str, Any]) -> None:
    values = _traced_values(spec.input)
    arrays = {name: obj for name, obj in pool.items() if obj.get("lab") == "array" and isinstance(obj.get("values"), list)}
    if spec.code not in ALGORITHMS or spec.code in getattr(TARGETS["graph"], "LIBRARY", ()) or values is None or not arrays:
        return
    if any(TARGETS["array"].holds_input(obj, spec.input) for obj in arrays.values()):
        return
    name, shown = next(iter(arrays.items()))
    raise DirectiveError(f"trace directive: the array '{name}' on stage holds {shown['values']}, but the trace runs {spec.code} on {values}, so the picture and the counts would tell different stories; to play this run beside '{name}', add a second array object whose values are {values} to this Step's scene and name its id in the trace's \"on\", or, to play '{name}' itself, set the trace input to {shown['values']}")


def _with_code_following(step: dict[str, Any], played: int, code_id: str, data_operations: Any, run: TracedRun, window: Window) -> dict[str, Any]:
    bare = {**step, "do": step["do"][:played]}
    full = code.follow(bare, code_id, run, data_operations, window)
    return full if len(full["do"]) - played <= MAX_STEP_OPERATIONS else code.follow(bare, code_id, run, data_operations, window, lines_only=True)


def _with_traced_object(step: dict[str, Any], pool: dict[str, Any], spec: TraceSpec, young_child: bool) -> dict[str, Any]:
    if any(obj.get("lab") in TARGETS for obj in pool.values()):
        return step
    if spec.code in ALGORITHMS:
        values = _traced_values(spec.input)
        graph_plays = spec.code in getattr(TARGETS["graph"], "LIBRARY", ())
        added = {"traced": {"lab": "array", "values": values}} if values and not graph_plays else {}
    else:
        if young_child:
            raise DirectiveError(f"trace directive: this run shows as code, and a child who cannot read cannot follow code; trace a library algorithm instead, one of {', '.join(sorted(ALGORITHMS))}, whose array a child sees as bars trading places, or tell the idea with shapes")
        added = {"traced": {"lab": "code", "language": "python", "source": spec.code, "vars": []}}
    return {**step, "scene": {**(step.get("scene") or {}), **added}} if added else step


def _traced_values(arguments: Any) -> list | None:
    if isinstance(arguments, dict):
        return next((item for item in arguments.values() if isinstance(item, list)), None)
    return arguments if isinstance(arguments, list) else None


def _with_shown_source(spec: TraceSpec, pool: dict[str, Any]) -> TraceSpec:
    if spec.code in ALGORITHMS or re.search(r"^def ", spec.code, re.MULTILINE):
        return spec
    shown = [obj["source"] for obj in pool.values() if obj.get("lab") == "code" and isinstance(obj.get("source"), str) and re.search(r"^def ", obj["source"], re.MULTILINE)]
    return spec.model_copy(update={"code": shown[-1]}) if len(shown) == 1 else spec


def _aligned(spec: TraceSpec) -> TraceSpec:
    name = re.sub(r"[^a-z0-9]+", "_", spec.code.strip().lower()).strip("_")
    code = name if name in ALGORITHMS else spec.code
    algorithm = ALGORITHMS.get(code)
    if algorithm is None or not isinstance(spec.input, dict):
        return spec.model_copy(update={"code": code})
    entry = next(node for node in ast.parse(algorithm.source).body if isinstance(node, ast.FunctionDef) and node.name == algorithm.entry)
    parameters = [argument.arg for argument in entry.args.args]
    unknown = [key for key in spec.input if key not in parameters]
    missing = [parameter for parameter in parameters if parameter not in spec.input]
    renamed = dict(zip(unknown, missing, strict=True)) if len(unknown) == len(missing) else {}
    return spec.model_copy(update={"code": code, "input": {renamed.get(key, key): value for key, value in spec.input.items()}})


def _without_replay(step: dict[str, Any], object_id: str) -> dict[str, Any]:
    scene = step.get("scene") or {}
    replayed = {object_id, *(name for name, obj in scene.items() if isinstance(obj, dict) and obj.get("lab") == "code")}
    kept = {name: obj for name, obj in scene.items() if name not in replayed}
    return {key: value for key, value in {**step, "scene": kept}.items() if key != "scene" or kept}


async def _run(spec: TraceSpec, tracer: Tracer) -> TracedRun:
    source = ALGORITHMS[spec.code].source if spec.code in ALGORITHMS else spec.code
    try:
        trace = await (tracer.trace_named(spec.code, spec.input) if spec.code in ALGORITHMS else tracer.trace_source(spec.code, _entry_point(spec.code), spec.input))
    except TraceError as error:
        raise DirectiveError(f"trace directive: {error}") from None
    if trace.error:
        hint = f"; the input of {spec.code} is {ALGORITHMS[spec.code].input_help}" if spec.code in ALGORITHMS else ""
        raise DirectiveError(f"trace directive: the traced code raised {trace.error}{hint}")
    if trace.truncated:
        raise DirectiveError("trace directive: the traced code ran too long to play; trace a smaller input")
    known = ALGORITHMS.get(spec.code)
    if known:
        return TracedRun(trace, spec.input, source, known.pointers, known.window, known.placed, known.settles, known.sorts, known.seeks)
    return TracedRun(trace, spec.input, source, sorts=any(event.type in ("swap", "set") for event in trace.events))


async def totals_for(raw: Any, tracer: Tracer) -> dict[str, Any]:
    spec = _with_search_target(_aligned(parse_spec(TraceSpec, raw, "trace")))
    return {name: count for name, count in _totals(await _run(spec, tracer), "").items() if name.count(".") == 1}


def _entry_point(source: str) -> str:
    try:
        functions = [node.name for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)]
    except SyntaxError as error:
        raise DirectiveError(f"trace directive: code is neither a library algorithm ({', '.join(ALGORITHMS)}) nor valid Python: {error}") from None
    if not functions:
        raise DirectiveError(f"trace directive: `code` is neither a library algorithm ({', '.join(ALGORITHMS)}) nor Python source with a top level function")
    return functions[0]


def outline_lab(algorithm: str) -> str:
    if algorithm in TARGETS["graph"].LIBRARY:
        return "graph"
    return "code" if algorithm in CODE_ONLY else "array"


def _plays(lab: str, code: str) -> bool:
    library = getattr(TARGETS[lab], "LIBRARY", None)
    return library is None or code in library


def _traced_object(written: dict[str, Any], on_stage: dict[str, Any], spec: TraceSpec) -> str:
    pool = {**on_stage, **written}
    if spec.on is not None and spec.on not in pool:
        raise DirectiveError(f'trace directive: "on" names {spec.on!r}, and no object of that id is on stage or in this Step\'s scene, which holds {", ".join(sorted(name for name, obj in pool.items() if obj.get("lab") in TARGETS)) or "no object that can play a trace"}; set {spec.on!r} in this Step\'s scene, or name one of those')
    named = spec.on if spec.on in pool and pool[spec.on].get("lab") != "code" else None
    candidates = [name for name, obj in pool.items() if obj.get("lab") in TARGETS and (named is None or name == named)]
    if len(candidates) > 1 and named is None:
        data = [name for name in candidates if pool[name]["lab"] != "code" and (pool[name]["lab"] != "array" or TARGETS["array"].holds_input(pool[name], spec.input))] or [name for name in candidates if pool[name]["lab"] == "code"] or candidates
        playing = [name for name in data if _plays(pool[name]["lab"], spec.code)] or [name for name in candidates if pool[name]["lab"] == "code"] or data
        in_step = [name for name in playing if name in written]
        chosen = sorted(in_step or playing, key=lambda name: list(TARGETS).index(pool[name]["lab"]))
        candidates = chosen[:1] if len({pool[name]["lab"] for name in chosen}) > 1 else chosen
    if len(candidates) > 1 and spec.on is None and MAIN_RUN in candidates:
        candidates = [MAIN_RUN]
    if len(candidates) == 1:
        return candidates[0]
    raise DirectiveError(
        f"trace directive: the Step's own scene or the Scene on stage must hold exactly one object of a Lab that can play a trace ({', '.join(TARGETS)}); found {len(candidates)}"
        + (f" named {spec.on!r}" if spec.on else "")
        + ("; to play a second run beside the first, name the object it plays on with the trace's \"on\"" if len(candidates) > 1 and not spec.on else "")
    )
