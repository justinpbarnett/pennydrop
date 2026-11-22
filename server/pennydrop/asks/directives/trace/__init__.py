from __future__ import annotations

import ast
import re
import sys
from typing import Any

from pydantic import BaseModel, ConfigDict

from ....tracer import ALGORITHMS, TraceError, Tracer
from . import code
from .code import shown_source
from .._support import MAX_STEP_OPERATIONS, DirectiveError, DirectiveTools, TracedRun, discover, limit_operations, parse_spec, trace_key

TRACE_TOTALS = ("comparisons", "swaps", "writes")
TARGETS = discover(sys.modules[__name__])

BRIEF = "The trace directive can play the {lab} Labs when a library algorithm or a short function of your own fits the Ask: then write no operations for it yourself. When none fits, show the idea with plain objects and operations."
GUIDE = "\n".join([
    "### Directive `trace`",
    '`"trace": {"code": "bubble_sort", "input": [4, 3, 2, 1]}` runs real code and plays every compare, swap and write of it on an object of a Lab, in order.',
    "`code` is the name of a library algorithm or the Python source of one function. Library algorithms and their input:",
    *(f"- `{algorithm.name}`: {algorithm.input_help}" for algorithm in ALGORITHMS.values()),
    "The same Step sets the traced object in its own `scene`, even when an earlier Step set it already, and `on` names it when the scene holds several objects of those Labs; without `on`, the first Lab below that can play the algorithm is traced. Labs that can play a trace: " + ", ".join(TARGETS) + ".",
    *(target.GUIDE for target in TARGETS.values()),
    "An `array` object is played only when its `values` equal the traced `input` list. A hash table, a stack or any other structure that the code builds is not that, so trace it on a `code` object alone, and show any array of buckets with plain operations after the run.",
    "The directive writes the operations and counters for you, so write no `do` entries for the traced run.",
    'Use the measured totals as `{trace.comparisons}`, `{trace.swaps}` or `{trace.writes}` inside `say` or text, and as `"answer": "trace.comparisons"` (or `swaps`, `writes`) in a number Challenge, in the Step that carries `trace` or in any later Step.',
    'The `{trace.name}` placeholders and the `"answer": "trace.name"` form work only in the Step that carries `trace` or after it, so a predict Challenge placed before the trace gives its answer as a plain number you worked out by hand, from an input small enough to count.',
    'For your own code, `code` is the whole source text of one function, such as `"def grow(balance, years):\\n    for _ in range(years):\\n        balance = balance * 1.05\\n    return balance"`, never a bare function name that is not in the library list',
    "Write the `input` with exactly the keys named above, such as `{\"array\": [1, 3, 5], \"target\": 3}` for binary_search, and never `arr` or other short names.",
    "For binary_search choose a target that is not the middle value of the array: the first guess is the middle, and a search that ends at once shows no halving, so aim for at least 3 comparisons.",
    "Keep the input small, 3 to 6 numbers, because a Step plays at most 40 operations.",
])


class TraceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    input: Any
    on: str | None = None


def prepare(step: dict[str, Any], _tools: DirectiveTools) -> dict[str, Any]:
    scene = step.get("scene")
    if not isinstance(scene, dict):
        return step
    return {**step, "scene": {name: _with_library_source(spec) for name, spec in scene.items()}}


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
    if object_id in tools.staged and trace_key(raw) in tools.traced:
        return _without_replay(step, object_id), {}
    step = {**step, "scene": {**(step.get("scene") or {}), **{name: obj for name, obj in kept.items() if name == object_id or obj.get("lab") == "code"}}}
    target = TARGETS[step["scene"][object_id]["lab"]]
    library = getattr(target, "LIBRARY", None)
    if library and spec.code not in library:
        raise DirectiveError(f"trace directive: this Lab plays only a library algorithm, so write `code` as one of {', '.join(library)} with its input, not your own code")
    run = await _run(spec, tools.tracer)
    _require_a_search_worth_watching(spec, run)
    played = len(step.get("do", []))
    expanded = _with_code_following(target.apply(step, object_id, run), played, object_id, target, run)
    limit_operations("trace", expanded.get("do", [])[played:])
    return expanded, {f"trace.{name}": getattr(run.trace.counters, name) for name in TRACE_TOTALS}


def _require_a_search_worth_watching(spec: TraceSpec, run: TracedRun) -> None:
    values = spec.input.get("array") if isinstance(spec.input, dict) else None
    if spec.code == "binary_search" and isinstance(values, list) and len(values) >= 7 and run.trace.counters.comparisons < 3:
        raise DirectiveError(f"trace directive: binary_search found its target in {run.trace.counters.comparisons} comparisons, which shows no halving; to fix it, pick a \"target\" that sits near an end of the sorted array (not the middle value), so the search takes at least 3 comparisons")


def _require_the_array_shown(spec: TraceSpec, pool: dict[str, Any]) -> None:
    values = _traced_values(spec.input)
    arrays = {name: obj for name, obj in pool.items() if obj.get("lab") == "array" and isinstance(obj.get("values"), list)}
    if spec.code not in ALGORITHMS or spec.code in getattr(TARGETS["graph"], "LIBRARY", ()) or values is None or not arrays:
        return
    if any(TARGETS["array"].holds_input(obj, spec.input) for obj in arrays.values()):
        return
    name, shown = next(iter(arrays.items()))
    raise DirectiveError(f"trace directive: the array '{name}' on stage holds {shown['values']}, but the trace runs {spec.code} on {values}, so the picture and the counts would tell different stories; set the trace input to {shown['values']} so the run plays on '{name}', or set '{name}' to {values} in this Step's scene")


def _with_code_following(step: dict[str, Any], played: int, data_id: str, target: Any, run: TracedRun) -> dict[str, Any]:
    if not hasattr(target, "operations_by_event"):
        return step
    data_operations = target.operations_by_event(run, data_id)
    for name, obj in step["scene"].items():
        if isinstance(obj, dict) and obj.get("lab") == "code" and name != data_id:
            bare = {**step, "do": step["do"][:played]}
            full = code.follow(bare, name, run, data_operations)
            return full if len(full["do"]) - played <= MAX_STEP_OPERATIONS else code.follow(bare, name, run, data_operations, lines_only=True)
    return step


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
    return TracedRun(trace, spec.input, source)


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
