from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .directives import directives_for_labs
from .directives._support import Hinge, Runs, operation_targets, trace_key, with_nested_trace_lifted
from .directives.simulate import contradictions, filled_from
from .directives.trace import CONTRAST_RUN, MAIN_RUN, TRACE_TOTALS
from .directives.trace.array import holds_input
from .played_hops import PlayedHops
from .played_setups import PlayedSetups

SHOWN_TEXT_FIELDS = ("text", "caption", "label", "title")
LAB_KEY_PREFIX = "lab:"
TRACE_TOTAL_PREFIX = "trace."
STANDS_ALONE = r"(?<![\w.]){}(?![\w]|\.\d)"
CELL_ANSWER = re.compile(r"([\w-]+)\[(\d+)\]")


STRUCTURE_FIELDS = ("nodes", "values", "items", "edges", "cells", "rows")
INSERTED = re.compile(r"\binsert(?:s|ed|ing)?\s+(?:the\s+|a\s+)?(?:value\s+|number\s+|key\s+|item\s+|element\s+)?(\w+)", re.IGNORECASE)
NUMBER_WORDS = {word: str(number) for number, word in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}


def _as_value(word: str) -> str:
    return NUMBER_WORDS.get(word.lower(), word.lower())


def _scalars(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [item for inner in value.values() for item in _scalars(inner)]
    if isinstance(value, list):
        return [item for inner in value for item in _scalars(inner)]
    return [] if value is None or isinstance(value, bool) else [str(value).lower()]


def _holds_nothing(spec: dict[str, Any]) -> bool:
    contents = [value for key, value in spec.items() if key != "parts" and isinstance(value, list | dict)]
    return bool(contents) and not any(contents)


FRONTIER_OPERATIONS = ("push", "pop", "relax")
LOOKS = ("highlight", "clear")
RUNS_IN_DO = 'do: a "trace" entry in "do" plays no run, since a Step plays one run through its own top-level "trace"; carry the run this Step moves in "trace", take every "trace" entry out of "do", and leave a run that an earlier Step finished as it is, because it stays on stage as it ended'
RUN_OBJECTS = (MAIN_RUN, CONTRAST_RUN)


ASKS_TO_PREDICT = re.compile(r"(?:^|[.!?]\s+|\b(?:can you|try to|pause and|stop and|take a (?:moment|second) to|go ahead and|now)\s+|,\s*)(?:predict|guess)\b|\bmake a (?:prediction|guess)\b|\bwhat (?:do|would|will) you (?:predict|guess)\b|\byour (?:prediction|guess)\b", re.IGNORECASE)


ASKS_TO_TAP = re.compile(r"(?:^|[.!?]\s+|\b(?:can you|try to|go ahead and|now)\s+)(?:tap|touch|press|click)\b", re.IGNORECASE)


def question_without_challenge(step: dict[str, Any]) -> list[str]:
    say = step.get("say")
    if not isinstance(say, str) or step.get("challenge"):
        return []
    if ASKS_TO_PREDICT.search(say):
        return [f'step {step.get("step")} say: the narration asks the learner to predict, but this Step has no "challenge"; add a predict Challenge whose answer the narration and the scene do not show, or take the request to predict out of the narration']
    if ASKS_TO_TAP.search(say):
        return [f'step {step.get("step")} say: the narration asks the learner to tap, but this Step has no "challenge"; add a click Challenge whose answer is the object or part to tap, or take the request to tap out of the narration']
    return []


def _how_to_fill(lab: str) -> str:
    if directives_for_labs((lab,)).get(lab) == "simulate":
        return f'carry a "simulate" directive for the {lab} Lab in this Step instead, which draws the figure; to show it before the run starts, give that simulation "until": 0'
    return "fill it with its data, or let a directive fill it, or remove it"


@dataclass(frozen=True)
class NextRun:
    contrast: bool
    beside_another: bool
    until: int | None

    @property
    def name(self) -> str:
        return "contrast run" if self.contrast else "main run" if self.beside_another else "run"


class Stage:
    def __init__(self, snapshot: Any = None, runs: Runs = Runs(), kid: bool = False, charts_quantities: bool = False):
        self.runs = runs
        self.kid = kid
        self.charts_quantities = charts_quantities
        self.specs: dict[str, dict[str, Any]] = {}
        self.labs: dict[str, str] = {}
        self.traces: set[str] = set()
        self.finished_traces: set[str] = set()
        self.last_trace: dict[str, Any] = {}
        self.last_trace_on: dict[str, dict[str, Any]] = {}
        self.trace_untils: dict[str, int | None] = {}
        self.trace_counters: dict[str, set[str]] = {}
        self.running: dict[str, str] = {}
        self.shown_totals: dict[str, dict[str, Any]] = {}
        self.in_flight: set[str] = set()
        self.lost_runs = False
        self.drawn_labs: dict[str, None] = {}
        self.played: list[tuple[str, dict[str, Any]]] = []
        self.retired: dict[str, dict[str, Any]] = {}
        self.declared: dict[str, dict[str, Any]] = {}
        self.moved: dict[str, list[str]] = {}
        self.simulations: dict[str, dict[str, Any]] = {}
        self.setups = PlayedSetups()
        self.hops = PlayedHops(warm_up_only_one=kid)
        for thing in (snapshot or {}).get("objects", []):
            key = str(thing.get("defKey", ""))
            if key.startswith(LAB_KEY_PREFIX):
                self.labs[thing["id"]] = key.removeprefix(LAB_KEY_PREFIX)

    def filled_trace(self, raw: Any) -> Any:
        raw = with_nested_trace_lifted(raw)
        if not isinstance(raw, dict):
            return raw
        on = raw.get("on")
        raw = {**raw, "on": on[0]} if isinstance(on, list) and len(on) == 1 else raw
        if "code" in raw and "input" in raw:
            return raw
        carried = self.last_trace_on.get(raw.get("on")) or self.last_trace
        return {**carried, **raw} if carried else raw

    def remember_trace(self, written: Any, settled: dict[str, Any], values: dict[str, Any]) -> None:
        raw = self.filled_trace(written.get("trace")) if isinstance(written, dict) else None
        key = trace_key(raw)
        if key is None:
            return
        self.traces.add(key)
        self.last_trace = {name: raw[name] for name in ("code", "input", "on") if name in raw}
        if isinstance(raw.get("on"), str):
            self.last_trace_on[raw["on"]] = self.last_trace
        self.trace_untils[key] = raw.get("until")
        if "until" not in raw:
            self.finished_traces.add(key)
        if totals := trace_totals(values):
            self.shown_totals[key] = totals
        for name, spec in (settled.get("scene") or {}).items():
            if isinstance(spec, dict) and spec.get("lab") == "array" and holds_input(spec, raw.get("input")):
                if "until" in raw:
                    self.running[name] = str(raw.get("code"))
                else:
                    self.running.pop(name, None)
            counters = spec.get("counters") if isinstance(spec, dict) else None
            if counters:
                self.trace_counters[name] = {str(counter) for counter in counters}

    @property
    def trace_until(self) -> int | None:
        return self.trace_untils.get(trace_key(self.last_trace))

    def until_shown_by(self, written: Any) -> int | None:
        raw = self.filled_trace(written.get("trace")) if isinstance(written, dict) else None
        return self.trace_untils.get(trace_key(raw))

    def run_left_unfinished(self, written: Any, values: dict[str, Any]) -> bool:
        main = self.traces - self.runs.side
        if not main or main & (self.finished_traces | self.shown_totals.keys()):
            return False
        raw = self.filled_trace(written.get("trace")) if isinstance(written, dict) else None
        if trace_key(raw) in self.runs.side:
            return True
        return not (trace_totals(values) or (isinstance(raw, dict) and "until" not in raw))

    def main_stop_before_side_run(self, written: Any) -> int | None:
        key = trace_key(self.filled_trace(written.get("trace")) if isinstance(written, dict) else None)
        main = self.traces - self.runs.side
        if not self.runs.main_first or key not in self.runs.side or key in self.traces or not main or main & (self.finished_traces | self.shown_totals.keys()):
            return None
        return max((self.trace_untils.get(run) or 0 for run in main), default=0)

    def side_stop_before_main_run(self, written: Any) -> int | None:
        key = trace_key(self.filled_trace(written.get("trace")) if isinstance(written, dict) else None)
        started = self.runs.side & self.traces
        if self.runs.main_first or key is None or key in self.runs.side or not started or started & (self.finished_traces | self.shown_totals.keys()):
            return None
        return max(self.trace_untils.get(run) or 0 for run in started)

    def misses_the_hinge(self, written: Any) -> Hinge | None:
        hinge = self._hinge_still_open(written)
        return None if hinge is None or self._on_the_hinge(hinge, written) else hinge

    def asks_the_planned_hinge(self, written: Any) -> bool:
        hinge = self._hinge_still_open(written)
        return hinge is not None and hinge.answer is not None and self._on_the_hinge(hinge, written)

    def open_hinge(self) -> Hinge | None:
        hinge = self.runs.hinge
        if hinge is None or hinge.run in self.finished_traces or (self.trace_untils.get(hinge.run) or 0) > hinge.until:
            return None
        return hinge

    def _hinge_still_open(self, written: Any) -> Hinge | None:
        challenge = written.get("challenge") if isinstance(written, dict) else None
        return self.open_hinge() if isinstance(challenge, dict) and challenge.get("kind") == "predict" else None

    def _on_the_hinge(self, hinge: Hinge, written: dict[str, Any]) -> bool:
        trace = self.filled_trace(written.get("trace"))
        if trace_key(trace) == hinge.run:
            stop = trace.get("until")
        else:
            stop = self.trace_untils.get(hinge.run) if hinge.run in self.traces else None
        return stop == hinge.until and (hinge.answer is None or written["challenge"].get("answer") == hinge.answer)

    def run_to_play_next(self) -> NextRun | None:
        played = self.finished_traces | self.shown_totals.keys()
        main = [(False, key) for key in sorted(self.traces - self.runs.side)]
        side = [(True, key) for key in sorted(self.runs.side)]
        for contrast, key in main + side if self.runs.main_first or not self.runs.side else side + main:
            if key not in played:
                return NextRun(contrast, bool(self.runs.side), self.trace_untils.get(key) if key in self.traces else None)
        return None

    def plays_last_run(self, written: Any) -> bool:
        key = trace_key(self.filled_trace(written.get("trace")) if isinstance(written, dict) else None)
        played = self.finished_traces | self.shown_totals.keys()
        if key in self.runs.side:
            main = self.traces - self.runs.side
            return bool(main) and main <= played
        return self.runs.side <= played

    def remember_simulation(self, written: Any) -> None:
        raw = written.get("simulate") if isinstance(written, dict) else None
        if isinstance(raw, dict) and isinstance(raw.get("lab"), str):
            self.simulations[raw["lab"]] = filled_from(raw, self.simulations)

    def unfinished_simulation(self) -> dict[str, Any] | None:
        return next((raw for lab, raw in self.simulations.items() if raw.get("until") is not None and lab in self.labs.values()), None)

    def errors_in_written(self, written: Any) -> list[str]:
        return self._graph_played_by_hand(written) + self._run_played_by_hand(written) + self._runs_in_do(written) + self._run_taken_off(written) + self._counters_owned_by_trace(written) + self._run_pointed_by_hand(written) + self._declared_again(written) + self._function_plotted(written) + self._left_blank(written) + self._code_for_child(written)

    def _runs_in_do(self, written: Any) -> list[str]:
        operations = written.get("do") if isinstance(written, dict) and isinstance(written.get("do"), list) else []
        if not any(isinstance(operation, dict) and operation.get("op") == "trace" and isinstance(operation.get("trace"), dict) for operation in operations):
            return []
        return [RUNS_IN_DO]

    def _code_for_child(self, written: Any) -> list[str]:
        scene = written.get("scene") if isinstance(written, dict) and isinstance(written.get("scene"), dict) else {}
        return [
            f'scene: {name} is a code Lab, and a child who cannot read cannot follow code, even when the Ask says code; write no code object, and show the run as bars instead: '
            'carry the trace directive with a library algorithm and no "on", such as "trace": {"code": "insertion_sort", "input": [5, 2, 4, 1, 3]}, which puts the array on stage as bars as tall as their values, and narrate what the bars do'
            for name, spec in scene.items()
            if self.kid and isinstance(spec, dict) and spec.get("lab") == "code"
        ]

    def _left_blank(self, written: Any) -> list[str]:
        scene = written.get("scene") if isinstance(written, dict) and isinstance(written.get("scene"), dict) else {}
        operations = written.get("do") if isinstance(written, dict) and isinstance(written.get("do"), list) else []
        written_on = {name for operation in operations if isinstance(operation, dict) and operation.get("op") == "write" for name in (operation.get("on") or [])}
        return [
            f'scene: {name} is a text with no words, which holds a blank space on the stage; give it the words it shows, or write them in this Step with {{"op": "write", "on": ["{name}"], "text": "<the words>"}}, or leave it out until a Step has words for it'
            for name, spec in scene.items()
            if isinstance(spec, dict) and spec.get("kind") == "text" and not str(spec.get("text") or "").strip() and name not in written_on
        ]

    def _function_plotted(self, written: Any) -> list[str]:
        scene = written.get("scene") if isinstance(written, dict) and isinstance(written.get("scene"), dict) else {}
        return [
            f'scene: {name} is a function plot, which graphs only ax, ax² or sin x between −2 and 2, but this Ask is about its own quantities, so no function plot can show them; '
            f'carry the curves directive instead, such as "curves": {{"on": "{name}", "x": "<x axis>", "y": "<y axis>", "over": [<first x>, <last x>], "lines": {{"<line name>": "<formula in x>"}}}}, with one formula for each quantity the Ask names, write no plot object in "scene", and draw a line with graph and "curve"'
            for name, spec in scene.items()
            if self.charts_quantities and isinstance(spec, dict) and spec.get("lab") == "plot" and "curves" not in spec
        ]

    def _run_taken_off(self, written: Any) -> list[str]:
        scene = written.get("scene") if isinstance(written, dict) and isinstance(written.get("scene"), dict) else {}
        return [f'scene: {name} is set to null, which takes the {name} run off the stage, but the two runs stay side by side from Step 1 to the last Step, since seeing both is the proof; keep {name} on stage and leave it out of this Step\'s scene' for name in sorted(self.runs.kept_on_stage) if name in scene and scene[name] is None]

    def _declared_again(self, written: Any) -> list[str]:
        scene = written.get("scene") if isinstance(written, dict) and isinstance(written.get("scene"), dict) else {}
        return [
            f'scene: {name} is declared again with the spec it had before {" and ".join(dict.fromkeys(self.moved[name]))} were played on it, so it would show a state the story has moved past and the narration would contradict the stage; '
            f'keep {name} on stage and continue it with "do", or give a spec that shows its state now, such as the change those operations made, because a spec sets the object to exactly what it describes'
            for name, spec in scene.items()
            if isinstance(spec, dict) and self.moved.get(name) and _without_counters(self.declared.get(name)) == _without_counters(spec)
        ]

    def _graph_played_by_hand(self, written: Any) -> list[str]:
        if not isinstance(written, dict) or "trace" in written:
            return []
        scene = written.get("scene") if isinstance(written.get("scene"), dict) else {}
        graphs = {name: {**self.specs.get(name, {}), **(scene[name] if isinstance(scene.get(name), dict) else {})} for name, lab in self.labs.items() if lab == "graph"}
        graphs |= {name: spec for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") == "graph"}
        by_hand = sorted({
            name
            for operation in written.get("do", [])
            if isinstance(operation, dict)
            for target in operation.get("on", [])
            if isinstance(target, str) and (name := target.split("[")[0]) in graphs
            and (operation.get("op") in FRONTIER_OPERATIONS or (operation.get("op") == "visit" and graphs[name].get("frontier")))
        })
        carry = 'Step 1 only asks the question, so remove those operations and carry the "trace" with "until": 0, which draws the graph and plays none of the walk' if written.get("step") == 1 else 'carry a "trace" in this Step, with an "until" that stops after the nodes this Step\'s narration names, and write none of those operations'
        return [f'{name}: a graph search written by hand with push, pop, relax or visit over a frontier goes wrong as soon as one neighbor is missed; when a library algorithm fits (breadth_first_search, depth_first_search, dijkstra), {carry}; for a tree you build or walk by hand, leave out "frontier" and use visit only to point at the node being compared' for name in by_hand]

    def _run_played_by_hand(self, written: Any) -> list[str]:
        if not self.runs.side or not isinstance(written, dict):
            return []
        trace = self.filled_trace(written.get("trace"))
        key = trace_key(trace)
        traced = None if key is None else CONTRAST_RUN if key in self.runs.side else MAIN_RUN
        on = trace.get("on") if isinstance(trace, dict) else None
        named = on if isinstance(on, list) else [on]
        elsewhere = [] if traced is None or traced in named else [f'trace: "on" names {json.dumps(on)}, but this trace is the {traced} run, which plays only on the object with the id "{traced}"; set "on" to "{traced}", and keep each run on its own object so the two stay side by side']
        played = sorted({
            name
            for operation in written.get("do", [])
            if isinstance(operation, dict) and operation.get("op") not in (*LOOKS, "trace")
            for name in operation_targets(operation)
            if name in RUN_OBJECTS and name != traced
        })
        return elsewhere + [f'{name}: this Step plays the {name} run with "do" entries of its own, but that run plays only through the trace the brief gives for it, so the stage moves as the real code does and its counter ends at the real total; carry that trace exactly in this Step, with an "until" at the stop this Step reaches, write none of the run\'s operations, and narrate only the turns it plays' for name in played]

    def _run_pointed_by_hand(self, written: Any) -> list[str]:
        if not isinstance(written, dict) or "trace" in written:
            return []
        pointed = sorted({
            name
            for operation in written.get("do") or []
            if isinstance(operation, dict) and operation.get("op") in ("pointer", "window")
            for name in operation_targets(operation)
            if name in self.running or (self.kid and self.labs.get(name) == "array")
        })
        return [
            f'{name}: its {self.running[name]} run is still playing, and its pointers and window come only from that run, so one written by hand puts the stage out of step with the code; to show the next part of the run, carry the same trace with a later "until", and to point at a value, highlight it'
            if name in self.running
            else f'{name}: a child sees a search as bars, and its pointer and window come only from a traced search, so trace binary_search or linear_search on these bars with "until" to play one look at a time, and to point at a bar, highlight it'
            for name in pointed
        ]

    def _counters_owned_by_trace(self, written: Any) -> list[str]:
        operations = written.get("do") if isinstance(written, dict) and "trace" not in written else None
        if not isinstance(operations, list) or not self.trace_counters:
            return []
        changed = {
            (target, counter)
            for operation in operations
            if isinstance(operation, dict)
            for target in (operation.get("on") if isinstance(operation.get("on"), list) else [])
            for counter in (operation.get("count"), operation.get("name") if operation.get("op") == "counter" else None)
            if isinstance(counter, str)
        }
        owned = sorted(f"{counter} on {name}" for name, counters in self.trace_counters.items() for counter in counters if (name, counter) in changed)
        return [f"the trace owns the counter {entry}, and its value is final; remove the operation that changes it, and let the narration state the trace's own count" for entry in owned]

    def on_stage(self) -> dict[str, dict[str, Any]]:
        return {name: self.specs.get(name, {"lab": lab}) for name, lab in self.labs.items() if not _holds_nothing(self.specs.get(name, {"lab": lab}))}

    def settle(self, step: dict[str, Any]) -> None:
        self.attach_parts(step)
        self._remember_play(step)
        self.setups.remember(step)
        self.hops.remember(step)
        self.in_flight -= {name for name, spec in (step.get("scene") or {}).items() if not isinstance(spec, dict) or name in self.specs}
        for operation in step.get("do", []):
            targets = operation.get("on")
            if operation.get("op") in ("send", "retransmit", "receive", "drop") and isinstance(targets, list) and len(targets) == 1:
                (self.in_flight.add if operation["op"] in ("send", "retransmit") else self.in_flight.discard)(targets[0])
        for name, spec in (step.get("scene") or {}).items():
            if not isinstance(spec, dict):
                if name in self.specs:
                    self.retired[name] = self.specs[name]
                self.specs.pop(name, None)
                self.labs.pop(name, None)
                continue
            self.retired.pop(name, None)
            self.declared[name] = spec
            self.moved.pop(name, None)
            self.specs[name] = spec
            if isinstance(spec.get("lab"), str):
                self.labs[name] = spec["lab"]
                self.drawn_labs.setdefault(spec["lab"])
            else:
                self.labs.pop(name, None)
        self._remember_moves(step)

    def _remember_moves(self, step: dict[str, Any]) -> None:
        for operation in step.get("do", []):
            if isinstance(operation, dict) and isinstance(operation.get("op"), str):
                for target in operation_targets(operation):
                    self.moved.setdefault(target, []).append(operation["op"])

    def _remember_play(self, step: dict[str, Any]) -> None:
        restated = set(step.get("scene") or {})
        self.played = [entry for entry in self.played if entry[0] not in restated]
        self.played += [(target, operation) for operation in step.get("do", []) if isinstance(operation, dict) for target in sorted(operation_targets(operation))]

    def attach_parts(self, step: dict[str, Any]) -> None:
        for operation in step.get("do", []):
            if operation.get("op") == "found" and operation.get("on", [None])[0] in self.specs:
                name = operation["on"][0]
                self.specs[name] = {**self.specs[name], "parts": operation.get("parts", [])}

    def off_the_outline(self, written: Any) -> list[str]:
        trace = self.filled_trace(written.get("trace")) if isinstance(written, dict) else None
        key = trace_key(trace)
        told = sorted(json.dumps(json.loads(run)["input"]) for run in self.runs.told if json.loads(run)["code"] == trace.get("code")) if key else []
        if not told or key in self.runs.told:
            return []
        inputs = " or ".join(f"`{shown}`" for shown in told)
        return [f'trace directive: the server already ran {trace["code"]} for this Lesson on {inputs}, as the brief gives; carry exactly that "input" in this trace, with no other field in it, so that every Step narrates the run the brief describes']

    def cell_place(self, step: dict[str, Any]) -> str | None:
        challenge = step.get("challenge")
        found = CELL_ANSWER.fullmatch(str(challenge.get("answer"))) if isinstance(challenge, dict) else None
        if found is None:
            return None
        spec = (step.get("scene") or {}).get(found[1]) or self.specs.get(found[1])
        values = spec.get("values") if isinstance(spec, dict) and spec.get("lab") == "array" else None
        index = int(found[2])
        if not isinstance(values, list) or index >= len(values):
            return None
        end = ", the first, at the left end" if index == 0 else ", the last, at the right end" if index == len(values) - 1 else ""
        return f"cell {index + 1} of the {len(values)} in the row, counting from the left{end}"

    def errors_in(self, step: dict[str, Any], written: Any, values: dict[str, Any]) -> list[str]:
        return answer_given_away(step) + self._insert_already_shown(step) + self._empty_figures(step) + self._empty_stage(step) + question_without_challenge(step) + self.off_the_outline(written) + self._total_already_shown(step, written, values) + self.unran_values(step, ran_something(written)) + contradictions(step, self.labs, self.played) + self.setups.errors_in(step) + self.hops.errors_in(step)

    def _total_already_shown(self, step: dict[str, Any], written: Any, values: dict[str, Any]) -> list[str]:
        challenge = step.get("challenge")
        answer = challenge.get("answer") if isinstance(challenge, dict) and challenge.get("kind") == "predict" else None
        if isinstance(answer, bool) or not isinstance(answer, int | float):
            return []
        shown = [trace_totals(values)] if isinstance(written, dict) and "trace" in written else list(self.shown_totals.values())
        named = [name for totals in shown for name, total in totals.items() if total == answer]
        if not named:
            return []
        return [f'step {step.get("step")} challenge: its answer {answer} is {{{named[0]}}}, and by the time the Challenge waits the stage has played the run to its end and shows that total, so the learner reads it off instead of predicting it; ask this predict Challenge in a Step before the end of the run, one that repeats the trace with an "until", and let the next Step, which carries the trace without "until", play the end and reveal the total']

    def _empty_stage(self, step: dict[str, Any]) -> list[str]:
        scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
        shown = {name for name in {*self.labs, *self.specs} if name not in scene} | {name for name, spec in scene.items() if isinstance(spec, dict)}
        if shown:
            return []
        return [f'step {step.get("step")} scene: the stage is empty while this Step speaks, so the learner looks at a blank screen; put on stage the figure the story is about, such as the run\'s object with its trace at "until": 0, which draws it and plays nothing']

    def _empty_figures(self, step: dict[str, Any]) -> list[str]:
        scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
        empty = [name for name, spec in scene.items() if isinstance(spec, dict) and isinstance(spec.get("lab"), str) and _holds_nothing(spec)]
        return [f"step {step.get('step')} scene: {name} is a {scene[name]['lab']} Lab figure with nothing in it; {_how_to_fill(scene[name]['lab'])}" for name in empty]

    def unran_values(self, step: dict[str, Any], ran: bool) -> list[str]:
        challenge = step.get("challenge")
        answer = challenge.get("answer") if isinstance(challenge, dict) else None
        if not self.lost_runs or ran or isinstance(answer, bool) or not isinstance(answer, int | float):
            return []
        return ["the challenge answer comes from a trace or simulation that a shipped Step never ran; first show the run in this Step (with the trace or simulate directive) and make the answer the value it ends with, or ask a Challenge that needs no run"]

    def _insert_already_shown(self, step: dict[str, Any]) -> list[str]:
        challenge = step.get("challenge")
        say = step.get("say")
        if not isinstance(challenge, dict) or not isinstance(say, str):
            return []
        scene = {name: spec for name, spec in {**self.specs, **(step.get("scene") or {})}.items() if isinstance(spec, dict)}
        shown = {value for spec in scene.values() for key in STRUCTURE_FIELDS for value in _scalars(spec.get(key))}
        announced = [value for value in map(_as_value, INSERTED.findall(say)) if value.isdigit()]
        already = [value for value in dict.fromkeys(announced) if value in shown]
        shown_errors = [
            f'this Step asks the viewer to predict an insert of {value}, but the Scene already shows {value}, so the frame gives the result away; show the structure without {value} here and let a later Step add it'
            for value in already
        ]
        replayed = [
            f'this Step asks the viewer to predict an insert of {value}, but an earlier Step already played that run with a trace, so the result is known; put the prediction in a Step before the Step that carries the trace'
            for value in dict.fromkeys(announced)
            if self.finished_traces - self.runs.side and value not in already
        ]
        return shown_errors + replayed


def _without_counters(spec: Any) -> Any:
    return {key: value for key, value in spec.items() if key != "counters"} if isinstance(spec, dict) else spec


def ran_something(written: Any) -> bool:
    return isinstance(written, dict) and any(key in written for key in ("trace", "simulate"))


def trace_totals(values: dict[str, Any]) -> dict[str, Any]:
    return {name: value for name, value in values.items() if name.startswith(TRACE_TOTAL_PREFIX) and name.removeprefix(TRACE_TOTAL_PREFIX) in TRACE_TOTALS}


def answer_given_away(step: dict[str, Any]) -> list[str]:
    challenge = step.get("challenge")
    if not isinstance(challenge, dict):
        return []
    answer = challenge.get("answer")
    if isinstance(answer, bool) or not isinstance(answer, (int, float, str)):
        return []
    token = str(answer)
    if len(token) < (4 if isinstance(answer, str) else 2):
        return []
    shown = [step.get("say", ""), *_shown_texts(step.get("scene"))]
    choices = challenge.get("choices") if isinstance(challenge.get("choices"), list) else []
    offered = [str(choice) for choice in choices if str(choice) != token]
    if not any(isinstance(text, str) and _names(token, text) and not (offered and all(_names(choice, text) for choice in offered)) for text in shown):
        return []
    return [f'the Challenge answer "{token}" appears in this Step\'s narration or text; a Challenge Step asks the question and never states or hints at the answer, so reword "say" and any text without "{token}", and let the next Step reveal it']


def _names(token: str, text: str) -> bool:
    return re.search(STANDS_ALONE.format(re.escape(token)), text, re.IGNORECASE) is not None


def _shown_texts(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [item for key, inner in value.items() for item in ([inner] if key in SHOWN_TEXT_FIELDS else _shown_texts(inner))]
    if isinstance(value, list):
        return [item for inner in value for item in _shown_texts(inner)]
    return []
