from __future__ import annotations

import sys
from typing import Any

from .._support import DirectiveError, DirectiveTools, discover, limit_operations, parse_spec

TARGETS = discover(sys.modules[__name__])

GUIDE = "\n".join([
    "### Directive `simulate`",
    '`"simulate": {"lab": "scheduler", ...}` runs a small simulation in code and plays it on that Lab, so every number on screen and in the narration is computed. The Step needs no `do` entries for it and no object of that Lab in its own `scene`: the directive sets the object for you.',
    "When the Scene already holds an object of that Lab, the directive plays on it and keeps it, so a later Step of the same run only needs the directive, and you never add a second object of that Lab. Restating an object in `scene` resets it.",
    "Labs that can be simulated: " + ", ".join(TARGETS) + ".",
    *(target.GUIDE for target in TARGETS.values()),
    "Use each computed value in `say` or text as `{simulate.name}`, and as `\"answer\": \"simulate.name\"` in a number Challenge. A Step plays at most 40 operations, so keep the example small.",
])


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(raw, dict) or raw.get("lab") not in TARGETS:
        raise DirectiveError(f"simulate directive: \"lab\" must be one of {', '.join(TARGETS)}")
    target = TARGETS[raw["lab"]]
    spec = parse_spec(target.Spec, {key: value for key, value in raw.items() if key != "lab"}, f"simulate {raw['lab']}")
    simulation = target.simulate(spec)
    scene = step.get("scene") or {}
    object_id = spec.on or _object_of_lab(raw["lab"], scene, tools.staged) or simulation.object_id
    expanded = {
        **step,
        "scene": {**scene, object_id: {**scene.get(object_id, {}), **simulation.scene}},
        "do": [*step.get("do", []), *limit_operations("simulate", [{**operation, "on": [object_id]} for operation in simulation.operations])],
    }
    return expanded, {f"simulate.{name}": value for name, value in simulation.values.items()}


def _object_of_lab(lab: str, scene: dict[str, Any], staged: dict[str, dict[str, Any]]) -> str | None:
    written = [name for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") == lab]
    on_stage = [name for name, found in staged.items() if found.get("lab") == lab and scene.get(name, 0) is not None]
    if len(written) > 1:
        raise DirectiveError(f"simulate directive: the Step's scene has {len(written)} {lab} objects ({', '.join(written)}) and the directive plays on one; leave all of them out of \"scene\", because the directive sets the {lab} object itself")
    extra = [name for name in written if on_stage and name not in on_stage]
    if extra:
        raise DirectiveError(f"simulate directive: the Scene already has a {lab} object \"{on_stage[0]}\" and this Step also adds \"{extra[0]}\"; remove \"{extra[0]}\" from \"scene\", and the directive plays on \"{on_stage[0]}\"")
    return (written or on_stage or [None])[0]
