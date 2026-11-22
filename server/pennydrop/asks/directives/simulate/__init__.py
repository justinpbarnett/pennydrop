from __future__ import annotations

import json
import math
import re
import sys
from typing import Any

from .._support import DirectiveError, DirectiveTools, Simulation, discover, limit_operations, operation_targets, parse_spec, values_said, with_answer_from

TARGETS = discover(sys.modules[__name__])
END = math.inf
RUNS_SHOWN = 2

PLAYS_IN_STAGES = True
PLAYED_BY_HAND = 'simulate directive: the {lab} Lab plays only through its "simulate" directive, so "do" entries on {name} never play; drop them, and to play the next part of its run carry "simulate": {{"lab": "{lab}", "on": "{name}", "until": <the next stop>}}, whose other fields carry over from the Step before, or show this beat with text and shapes beside it'

BRIEF = 'Only the simulate directive draws and plays these Labs: {lab}. Every Step that shows one carries a "simulate" directive for it, and no Step puts an object of these Labs in "scene" or writes operations for them, so skip their spec fields and operations in the Catalog.'

GUIDE = "\n".join([
    "### Directive `simulate`",
    '`"simulate": {"lab": "scheduler", ...}` runs a small simulation in code and plays it on that Lab, so every number on screen and in the narration is computed. The Step needs no `do` entries for it and no object of that Lab in its own `scene`: the directive sets the object for you.',
    "When the Scene already holds an object showing this same run, the directive plays on it and keeps it. A different run replaces the Lab's object, unless the Lab's notes below say it shows runs side by side.",
    "Leave simulated objects out of `scene` in every Step: restating one resets it to the run's setup, and a new object of that Lab in `scene` replaces what is on stage.",
    "A Step that carries a simulation plays the whole run, unless the simulation has an `until`. To tell one run across several Steps, repeat the same simulation in each Step, give every Step but the last a later `until` than the Step before, and leave `until` out of the last Step. Each Step then plays only the part that no earlier Step played, on the same Lab, and the narration of a Step talks only about the part it plays.",
    "`\"until\": 0` draws the Lab with the run's setup and plays none of it, for a Step that shows the setup or asks a question before the run starts. A Step with the same `until` as the Step before keeps the stage as it is, which only the Step that asks the predict Challenge does: every other Step plays a later stop than the Step before, so give one moment one Step and let its narration say all it needs.",
    "A simulation picks up where the stage left off only when what its object already shows is the start of this same run. Operations written by hand that differ make it redraw the object and play from the start, so stage a simulated Lab with `until` and write none of its operations by hand.",
    "Labs that can be simulated: " + ", ".join(TARGETS) + ".",
    *(target.GUIDE for target in TARGETS.values()),
    "Use each computed value in `say` or text as `{simulate.name}`, and as `\"answer\": \"simulate.name\"` in a number Challenge. A Step plays at most 40 operations, so keep the example small.",
    "A Lab that names its runs also keeps each run's values under the run's name, such as `{simulate.fcfs.avg_wait}`. Once a Lesson has played two runs of a Lab, write the run's name for every value that differs between them, from the Step that plays the second run on, so a Step that compares two runs states each run's own number.",
])


def prepare(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    carried = step["simulate"].get("lab") if isinstance(step.get("simulate"), dict) else None
    drawn_by_hand = sorted({spec["lab"] for spec in scene.values() if isinstance(spec, dict) and spec.get("lab") in TARGETS and spec["lab"] != carried})
    if drawn_by_hand:
        raise DirectiveError(f'simulate directive: the {drawn_by_hand[0]} Lab is simulated, so leave its figure out of "scene" and carry a "simulate" directive for it in this Step, which draws the figure and plays the run; to show it before the run starts, give that simulation "until": 0')
    simulated = {name: spec["lab"] for name, spec in {**tools.staged, **scene}.items() if isinstance(spec, dict) and spec.get("lab") in TARGETS}
    operations = step.get("do") or []
    played_by_hand = [operation for operation in operations if isinstance(operation, dict) and simulated.keys() & set(operation_targets(operation))]
    if not played_by_hand:
        return step
    if carried is None:
        name = next(name for name in operation_targets(played_by_hand[0]) if name in simulated)
        raise DirectiveError(PLAYED_BY_HAND.format(lab=simulated[name], name=name))
    kept = [operation for operation in operations if operation not in played_by_hand]
    return {**{key: value for key, value in step.items() if key != "do"}, **({"do": kept} if kept else {})}


def with_scene_figure_as_simulation(step: dict[str, Any], staged: dict[str, dict[str, Any]]) -> dict[str, Any]:
    scene = step.get("scene")
    if not isinstance(scene, dict):
        return step
    figures = {name: spec for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") in TARGETS}
    restated = {name for name, spec in figures.items() if staged.get(name, {}).get("lab") == spec["lab"]}
    drawn = [name for name in figures if name not in restated]
    if "simulate" in step or len(drawn) != 1:
        return _with_scene(step, {name: spec for name, spec in scene.items() if name not in restated})
    name = drawn[0]
    return {**_with_scene(step, {other: spec for other, spec in scene.items() if other not in restated and other != name}), "simulate": {**figures[name], "on": name, "until": 0}}


def _with_scene(step: dict[str, Any], scene: dict[str, Any]) -> dict[str, Any]:
    if scene == step.get("scene"):
        return step
    return {**{key: value for key, value in step.items() if key != "scene"}, **({"scene": scene} if scene else {})}


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(raw, dict) or raw.get("lab") not in TARGETS:
        raise DirectiveError(f"simulate directive: \"lab\" must be one of {', '.join(TARGETS)}")
    target = TARGETS[raw["lab"]]
    spec = parse_spec(target.Spec, {key: value for key, value in raw.items() if key != "lab"}, f"simulate {raw['lab']}", read_before=("lab",))
    simulation = target.simulate(spec)
    written = step.get("scene") or {}
    if spec.on:
        object_id, scene = spec.on, written
    elif simulation.side_by_side:
        object_id, scene = _object_beside(raw["lab"], simulation, written, tools.staged)
    else:
        object_id, scene = _object_of_lab(raw["lab"], simulation, written, tools.staged)
    timeline = [(moment, {"on": [object_id], **operation}) for moment, operation in simulation.timeline]
    staged = tools.staged.get(object_id, {})
    same_object = object_id not in scene and all(staged.get(key) == value for key, value in simulation.scene.items())
    shown = _already_shown(timeline, [entry for entry in tools.played if entry[0] in {object_id, *simulation.objects}]) if same_object else 0
    finished = shown == len(timeline)
    reach = END if finished or simulation.until is None else simulation.until
    played = [operation for moment, operation in timeline[shown:] if moment <= reach]
    shown_up_to = timeline[shown - 1][0] if shown else 0
    if not played and not finished and reach < shown_up_to:
        raise DirectiveError(_already_past(raw["until"], simulation.stop(shown_up_to)))
    if not played and not finished and not shown and reach > 0:
        raise DirectiveError(_nothing_new(raw["until"], simulation.stop(timeline[0][0])))
    reached = {key: simulation.values[name] for key, name in simulation.value_names().items() if simulation.known_at.get(name, 0) <= reach}
    _require_values_reached(step, simulation, reach)
    written_figure = scene.get(object_id) if isinstance(scene.get(object_id), dict) and scene[object_id].get("lab") == raw["lab"] else {}
    drawn = {} if shown else {object_id: {**written_figure, **simulation.scene}, **simulation.objects}
    expanded = {**step, "scene": {**scene, **drawn}, "do": [*step.get("do", []), *limit_operations("simulate", played)]}
    later = {key: simulation.values[name] for key, name in simulation.value_names().items() if key not in reached}
    return with_answer_from(expanded, later), reached


def describe_run(run: str) -> str | None:
    for target in TARGETS.values():
        if hasattr(target, "describe_run") and (words := target.describe_run(run)):
            return words
    return None


def describe_value(name: str) -> str | None:
    for target in TARGETS.values():
        if hasattr(target, "describe_value") and (words := target.describe_value(name)):
            return words
    return None


PER_STEP_FIELDS = ("until", "on")


def filled_from(raw: Any, earlier: dict[str, dict[str, Any]]) -> Any:
    target = TARGETS.get(raw.get("lab")) if isinstance(raw, dict) else None
    before = earlier.get(raw["lab"], {}) if target else {}
    continues = bool(before) and all(before[name] == value for name, value in raw.items() if name in before and name not in PER_STEP_FIELDS)
    carried = [name for name, field in target.Spec.model_fields.items() if name not in PER_STEP_FIELDS and (continues or field.is_required())] if target else []
    missing = {name: before[name] for name in carried if name not in raw and name in before}
    return {**raw, **missing} if missing else raw


def contradictions(step: dict[str, Any], labs: dict[str, str], played: list[tuple[str, dict[str, Any]]]) -> list[str]:
    say = step.get("say")
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    if not isinstance(say, str):
        return []
    drawn = {**labs, **{name: spec["lab"] for name, spec in scene.items() if isinstance(spec, dict) and isinstance(spec.get("lab"), str)}}
    errors: list[str] = []
    for name, lab in sorted(drawn.items()):
        check = getattr(TARGETS.get(lab), "contradictions", None)
        before = [] if name in scene else [str(operation.get("op")) for target, operation in played if target == name]
        now = [str(operation.get("op")) for operation in step.get("do", []) if isinstance(operation, dict) and name in operation_targets(operation)]
        if check and (before or now):
            errors += [f"step {step.get('step')} say: {error}" for error in check(name, say, before + now)]
    return errors


def _already_shown(timeline: list[tuple[int, dict[str, Any]]], played: list[tuple[str, dict[str, Any]]]) -> int:
    if len(played) > len(timeline):
        return 0
    for (target, shown), (_, operation) in zip(played, timeline):
        if target not in operation_targets(operation) or _comparable(shown) != _comparable(operation):
            return 0
    return len(played)


def _comparable(operation: dict[str, Any]) -> str:
    return json.dumps({key: value for key, value in operation.items() if key not in ("on", "cue")}, sort_keys=True, default=str)


def _nothing_new(until: Any, first_stop: str) -> str:
    return f"simulate directive: \"until\" {json.dumps(until)} plays nothing, because the run's first part ends at {first_stop}; set \"until\" to {first_stop} or later, or to 0 to draw the Lab without playing any of the run"


def _already_past(until: Any, shown_stop: str) -> str:
    return f"simulate directive: \"until\" {json.dumps(until)} is earlier than the stage, which already shows the run up to {shown_stop}; the stage cannot go back, so set \"until\" to {shown_stop} to keep it as it is, or later to play more"


def _require_values_reached(step: dict[str, Any], simulation: Simulation, reach: float) -> None:
    names = simulation.value_names()
    early = [key for key in values_said(step, list(names)) if simulation.known_at.get(names[key], 0) > reach]
    if early:
        known_at = simulation.stop(simulation.known_at[names[early[0]]])
        raise DirectiveError(f"simulate directive: {{{early[0]}}} is not known yet in this Step, because the run reaches it at {known_at} and this Step stops earlier; use it in a Step whose \"until\" is {known_at} or later, and leave it out of this one, so the narration never states a number before the stage shows it. A predict Challenge here may still name it as its \"answer\"")


def _object_beside(lab: str, simulation: Simulation, scene: dict[str, Any], staged: dict[str, dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    shown = [name for name, found in staged.items() if found.get("lab") == lab]
    written = [name for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") == lab and name not in staged]
    kept = {name: spec for name, spec in scene.items() if name not in shown and name not in written}
    same = [name for name in shown if _shows_run(staged[name], simulation.scene)]
    if same:
        return same[0], kept
    base = f"{simulation.object_id}_{simulation.run}"
    fresh = next(name for name in (*written, simulation.object_id, base, *(f"{base}_{count}" for count in range(2, len(staged) + 2))) if name not in staged)
    return fresh, {**kept, **dict.fromkeys(shown[: max(len(shown) - RUNS_SHOWN + 1, 0)])}


def _shows_run(found: dict[str, Any], scene: dict[str, Any]) -> bool:
    return all(_plain(found.get(key)) == _plain(value) for key, value in scene.items())


def _plain(value: Any) -> Any:
    return re.sub(r"[^a-z0-9]", "", value.lower()) if isinstance(value, str) else value


def _object_of_lab(lab: str, simulation: Simulation, scene: dict[str, Any], staged: dict[str, dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    written = [name for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") == lab]
    on_stage = [name for name, found in staged.items() if found.get("lab") == lab and scene.get(name, 0) is not None]
    if len(written) > 1:
        raise DirectiveError(f"simulate directive: the Step's scene has {len(written)} {lab} objects ({', '.join(written)}) and the directive plays on one; leave all of them out of \"scene\", because the directive sets the {lab} object itself")
    if written:
        return written[0], {**scene, **dict.fromkeys(name for name in on_stage if name != written[0])}
    return (on_stage or [simulation.object_id])[0], scene
