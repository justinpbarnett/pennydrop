from __future__ import annotations

import ast
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import sympy
from pydantic import BaseModel, ConfigDict, ValidationError

from ..tracer import ALGORITHMS, Trace, TraceError, Tracer
from .lesson_format import describe

MAX_TRACE_OPS = 40
MAX_EXPRESSION_CHARACTERS = 200
PROBE_POINTER = "probe"
ARRAY_LAB = "array"
COUNTED_EVENTS = ("comparisons", "swaps")
TRACE_TOTALS = ("comparisons", "swaps", "writes")


class DirectiveError(ValueError):
    pass


@dataclass(frozen=True)
class DirectiveTools:
    tracer: Tracer


@dataclass(frozen=True)
class Directive:
    guide: str
    expand: Callable[[dict[str, Any], Any, DirectiveTools], Awaitable[dict[str, Any]]]


class TraceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    input: Any
    on: str | None = None


class MathSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expr: str


async def expand_directives(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    expanded = dict(step)
    for name, directive in DIRECTIVES.items():
        if name in expanded:
            expanded = await directive.expand(expanded, expanded.pop(name), tools)
    return expanded


def directive_guides() -> str:
    return "\n\n".join(directive.guide for directive in DIRECTIVES.values())


def fill_values(step: dict[str, Any], values: dict[str, int | float]) -> dict[str, Any]:
    filled = _fill_text(step, {"{" + name + "}": str(value) for name, value in values.items()})
    challenge = filled.get("challenge")
    if isinstance(challenge, dict) and challenge.get("answer") in values:
        filled["challenge"] = {**challenge, "answer": values[challenge["answer"]]}
    return filled


def _fill_text(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        for token, text in replacements.items():
            value = value.replace(token, text)
        return value
    if isinstance(value, list):
        return [_fill_text(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _fill_text(item, replacements) for key, item in value.items()}
    return value


def _spec(model: type[BaseModel], raw: Any, name: str):
    try:
        return model.model_validate(raw)
    except ValidationError as error:
        raise DirectiveError(f"{name} directive: " + "; ".join(describe(error))) from None


async def _expand_trace(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> dict[str, Any]:
    spec = _spec(TraceSpec, raw, "trace")
    trace = await _run_trace(spec, tools.tracer)
    array_id = _traced_array(step, spec)
    operations = _operations(trace, array_id)
    if len(operations) > MAX_TRACE_OPS:
        raise DirectiveError(f"trace directive: the trace needs {len(operations)} operations and a Step plays at most {MAX_TRACE_OPS}; trace a smaller input")
    scene = {**step["scene"], array_id: _with_counters(step["scene"][array_id])}
    expanded = {**step, "scene": scene, "do": [*step.get("do", []), *operations]}
    return fill_values(expanded, {f"trace.{name}": getattr(trace.counters, name) for name in TRACE_TOTALS})


async def _run_trace(spec: TraceSpec, tracer: Tracer) -> Trace:
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


def _traced_array(step: dict[str, Any], spec: TraceSpec) -> str:
    arrays = [name for name, obj in (step.get("scene") or {}).items() if isinstance(obj, dict) and obj.get("lab") == ARRAY_LAB]
    if spec.on is not None:
        arrays = [name for name in arrays if name == spec.on]
    if len(arrays) != 1:
        raise DirectiveError(
            f"trace directive: the Step's own scene must set exactly one array object (found {len(arrays)}"
            + (f", 'on' is {spec.on!r}" if spec.on else "")
            + "), with values equal to the trace input, so the trace starts from known values"
        )
    values = _traced_list(spec.input)
    if values is None or step["scene"][arrays[0]].get("values") != values:
        raise DirectiveError(f"trace directive: array '{arrays[0]}' must have values equal to the traced list {values}, found {step['scene'][arrays[0]].get('values')}")
    return arrays[0]


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


SAFE_NAMES = {
    "sqrt": sympy.sqrt, "pi": sympy.pi, "E": sympy.E, "sin": sympy.sin, "cos": sympy.cos, "tan": sympy.tan,
    "asin": sympy.asin, "acos": sympy.acos, "atan": sympy.atan, "log": sympy.log, "exp": sympy.exp, "Abs": sympy.Abs,
    "Rational": sympy.Rational, "factorial": sympy.factorial, "floor": sympy.floor, "ceiling": sympy.ceiling,
    "binomial": sympy.binomial,
}
SAFE_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Call, ast.Load,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod, ast.FloorDiv, ast.USub, ast.UAdd,
)


async def _expand_math(step: dict[str, Any], raw: Any, _: DirectiveTools) -> dict[str, Any]:
    spec = _spec(MathSpec, raw, "math")
    return fill_values(step, {"math": evaluate(spec.expr)})


def evaluate(expression: str) -> int | float:
    source = expression.replace("^", "**")
    if len(source) > MAX_EXPRESSION_CHARACTERS:
        raise DirectiveError(f"math directive: the expression is longer than {MAX_EXPRESSION_CHARACTERS} characters")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as error:
        raise DirectiveError(f"math directive: '{expression}' is not an arithmetic expression: {error.msg}") from None
    for node in ast.walk(tree):
        if not isinstance(node, SAFE_NODES):
            raise DirectiveError(f"math directive: '{expression}' uses {type(node).__name__}, and only arithmetic is allowed")
        if isinstance(node, ast.Name) and node.id not in SAFE_NAMES:
            raise DirectiveError(f"math directive: unknown name '{node.id}'; allowed names: {', '.join(SAFE_NAMES)}")
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.keywords):
            raise DirectiveError(f"math directive: '{expression}' calls something other than a plain function such as sqrt(2)")
        if isinstance(node, ast.Constant) and not isinstance(node.value, int | float):
            raise DirectiveError(f"math directive: '{expression}' holds a constant that is not a number")
    value = sympy.sympify(source, locals=SAFE_NAMES)
    if not value.is_real:
        raise DirectiveError(f"math directive: '{expression}' does not evaluate to a real number")
    number = float(value.evalf(15))
    return int(number) if number.is_integer() else round(number, 6)


DIRECTIVES: dict[str, Directive] = {
    "trace": Directive(
        guide="\n".join([
            '### Directive `trace`',
            '`"trace": {"code": "bubble_sort", "input": [4, 3, 2, 1]}` runs real code and plays every compare, swap and write of it on an array object, in order.',
            "`code` is the name of a library algorithm or the Python source of one function. Library algorithms and their input:",
            *(f"- `{algorithm.name}`: {algorithm.input_help}" for algorithm in ALGORITHMS.values()),
            "The same Step must set one array object in its own `scene` with `values` equal to the input list.",
            "The directive writes the operations and the counters `comparisons` and `swaps` for you, so write no `do` entries for the traced run.",
            'Use the measured totals as `{trace.comparisons}`, `{trace.swaps}` or `{trace.writes}` inside `say` or text, and as `"answer": "trace.comparisons"` (or `swaps`, `writes`) in a number Challenge.',
            "Keep the input small, 3 to 6 numbers, because a Step plays at most 40 operations.",
        ]),
        expand=_expand_trace,
    ),
    "math": Directive(
        guide="\n".join([
            '### Directive `math`',
            '`"math": {"expr": "sqrt(3**2 + 4**2)"}` evaluates arithmetic exactly with SymPy.',
            'Write `{math}` where the result belongs, in `say`, in text, or in LaTeX, and `"answer": "math"` in a number Challenge.',
            "Names allowed: " + ", ".join(SAFE_NAMES) + ".",
        ]),
        expand=_expand_math,
    ),
}
