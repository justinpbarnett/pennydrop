from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

ARRAY_LAB = "array"
ARRAY_DEF = "lab:array"
PLOT_LAB = "plot"
PLOT_DEF = "lab:plot"
CELL = re.compile(r"^(?P<array>[\w-]+)\[(?P<index>\d+)\]$")
NUMBER = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)?")
SAME_NUMBER_SHARE = 0.005
MOVES = ("compare", "swap", "set", "pointer")


@dataclass(frozen=True)
class ArrayPlay:
    name: str
    before: tuple[Any, ...]
    after: tuple[Any, ...]
    moves: tuple[str, ...]

    def told(self) -> str:
        change = f"stays {list(self.before)}" if self.before == self.after else f"goes from {list(self.before)} to {list(self.after)}"
        return f"the {self.name} array {change}: {'; '.join(self.moves)}"

    def shown(self) -> str:
        return f"the {self.name} array shows {list(self.after)}"


@dataclass(frozen=True)
class DrawnLine:
    name: str
    start: tuple[float, float]
    end: tuple[float, float]


@dataclass(frozen=True)
class PlotView:
    name: str
    x: str
    lines: tuple[DrawnLine, ...]
    unfinished: tuple[str, ...]
    graphed: tuple[str, ...]
    ends: dict[str, float]

    def end_told_early(self, say: str) -> tuple[str, float] | None:
        said = [float(found.replace(",", "")) for found in NUMBER.findall(say)]
        for line in self.unfinished:
            end = self.ends[line]
            if any(abs(number - end) <= max(0.5, abs(end) * SAME_NUMBER_SHARE) for number in said):
                return line, end
        return None

    def shown(self) -> str:
        drawn = "; ".join(f"the {line.name} line from {_number(line.start[1])} at {self.x} {_number(line.start[0])} to {_number(line.end[1])} at {self.x} {_number(line.end[0])}" for line in self.lines)
        return f"the {self.name} plot draws {drawn}" if self.lines else f"the {self.name} plot draws no line yet"


def plot_views(scene_before: Any, step: dict[str, Any]) -> list[PlotView]:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    plots = {name: plot for name, plot in {**_plots_on_stage(scene_before), **_plots_brought_in(scene)}.items() if not (name in scene and scene[name] is None)}
    graphed: dict[str, list[str]] = {name: [] for name in plots}
    for operation in step.get("do") or []:
        targets = operation.get("on") if isinstance(operation, dict) and operation.get("op") == "graph" else None
        if not (isinstance(targets, list) and len(targets) == 1 and targets[0] in plots and operation.get("curve") in plots[targets[0]].lines):
            continue
        plot, line = plots[targets[0]], operation["curve"]
        to = operation.get("to")
        plot.drawn_to[line] = to if isinstance(to, int | float) and not isinstance(to, bool) else plot.lines[line][-1][0]
        graphed[targets[0]].append(line)
    return [plot.view(name, tuple(dict.fromkeys(graphed[name]))) for name, plot in plots.items()]


@dataclass
class _Plot:
    x: str
    lines: dict[str, list[list[float]]]
    drawn_to: dict[str, float]

    def view(self, name: str, graphed: tuple[str, ...]) -> PlotView:
        drawn = tuple(DrawnLine(line, tuple(points[0]), (reach, _value_at(points, reach))) for line, points in self.lines.items() if (reach := self.drawn_to.get(line)) is not None)
        unfinished = tuple(line for line, points in self.lines.items() if self.drawn_to.get(line, -float("inf")) < points[-1][0])
        return PlotView(name, self.x, drawn, unfinished, graphed, {line: points[-1][1] for line, points in self.lines.items()})


def array_plays(scene_before: Any, step: dict[str, Any]) -> list[ArrayPlay]:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    before = {name: values for name, values in {**_arrays_on_stage(scene_before), **_arrays_brought_in(scene)}.items() if not (name in scene and scene[name] is None)}
    after = {name: list(values) for name, values in before.items()}
    moves: dict[str, list[str]] = {name: [] for name in before}
    for operation in step.get("do") or []:
        if not isinstance(operation, dict) or operation.get("op") not in MOVES:
            continue
        cells = [found for target in operation.get("on") or [] if (found := CELL.match(str(target))) and found["array"] in after]
        if not cells or len({found["array"] for found in cells}) > 1:
            continue
        name = cells[0]["array"]
        indexes = [int(found["index"]) for found in cells]
        if all(index < len(after[name]) for index in indexes):
            moves[name].append(_move(operation, after[name], indexes))
    return [ArrayPlay(name, tuple(values), tuple(after[name]), tuple(moves[name])) for name, values in before.items()]


def _move(operation: dict[str, Any], values: list[Any], indexes: list[int]) -> str:
    kind = operation["op"]
    if kind == "compare" and len(indexes) == 2:
        return f"compares {values[indexes[0]]} with {values[indexes[1]]}"
    if kind == "swap" and len(indexes) == 2:
        first, second = indexes
        values[first], values[second] = values[second], values[first]
        return f"{values[second]} and {values[first]} swap places"
    if kind == "set":
        index = indexes[0]
        unchanged = values[index] == operation.get("value")
        values[index] = operation.get("value")
        return f"{values[index]} stays at index {index}" if unchanged else f"{values[index]} moves to index {index}"
    pointer = f"the {operation['name']} pointer" if isinstance(operation.get("name"), str) else "a pointer"
    return f"{pointer} points at {values[indexes[0]]} at index {indexes[0]}"


def _arrays_on_stage(scene: Any) -> dict[str, list[Any]]:
    objects = scene.get("objects") if isinstance(scene, dict) else None
    return {
        found["id"]: [cell.get("value") for cell in found["state"]["cells"]]
        for found in objects or []
        if isinstance(found, dict) and found.get("defKey") == ARRAY_DEF and isinstance(found.get("state"), dict) and isinstance(found["state"].get("cells"), list)
    }


def _arrays_brought_in(scene: dict[str, Any]) -> dict[str, list[Any]]:
    return {name: list(spec["values"]) for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") == ARRAY_LAB and isinstance(spec.get("values"), list)}


def _plots_on_stage(scene: Any) -> dict[str, _Plot]:
    objects = scene.get("objects") if isinstance(scene, dict) else None
    return {
        found["id"]: _Plot(str(state.get("xName", "x")), {line["name"]: line["points"] for line in state["lines"] if isinstance(line, dict)}, dict(state.get("drawnTo") or {}))
        for found in objects or []
        if isinstance(found, dict) and found.get("defKey") == PLOT_DEF and isinstance(state := found.get("state"), dict) and state.get("kind") == "curves" and isinstance(state.get("lines"), list)
    }


def _plots_brought_in(scene: dict[str, Any]) -> dict[str, _Plot]:
    return {name: _Plot(str(spec.get("x", "x")), dict(spec["curves"]), {}) for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") == PLOT_LAB and _drawable(spec.get("curves"))}


def _drawable(curves: Any) -> bool:
    return isinstance(curves, dict) and all(isinstance(points, list) and points and all(_is_point(point) for point in points) for points in curves.values())


def _is_point(point: Any) -> bool:
    return isinstance(point, list) and len(point) == 2 and all(isinstance(number, int | float) and not isinstance(number, bool) for number in point)


def _value_at(points: list[list[float]], x: float) -> float:
    after = next((index for index, point in enumerate(points) if point[0] >= x), len(points) - 1)
    if after == 0 or points[after][0] <= x:
        return points[after][1]
    (xa, ya), (xb, yb) = points[after - 1], points[after]
    return ya + (yb - ya) * (x - xa) / (xb - xa)


def _number(value: float) -> str:
    return f"{value:,.2f}".rstrip("0").rstrip(".") if isinstance(value, float) else f"{value:,}"
