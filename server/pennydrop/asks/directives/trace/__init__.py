from __future__ import annotations

import ast
import sys
from typing import Any

from pydantic import BaseModel, ConfigDict

from ....tracer import ALGORITHMS, Trace, TraceError, Tracer
from .._support import DirectiveError, DirectiveTools, discover, fill_values, parse_spec

MAX_TRACE_OPS = 40
TRACE_TOTALS = ("comparisons", "swaps", "writes")
TARGETS = discover(sys.modules[__name__])

GUIDE = "\n".join([
    "### Directive `trace`",
    '`"trace": {"code": "bubble_sort", "input": [4, 3, 2, 1]}` runs real code and plays every compare, swap and write of it on an object of a Lab, in order.',
    "`code` is the name of a library algorithm or the Python source of one function. Library algorithms and their input:",
    *(f"- `{algorithm.name}`: {algorithm.input_help}" for algorithm in ALGORITHMS.values()),
    "The same Step sets the traced object in its own `scene`. Labs that can play a trace: " + ", ".join(TARGETS) + ".",
    *(target.GUIDE for target in TARGETS.values()),
    "The directive writes the operations and counters for you, so write no `do` entries for the traced run.",
    'Use the measured totals as `{trace.comparisons}`, `{trace.swaps}` or `{trace.writes}` inside `say` or text, and as `"answer": "trace.comparisons"` (or `swaps`, `writes`) in a number Challenge.',
    "Keep the input small, 3 to 6 numbers, because a Step plays at most 40 operations.",
])


class TraceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    input: Any
    on: str | None = None


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> dict[str, Any]:
    spec = parse_spec(TraceSpec, raw, "trace")
    trace = await _run(spec, tools.tracer)
    object_id = _traced_object(step, spec)
    target = TARGETS[step["scene"][object_id]["lab"]]
    played = len(step.get("do", []))
    expanded = target.apply(step, object_id, trace, spec.input)
    if len(expanded.get("do", [])) - played > MAX_TRACE_OPS:
        raise DirectiveError(f"trace directive: the trace needs {len(expanded['do']) - played} operations and a Step plays at most {MAX_TRACE_OPS}; trace a smaller input")
    return fill_values(expanded, {f"trace.{name}": getattr(trace.counters, name) for name in TRACE_TOTALS})


async def _run(spec: TraceSpec, tracer: Tracer) -> Trace:
    try:
        trace = await (tracer.trace_named(spec.code, spec.input) if spec.code in ALGORITHMS else tracer.trace_source(spec.code, _entry_point(spec.code), spec.input))
    except TraceError as error:
        raise DirectiveError(f"trace directive: {error}") from None
    if trace.error:
        raise DirectiveError(f"trace directive: the traced code raised {trace.error}")
    if trace.truncated:
        raise DirectiveError("trace directive: the traced code ran too long to play; trace a smaller input")
    return trace


def _entry_point(source: str) -> str:
    try:
        functions = [node.name for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)]
    except SyntaxError as error:
        raise DirectiveError(f"trace directive: code is neither a library algorithm ({', '.join(ALGORITHMS)}) nor valid Python: {error}") from None
    if not functions:
        raise DirectiveError("trace directive: Python code needs one top level function to call")
    return functions[0]


def _traced_object(step: dict[str, Any], spec: TraceSpec) -> str:
    candidates = [
        name for name, obj in (step.get("scene") or {}).items()
        if isinstance(obj, dict) and obj.get("lab") in TARGETS and (spec.on is None or name == spec.on)
    ]
    if len(candidates) != 1:
        raise DirectiveError(
            f"trace directive: the Step's own scene must set exactly one object of a Lab that can play a trace ({', '.join(TARGETS)}); found {len(candidates)}"
            + (f" named {spec.on!r}" if spec.on else "")
        )
    return candidates[0]
