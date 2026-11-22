from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ._support import DirectiveError, DirectiveTools, parse_spec
from .math import evaluate_over

TARGETS = ("plot",)
MAX_LINES = 3
HALF_WAY_WHOLE_FROM = 10
MAX_WHOLE_STEPS = 60
SAMPLES = 61
LINE_NAME = re.compile(r"^[a-z][a-z_]{0,19}$")

BRIEF = 'To plot the Ask\'s own quantity, such as money over years or distance over time, bring the {lab} Lab on stage with the curves directive: it computes every line from its formula and writes the plot object, so put no plot object in "scene" yourself. The plot\'s function families, linear, square and sine with a coefficient a, suit only an Ask about the shape, slope or area of those functions.'

GUIDE = "\n".join([
    "### Directive `curves`",
    '`"curves": {"on": "growth", "x": "years", "y": "dollars", "over": [0, 30], "lines": {"simple": "100 + 10*x", "compound": "100*1.1**x"}}` computes each line from its formula in x over that range of x and brings the plot `growth` on stage with every line still hidden. Carry it once, in the Step that first shows the plot, and write no plot object in that Step\'s "scene".',
    "Write each formula from the numbers the Ask gives, so every line shows the Ask's own quantity. Name each line with lowercase words joined by _, such as simple or compound: the legend shows that name. A plot holds at most 3 lines.",
    'A line appears with `{"op": "graph", "on": ["growth"], "curve": "simple"}`, and `"to": 10` draws it only up to x 10, so a later graph of the same line draws on from there. Step 1, the promise, may carry the directive and graph no line, so the empty axes of the Ask\'s own quantities stand on stage while it asks its question; never stand in for the Ask\'s lines with a function family or a shape. Otherwise bring the plot on stage in the Step that tells the first line, such as the normal case, and graph that line there; graph each further line in the Step whose narration tells it, so the stage moves as the story turns. `{"op": "mark", "on": ["growth"], "x": 30}` marks one x and shows the value of every line drawn through it.',
    'Hold the line that proves the point back for the reveal: graph it part way with "to" while the cause Steps explain it, ask the predict Challenge while its end is still hidden, such as a choice of where it ends or which line ends higher, and let the next Step graph the rest and mark the end. A learner cannot work out a number such as 1.1 to the 30th power, so ask a choice whose options are far apart rather than the exact value.',
    'The directive gives each line\'s value at the end of the range as `{curves.compound}`, for "say", text and a number Challenge\'s "answer". The narration says such a number only once the stage shows it, in the Step that marks that x or later.',
])


class CurvesSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    on: str = Field(min_length=1)
    x: str = Field(min_length=1, max_length=24)
    y: str = Field(min_length=1, max_length=24)
    over: tuple[float, float]
    lines: dict[str, str]


def prepare(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    step = _with_nested_curves_lifted(step)
    _require_curves_for_named_lines(step, tools)
    return step


def _with_nested_curves_lifted(step: dict[str, Any]) -> dict[str, Any]:
    scene = step.get("scene")
    if "curves" in step or not isinstance(scene, dict):
        return step
    for name, spec in scene.items():
        nested = spec.get("curves") if isinstance(spec, dict) and spec.get("lab") == "plot" else None
        if isinstance(nested, dict) and "lines" in nested:
            plot = {key: value for key, value in spec.items() if key != "curves"}
            directive = {**{key: plot[key] for key in ("x", "y") if key in plot}, **nested, "on": name}
            return {**step, "curves": directive, "scene": {**scene, name: plot}}
    return step


def _require_curves_for_named_lines(step: dict[str, Any], tools: DirectiveTools) -> None:
    if "curves" in step:
        return
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    plots = {name: spec for name, spec in {**tools.staged, **scene}.items() if isinstance(spec, dict) and spec.get("lab") == "plot"}
    for operation in step.get("do") or []:
        targets = operation.get("on") if isinstance(operation, dict) and operation.get("op") == "graph" and "curve" in operation else None
        if isinstance(targets, list) and len(targets) == 1 and targets[0] in plots and not plots[targets[0]].get("curves"):
            name, line = targets[0], operation["curve"]
            raise DirectiveError(f'curves directive: the plot {name} has no lines of its own yet, so graph cannot draw a "{line}" line; carry "curves": {{"on": "{name}", "x": "<x axis>", "y": "<y axis>", "over": [<first x>, <last x>], "lines": {{"{line}": "<formula in x>"}}}} in this Step, naming every line the Lesson graphs, keep the graph operations, and leave {name} out of "scene"')


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = parse_spec(CurvesSpec, raw, "curves")
    start, end = spec.over
    if start >= end:
        raise DirectiveError('curves directive: "over" gives the first and last x, with the first smaller, such as [0, 30]')
    if not 1 <= len(spec.lines) <= MAX_LINES:
        raise DirectiveError(f'curves directive: "lines" holds 1 to {MAX_LINES} named formulas, such as {{"simple": "100 + 10*x"}}')
    misnamed = [name for name in spec.lines if not LINE_NAME.match(name)]
    if misnamed:
        raise DirectiveError(f"curves directive: name each line with lowercase words joined by _, such as simple or compound, not {', '.join(misnamed)}")
    xs = _samples(start, end)
    lines = {name: [[x, y] for x, y in zip(xs, evaluate_over(formula, "x", xs, "curves"))] for name, formula in spec.lines.items()}
    values = {f"curves.{name}": _shown(points[-1][1]) for name, points in lines.items()}
    scene = step.get("scene") or {}
    staged = tools.staged.get(spec.on) or {}
    if spec.on not in scene and (staged.get("lab"), staged.get("curves"), staged.get("x"), staged.get("y")) == ("plot", lines, spec.x, spec.y):
        return step, values
    written = scene.get(spec.on) if isinstance(scene.get(spec.on), dict) else {}
    if written and written.get("lab") != "plot":
        raise DirectiveError(f'curves directive: "on" names {spec.on}, but this Step\'s "scene" makes {spec.on} a {written.get("kind") or written.get("lab") or "different"} object; give the plot its own name, such as {spec.on}_plot, and keep that name in every graph and mark')
    plot = {**({"reading": written["reading"]} if "reading" in written else {}), "lab": "plot", "x": spec.x, "y": spec.y, "curves": lines}
    return {**step, "scene": {**scene, spec.on: plot}}, values


def graphed_half_way(step: dict[str, Any], plot: str, line: str, points: list[list[float]] | None) -> dict[str, Any] | None:
    operations = step.get("do") if isinstance(step.get("do"), list) else []
    drawn = [index for index, operation in enumerate(operations) if isinstance(operation, dict) and operation.get("op") == "graph" and operation.get("curve") == line and plot in (operation.get("on") or [])]
    if not points or not drawn:
        return None
    start, end = points[0][0], points[-1][0]
    half = start + (end - start) / 2
    cut = {**operations[drawn[-1]], "to": round(half) if end - start >= HALF_WAY_WHOLE_FROM else round(half, 1)}
    return {**step, "do": [*operations[: drawn[-1]], cut, *operations[drawn[-1] + 1 :]]}


def describe_value(name: str) -> str:
    return f"the {name.replace('_', ' ')} line at the end of the plot"


def _samples(start: float, end: float) -> list[int | float]:
    if start.is_integer() and end.is_integer() and end - start <= MAX_WHOLE_STEPS:
        return list(range(int(start), int(end) + 1))
    return [round(start + (end - start) * index / (SAMPLES - 1), 6) for index in range(SAMPLES)]


def _shown(value: int | float) -> int | float:
    return value if isinstance(value, int) else round(value, 2 if abs(value) >= 1 else 4)
