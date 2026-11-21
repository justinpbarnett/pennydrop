from __future__ import annotations

import ast
import sys
from typing import Any

from pydantic import BaseModel, ConfigDict

from ....tracer import ALGORITHMS, TraceError, Tracer
from .code import shown_source
from .._support import DirectiveError, DirectiveTools, TracedRun, discover, limit_operations, parse_spec

TRACE_TOTALS = ("comparisons", "swaps", "writes")
TARGETS = discover(sys.modules[__name__])

GUIDE = "\n".join([
    "### Directive `trace`",
    '`"trace": {"code": "bubble_sort", "input": [4, 3, 2, 1]}` runs real code and plays every compare, swap and write of it on an object of a Lab, in order.',
    "`code` is the name of a library algorithm or the Python source of one function. Library algorithms and their input:",
    *(f"- `{algorithm.name}`: {algorithm.input_help}" for algorithm in ALGORITHMS.values()),
    "The same Step sets the traced object in its own `scene`, even when an earlier Step set it already, and `on` names it when the scene holds several objects of those Labs; without `on`, the first Lab below that can play the algorithm is traced. Labs that can play a trace: " + ", ".join(TARGETS) + ".",
    *(target.GUIDE for target in TARGETS.values()),
    "The directive writes the operations and counters for you, so write no `do` entries for the traced run.",
    'Use the measured totals as `{trace.comparisons}`, `{trace.swaps}` or `{trace.writes}` inside `say` or text, and as `"answer": "trace.comparisons"` (or `swaps`, `writes`) in a number Challenge, in the Step that carries `trace` or in any later Step.',
    "Keep the input small, 3 to 6 numbers, because a Step plays at most 40 operations.",
])


class TraceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    input: Any
    on: str | None = None


def prepare(step: dict[str, Any]) -> dict[str, Any]:
    scene = step.get("scene")
    if not isinstance(scene, dict):
        return step
    return {**step, "scene": {name: _with_library_source(spec) for name, spec in scene.items()}}


def _with_library_source(spec: Any) -> Any:
    if isinstance(spec, dict) and spec.get("lab") == "code" and spec.get("source") in ALGORITHMS:
        return {"language": "python", **spec, "source": shown_source(ALGORITHMS[spec["source"]].source)}
    return spec


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = parse_spec(TraceSpec, raw, "trace")
    object_id = _traced_object(step, spec)
    target = TARGETS[step["scene"][object_id]["lab"]]
    library = getattr(target, "LIBRARY", None)
    if library and spec.code not in library:
        raise DirectiveError(f"trace directive: this Lab plays only a library algorithm, so write `code` as one of {', '.join(library)} with its input, not your own code")
    run = await _run(spec, tools.tracer)
    played = len(step.get("do", []))
    expanded = target.apply(step, object_id, run)
    limit_operations("trace", expanded.get("do", [])[played:])
    return expanded, {f"trace.{name}": getattr(run.trace.counters, name) for name in TRACE_TOTALS}


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


def _traced_object(step: dict[str, Any], spec: TraceSpec) -> str:
    candidates = [
        name for name, obj in (step.get("scene") or {}).items()
        if isinstance(obj, dict) and obj.get("lab") in TARGETS and (spec.on is None or name == spec.on)
    ]
    if len(candidates) > 1 and spec.on is None:
        playing = sorted((name for name in candidates if _plays(step["scene"][name]["lab"], spec.code)), key=lambda name: list(TARGETS).index(step["scene"][name]["lab"]))
        candidates = playing[:1] or candidates
    if len(candidates) != 1:
        raise DirectiveError(
            f"trace directive: the Step's own scene must set exactly one object of a Lab that can play a trace ({', '.join(TARGETS)}); found {len(candidates)}"
            + (f" named {spec.on!r}" if spec.on else "")
        )
    return candidates[0]
