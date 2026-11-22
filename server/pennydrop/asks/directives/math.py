from __future__ import annotations

import ast
from typing import Any

import sympy
from pydantic import BaseModel, ConfigDict

from ._support import DirectiveError, DirectiveTools, parse_spec

MAX_EXPRESSION_CHARACTERS = 200
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

GUIDE = "\n".join([
    "### Directive `math`",
    '`"math": {"expr": "sqrt(3**2 + 4**2)"}` evaluates arithmetic exactly with SymPy.',
    'Write `{math}` where the result belongs, in `say`, in text, or in LaTeX, and `"answer": "math"` in a number Challenge.',
    "Names allowed: " + ", ".join(SAFE_NAMES) + ".",
])


class MathSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expr: str


async def expand(step: dict[str, Any], raw: Any, _: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = parse_spec(MathSpec, raw, "math")
    return step, {"math": evaluate(spec.expr)}


def evaluate(expression: str) -> int | float:
    return _number(_parsed(expression, "math"), expression, "math")


def evaluate_over(expression: str, variable: str, points: list[int | float], directive: str) -> list[int | float]:
    symbol = sympy.Symbol(variable)
    parsed = _parsed(expression, directive, {variable: symbol})
    return [_number(parsed.subs(symbol, sympy.nsimplify(point)), expression, directive) for point in points]


def _parsed(expression: str, directive: str, variables: dict[str, sympy.Symbol] | None = None) -> sympy.Expr:
    names = {**SAFE_NAMES, **(variables or {})}
    source = expression.replace("^", "**")
    if len(source) > MAX_EXPRESSION_CHARACTERS:
        raise DirectiveError(f"{directive} directive: the expression is longer than {MAX_EXPRESSION_CHARACTERS} characters")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as error:
        raise DirectiveError(f"{directive} directive: '{expression}' is not an arithmetic expression: {error.msg}") from None
    for node in ast.walk(tree):
        if not isinstance(node, SAFE_NODES):
            raise DirectiveError(f"{directive} directive: '{expression}' uses {type(node).__name__}, and only arithmetic is allowed")
        if isinstance(node, ast.Name) and node.id not in names:
            raise DirectiveError(f"{directive} directive: unknown name '{node.id}'; allowed names: {', '.join(names)}")
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.keywords):
            raise DirectiveError(f"{directive} directive: '{expression}' calls something other than a plain function such as sqrt(2)")
        if isinstance(node, ast.Constant) and not isinstance(node.value, int | float):
            raise DirectiveError(f"{directive} directive: '{expression}' holds a constant that is not a number")
    return sympy.sympify(source, locals=names)


def _number(value: sympy.Expr, expression: str, directive: str) -> int | float:
    if not value.is_real:
        raise DirectiveError(f"{directive} directive: '{expression}' does not evaluate to a real number")
    number = float(value.evalf(15))
    return int(number) if number.is_integer() else round(number, 6)
