from __future__ import annotations

import ast
from typing import Any

import sympy
from pydantic import BaseModel, ConfigDict

from ._support import DirectiveError, DirectiveTools, fill_values, parse_spec

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


async def expand(step: dict[str, Any], raw: Any, _: DirectiveTools) -> dict[str, Any]:
    spec = parse_spec(MathSpec, raw, "math")
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
