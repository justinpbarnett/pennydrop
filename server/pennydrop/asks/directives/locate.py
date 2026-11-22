from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ...gateway import GatewayError
from ...pictures import PartsNotFound
from ._support import DirectiveError, DirectiveTools, parse_spec

PART_NAME = re.compile(r"^[a-z][a-z' -]{0,22}$", re.I)
MEDIA_PREFIX = "/media/"

GUIDE = "\n".join([
    "### Directive `locate`",
    '`"locate": {"on": "owl", "parts": ["eyes", "beak", "wing"]}` looks at the picture of the object `owl`, set by `images` in the same Step, and sets its `parts` with the box of each named part.',
    "Name the parts in words a small child says, such as beak, wing, wheel or chimney, each once, with no `]` in it. Name only parts the narration talks about, at most 6, and use only them in `do`, as `owl[beak]`.",
    "A part that is hidden in the photo is reported back, and then you drop it from the narration or change the `images` query to get another photo.",
    "How a picture Lesson plays: Step 1 sets the picture with `images` and `locate`, shows it, and says what it is. Each next Step says one thing about one part, and its operations `point`, `zoom` or `label` that part on the spoken Cue, so the word and the pointing land together. `unzoom` and `clear` before moving to a part far away, and finish by looking at the whole picture again.",
    "For a kid, `label` pulses the part's outline and writes nothing, and the picture shows no text, so say the part's name out loud every time it is pointed at.",
])


class LocateSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    on: str = Field(min_length=1)
    parts: list[str] = Field(min_length=1, max_length=6)


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = parse_spec(LocateSpec, raw, "locate")
    if tools.images.pending(tools.lesson_id, spec.on):
        names = [name.strip() for name in spec.parts]
        _check_names(names)
        tools.images.want_parts(tools.lesson_id, spec.on, names)
        return step, {}
    if tools.images.lacks(tools.lesson_id, spec.on):
        return step, {}
    picture = (step.get("scene") or {}).get(spec.on)
    if not isinstance(picture, dict) or not str(picture.get("src", "")).startswith(MEDIA_PREFIX):
        raise DirectiveError(f"locate directive: '{spec.on}' is not a picture in this Step's scene; add an images directive for '{spec.on}' in the same Step")
    names = [name.strip() for name in spec.parts]
    _check_names(names)
    file = picture["src"].removeprefix(MEDIA_PREFIX)
    if not _points_at(step, spec.on):
        tools.locator.plan(file, names, tools.lesson_id)
        return {**step, "scene": {**step["scene"], spec.on: {**picture, "parts": []}}}, {}
    try:
        located = await tools.locator.locate(picture["src"].removeprefix(MEDIA_PREFIX), names, tools.lesson_id)
    except PartsNotFound:
        return _without_parts(step, spec.on, set(), {**step["scene"], spec.on: {**picture, "parts": []}}), {}
    except GatewayError as error:
        raise DirectiveError(f"locate directive: the vision call failed ({error}); write the same Step again") from None
    parts = [{"name": name, "box": box} for name, box in located.found.items()]
    return _without_parts(step, spec.on, {name.lower() for name in located.found}, {**step["scene"], spec.on: {**picture, "parts": parts}}), {}


def _without_parts(step: dict[str, Any], object_id: str, visible: set[str], scene: dict[str, Any] | None = None) -> dict[str, Any]:
    kept = [operation for operation in step.get("do", []) if not any(_hides(target, object_id, visible) for target in operation.get("on", []))]
    return {**step, "do": kept, **({"scene": scene} if scene is not None else {})}


def _hides(target: str, object_id: str, visible: set[str]) -> bool:
    return target.startswith(object_id + "[") and target[len(object_id) + 1:].rstrip("]").lower() not in visible


def _points_at(step: dict[str, Any], object_id: str) -> bool:
    return any(target.startswith(object_id + "[") for operation in step.get("do", []) for target in operation.get("on", []))


async def finish(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    scene = step.get("scene") or {}
    operations = [operation for operation in step.get("do", []) if not _guessed_parts(operation, scene, tools)]
    for object_id in dict.fromkeys(target.split("[")[0] for operation in operations for target in operation.get("on", []) if "[" in target):
        staged = tools.pictures.get(object_id)
        if object_id in scene or not staged or staged.get("lab") != "picture" or staged.get("parts"):
            continue
        file = str(staged.get("src", "")).removeprefix(MEDIA_PREFIX)
        try:
            located = await tools.locator.planned(file)
        except PartsNotFound:
            operations = _without_parts({"do": operations}, object_id, set())["do"]
            continue
        except GatewayError as error:
            raise DirectiveError(f"locate directive: the vision call failed ({error}); write the same Step again") from None
        if located is None:
            continue
        operations = _without_parts({"do": operations}, object_id, {name.lower() for name in located.found})["do"]
        parts = [{"name": name, "box": box} for name, box in located.found.items()]
        if parts and operations:
            operations = [{"cue": operations[0]["cue"], "op": "found", "on": [object_id], "parts": parts}, *operations]
    for object_id, staged in tools.pictures.items():
        if object_id not in scene and staged.get("lab") == "picture" and staged.get("parts"):
            operations = _without_parts({"do": operations}, object_id, {str(part["name"]).lower() for part in staged["parts"]})["do"]
    return {**step, "do": operations}


def _guessed_parts(operation: Any, scene: dict[str, Any], tools: DirectiveTools) -> bool:
    if not isinstance(operation, dict) or operation.get("op") != "found" or not operation.get("on"):
        return False
    object_id = operation["on"][0]
    picture = scene.get(object_id) if isinstance(scene.get(object_id), dict) else tools.pictures.get(object_id)
    return isinstance(picture, dict) and picture.get("lab") == "picture"


def _check_names(names: list[str]) -> None:
    for name in names:
        if not PART_NAME.match(name):
            raise DirectiveError(f"locate directive: part name '{name}' must be one or two plain words a small child says, with no brackets or digits")
    if len({name.lower() for name in names}) != len(names):
        raise DirectiveError("locate directive: each part name must appear once")
