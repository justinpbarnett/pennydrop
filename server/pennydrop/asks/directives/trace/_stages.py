from __future__ import annotations

import ast
import json
from dataclasses import dataclass
from typing import Any

from .._support import DirectiveError, TracedRun

TAKEN_NODE_MARKERS = ("pop", "visit")

OperationsByEvent = list[tuple[int, list[dict[str, Any]]]]


@dataclass(frozen=True)
class Window:
    start: int
    end: int
    finished: bool

    def holds(self, position: int) -> bool:
        return self.start <= position < self.end or (position < 0 and self.start == 0 and self.end > 0)

    def of(self, by_event: OperationsByEvent) -> list[dict[str, Any]]:
        return [operation for position, operations in by_event if self.holds(position) for operation in operations]


def loop_turns(run: TracedRun) -> list[int]:
    entry = next((event.function for event in run.trace.events if event.type == "call"), None)
    function = next((node for node in ast.walk(ast.parse(run.source)) if isinstance(node, ast.FunctionDef) and node.name == entry), None)
    loop = next((node for node in function.body if isinstance(node, ast.For | ast.While)), None) if function else None
    if loop is None:
        return []
    return [position for position, event in enumerate(run.trace.events) if event.type == "line" and event.line == loop.lineno and event.stack == [entry]]


def node_turns(run: TracedRun) -> list[int]:
    return [position for position, event in enumerate(run.trace.events) if event.type == "call" and event.function in TAKEN_NODE_MARKERS]


def window(until: int | None, turns: list[int], by_event: OperationsByEvent, played: list[dict[str, Any]], run: TracedRun, code: str) -> Window:
    if until and not turns:
        raise DirectiveError(f'trace directive: {code} has no loop turns or visited nodes to stop after, so its whole run plays in one Step; leave out "until"')
    events = len(run.trace.events)
    last = _last_shown(by_event, played)
    start = 0 if last is None else next((turn for turn in turns if turn > last), events)
    end = events if until is None or until >= len(turns) else 0 if until == 0 else turns[until]
    if end < start:
        done = sum(1 for turn in turns[1:] if turn <= start)
        raise DirectiveError(f'trace directive: "until": {until} is earlier than the stage, which already shows the run through turn {done}; the stage cannot go back, so repeat the trace with "until": {done} to keep it as it is, or a later one to play more')
    return Window(start, end, finished=not any(position >= end for position, _ in by_event))


def _last_shown(by_event: OperationsByEvent, played: list[dict[str, Any]]) -> int | None:
    flat = [(position, _comparable(operation)) for position, operations in by_event for operation in operations]
    shown = [_comparable(operation) for operation in played]
    if not shown or len(shown) > len(flat) or [found for _, found in flat[: len(shown)]] != shown:
        return None
    return flat[len(shown) - 1][0]


def _comparable(operation: dict[str, Any]) -> str:
    return json.dumps({key: value for key, value in operation.items() if key != "cue"}, sort_keys=True, default=str)
