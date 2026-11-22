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
    called = list(dict.fromkeys(event.function for event in run.trace.events if event.type == "call"))
    functions = {node.name: node for node in ast.walk(ast.parse(run.source)) if isinstance(node, ast.FunctionDef)}
    loops = {name: loop for name in called if name in functions and (loop := _outer_loop(functions[name]))}
    if not called:
        return []
    if called[0] in loops:
        return [position for position, event in enumerate(run.trace.events) if event.type == "line" and event.line == loops[called[0]].lineno and event.stack == called[:1]]
    helper = next((name for name in called[1:] if name in loops), None)
    return _first_loop_line_of_each_call(run, helper, loops[helper].lineno) if helper else []


def _outer_loop(function: ast.FunctionDef) -> ast.For | ast.While | None:
    return next((node for node in function.body if isinstance(node, ast.For | ast.While)), None)


def _first_loop_line_of_each_call(run: TracedRun, function: str, line: int) -> list[int]:
    calls: list[int] = []
    looped: set[int] = set()
    turns = []
    for position, event in enumerate(run.trace.events):
        if event.type == "call":
            calls.append(position)
        elif event.type == "return" and calls:
            calls.pop()
        elif event.type == "line" and event.line == line and event.stack[-1:] == [function] and calls and calls[-1] not in looped:
            looped.add(calls[-1])
            turns.append(position)
    return turns


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
        raise DirectiveError(_behind_the_stage(until, turns, start, events))
    return Window(start, end, finished=not any(position >= end for position, _ in by_event))


def _behind_the_stage(until: int, turns: list[int], start: int, events: int) -> str:
    if start >= events:
        return f'trace directive: "until": {until} is earlier than the stage, which already shows the run played to its end; the stage cannot go back, so repeat the trace with no "until" to keep it as it is'
    done = sum(1 for turn in turns[1:] if turn <= start)
    return f'trace directive: "until": {until} is earlier than the stage, which already shows the run through turn {done}; the stage cannot go back, so repeat the trace with "until": {done} to keep it as it is, a later one to play more, or no "until" to play the run to its end'


def _last_shown(by_event: OperationsByEvent, played: list[dict[str, Any]]) -> int | None:
    flat = [(position, _comparable(operation)) for position, operations in by_event for operation in operations]
    matched = 0
    for operation in played:
        if matched < len(flat) and flat[matched][1] == _comparable(operation):
            matched += 1
    return flat[matched - 1][0] if matched else None


def _comparable(operation: dict[str, Any]) -> str:
    return json.dumps({key: value for key, value in operation.items() if key != "cue"}, sort_keys=True, default=str)
