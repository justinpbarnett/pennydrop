from __future__ import annotations

import ast
import re
import sys
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ....tracer import ALGORITHMS, TraceError, Tracer
from . import _stages as stages
from . import code
from ._stages import Window
from .code import shown_source
from .._support import MAX_STEP_OPERATIONS, DirectiveError, DirectiveTools, TracedRun, discover, limit_operations, operation_targets, parse_spec, trace_key, values_said, with_answer_from

TRACE_TOTALS = ("comparisons", "swaps", "writes")
RUN_LABS = ("array", "code")
RUN_OPERATIONS = ("compare", "swap", "set", "line", "call", "return", "print")
ALGORITHM_MOVES = ("compare", "swap")
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
    "`until` counts turns: one turn of the traced function's outer loop for the array and code Labs, and one node taken for the graph Lab, so `\"until\": 2` stops the run after its second turn. bubble_sort, selection_sort and insertion_sort take one turn fewer than the number of values, and their first turn already moves values: turn 1 of insertion_sort inserts the second value into the sorted first one, so a Step that only shows the first value as sorted uses `\"until\": 0`, and turn k inserts the value at index k; turn k of bubble_sort carries the k-th largest value to its place at the end, and turn k of selection_sort puts the k-th smallest value at index k - 1. So on 4 values `\"until\": 3` already plays the whole run, and the Step before a predict Challenge on their total stops at `\"until\": 2` or earlier. `\"until\": 0` draws the objects with the run's input and plays none of it, for Step 1 or any Step that asks a question before the run starts. A Step with the same `until` as the Step before keeps the stage as it is, which only the Step that asks the predict Challenge does: every other Step plays a later turn than the Step before. merge_sort and quick_sort call themselves, so one of their turns is one merge or one partition: `\"until\": 1` stops quick_sort after its first partition has placed the first pivot. partition is that first partition alone, told value by value: its pivot is the last value, turn k compares the value at index k - 1 with the pivot and, when it is smaller, swaps it onto the boundary and moves the boundary one cell right, and only the Step without `until` swaps the pivot onto the boundary at the end. So on 6 values `\"until\": 5` plays all 5 compares with the pivot still last, and the next Step, without `until`, places it. Trace partition when the Ask is about how one partition works, and quick_sort when it is about the whole sort.",
    *(target.GUIDE for target in TARGETS.values()),
    "An `array` object is played only when its `values` equal the traced `input` list. A hash table, a stack or any other structure that the code builds is not that, so trace it on a `code` object alone, and show any array of buckets with plain operations after the run.",
    "The directive writes the operations and counters for you, so write no `do` entries for the traced run.",
    'Use the measured totals as `{trace.comparisons}`, `{trace.swaps}` or `{trace.writes}` inside `say` or text in the Step that plays the run to its end or in any later Step, so the narration never states a total before the stage shows it. Only the totals the run makes exist: insertion sort shifts and never swaps, so it has no `trace.swaps`, and a graph search has none of the three.',
    'A predict Challenge names a total as `"answer": "trace.comparisons"` (or `swaps`, `writes`) in a Step that repeats the trace with an `until`, before the run ends: the whole run is computed there, and the stage does not show the total yet. A Challenge waits after its Step plays, so in the Step that plays the run to its end, or any later Step, the counter already shows the total and the learner would read it off; that Step reveals it instead.',
    'For your own code, `code` is the whole source text of one function, such as `"def grow(balance, years):\\n    for _ in range(years):\\n        balance = balance * 1.05\\n    return balance"`, never a bare function name that is not in the library list',
    "Write the `input` with exactly the keys named above, such as `{\"array\": [1, 3, 5], \"target\": 3}` for binary_search, and never `arr` or other short names.",
    "For binary_search make the target the first or the last value of the sorted array: the first guess is the middle, so a value at an end takes the most halvings, and a search that ends at once shows none.",
    "Keep the input small, 3 to 6 numbers. A Step plays at most 40 operations, so stage a longer run with `until`.",
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
    raw = step.get("trace")
    nested = raw.get("trace") if isinstance(raw, dict) else None
    if not isinstance(nested, dict):
        return step
    return {**step, "trace": {**nested, **{key: value for key, value in raw.items() if key != "trace"}}}


def _with_library_source(spec: Any) -> Any:
    source = spec.get("source") if isinstance(spec, dict) and spec.get("lab") == "code" else None
    if isinstance(source, str) and source.strip() and source not in ALGORITHMS and len(source.split()) == 1:
        raise DirectiveError(f'trace directive: the code object\'s source "{source}" is neither code nor a library algorithm; write the real code, or one of {", ".join(ALGORITHMS)}')
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
    spec = _with_shown_source(_aligned(parse_spec(TraceSpec, raw, "trace")), {**kept, **written})
    _require_the_array_shown(spec, {**kept, **written})
    step = _with_traced_object(step, {**kept, **written}, spec)
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
        return _settled(_without_replay(step, object_id), spec, run, window)
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
    _require_within_a_step(expanded.get("do", [])[played:], bool(turns))
    return _settled(expanded, spec, run, window)


def _held_for_prediction(step: dict[str, Any], until: int | None, turns: list[int]) -> int | None:
    challenge = step.get("challenge")
    answer = challenge.get("answer") if isinstance(challenge, dict) and challenge.get("kind") == "predict" else None
    predicts_a_total = answer in {f"trace.{name}" for name in TRACE_TOTALS}
    return len(turns) - 1 if predicts_a_total and until is not None and until >= len(turns) > 1 else until


def _settled(step: dict[str, Any], spec: TraceSpec, run: TracedRun, window: Window) -> tuple[dict[str, Any], dict[str, Any]]:
    if window.finished:
        return step, _totals(run)
    _require_totals_unsaid(step, spec.until)
    return with_answer_from(step, _totals(run)), {}


def describe_value(name: str) -> str | None:
    return {"comparisons": "comparisons in the whole run", "swaps": "swaps in the whole run", "writes": "array writes in the whole run, counting every shift and placement"}.get(name)


def _totals(run: TracedRun) -> dict[str, Any]:
    counts = {f"trace.{name}": getattr(run.trace.counters, name) for name in TRACE_TOTALS}
    return counts if any(counts.values()) else {}


def _without_hand_run(step: dict[str, Any], owned: dict[str, frozenset[str]]) -> dict[str, Any]:
    kept = [operation for operation in step.get("do", []) if not any(operation.get("op") in owned.get(name, ()) for name in operation_targets(operation))]
    return {**step, "do": kept} if "do" in step else step


def _require_within_a_step(operations: list[dict[str, Any]], staged: bool) -> None:
    if staged and len(operations) > MAX_STEP_OPERATIONS:
        raise DirectiveError(f'trace directive: this Step plays {len(operations)} operations of the run and a Step plays at most {MAX_STEP_OPERATIONS}; tell the run in stages: give this Step an "until" that stops it after fewer turns, and play the rest in later Steps that repeat the same trace with a later "until", each narrating only its own part')
    limit_operations("trace", operations)


def _following_code(pool: dict[str, Any], data_id: str) -> str | None:
    if pool[data_id].get("lab") == "code":
        return None
    return next((name for name, obj in pool.items() if isinstance(obj, dict) and obj.get("lab") == "code" and name != data_id), None)


def _require_totals_unsaid(step: dict[str, Any], until: int | None) -> None:
    said = values_said(step, [f"trace.{name}" for name in TRACE_TOTALS])
    if said:
        raise DirectiveError(f'trace directive: {{{said[0]}}} is a total of the whole run, and this Step stops it after turn {until}, so the stage does not show it yet; leave the number out of the narration here, and say it in the Step that plays the run to its end, which carries the trace without "until". A predict Challenge here may still name it as its "answer"')


def _require_a_search_worth_watching(spec: TraceSpec, run: TracedRun) -> None:
    values = spec.input.get("array") if isinstance(spec.input, dict) else None
    if spec.code == "binary_search" and isinstance(values, list) and len(values) >= 7 and run.trace.counters.comparisons < 3:
        probes = {value: _binary_search_probes(values, value) for value in values}
        deepest = [value for value in values if probes[value] == max(probes.values())]
        targets = " or ".join(str(value) for value in dict.fromkeys([deepest[0], deepest[-1]]))
        raise DirectiveError(f"trace directive: binary_search found its target in {run.trace.counters.comparisons} comparisons, which shows no halving; set the trace's \"target\" to {targets}, which the search reaches only after {max(probes.values())} halvings, and name that same target in \"say\" wherever the narration names it")


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
    raise DirectiveError(f"trace directive: the array '{name}' on stage holds {shown['values']}, but the trace runs {spec.code} on {values}, so the picture and the counts would tell different stories; set the trace input to {shown['values']} so the run plays on '{name}', or set '{name}' to {values} in this Step's scene")


def _with_code_following(step: dict[str, Any], played: int, code_id: str, data_operations: Any, run: TracedRun, window: Window) -> dict[str, Any]:
    bare = {**step, "do": step["do"][:played]}
    full = code.follow(bare, code_id, run, data_operations, window)
    return full if len(full["do"]) - played <= MAX_STEP_OPERATIONS else code.follow(bare, code_id, run, data_operations, window, lines_only=True)


def _with_traced_object(step: dict[str, Any], pool: dict[str, Any], spec: TraceSpec) -> dict[str, Any]:
    if any(obj.get("lab") in TARGETS for obj in pool.values()):
        return step
    if spec.code in ALGORITHMS:
        values = _traced_values(spec.input)
        graph_plays = spec.code in getattr(TARGETS["graph"], "LIBRARY", ())
        added = {"traced": {"lab": "array", "values": values}} if values and not graph_plays else {}
    else:
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
    return TracedRun(trace, spec.input, source, ALGORITHMS[spec.code].pointers if spec.code in ALGORITHMS else ())


def _entry_point(source: str) -> str:
    try:
        functions = [node.name for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)]
    except SyntaxError as error:
        raise DirectiveError(f"trace directive: code is neither a library algorithm ({', '.join(ALGORITHMS)}) nor valid Python: {error}") from None
    if not functions:
        raise DirectiveError(f"trace directive: `code` is neither a library algorithm ({', '.join(ALGORITHMS)}) nor Python source with a top level function")
    return functions[0]


def _plays(lab: str, code: str) -> bool:
    library = getattr(TARGETS[lab], "LIBRARY", None)
    return library is None or code in library


def _traced_object(written: dict[str, Any], on_stage: dict[str, Any], spec: TraceSpec) -> str:
    pool = {**on_stage, **written}
    named = spec.on if spec.on in pool and pool[spec.on].get("lab") != "code" else None
    candidates = [name for name, obj in pool.items() if obj.get("lab") in TARGETS and (named is None or name == named)]
    if len(candidates) > 1 and named is None:
        data = [name for name in candidates if pool[name]["lab"] != "code" and (pool[name]["lab"] != "array" or TARGETS["array"].holds_input(pool[name], spec.input))] or [name for name in candidates if pool[name]["lab"] == "code"] or candidates
        playing = [name for name in data if _plays(pool[name]["lab"], spec.code)] or [name for name in candidates if pool[name]["lab"] == "code"] or data
        in_step = [name for name in playing if name in written]
        chosen = sorted(in_step or playing, key=lambda name: list(TARGETS).index(pool[name]["lab"]))
        candidates = chosen[:1] if len({pool[name]["lab"] for name in chosen}) > 1 else chosen
    if len(candidates) == 1:
        return candidates[0]
    raise DirectiveError(
        f"trace directive: the Step's own scene or the Scene on stage must hold exactly one object of a Lab that can play a trace ({', '.join(TARGETS)}); found {len(candidates)}"
        + (f" named {spec.on!r}" if spec.on else "")
    )
