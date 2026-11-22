from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ...pictures import Picture, PictureNotFound
from . import locate
from ._support import DirectiveError, DirectiveTools, parse_spec

TARGETS = ("picture",)
PICTURE_WAIT = 90.0
BRIEF = "Show the {lab} Lab with the images and locate directives in Step 1: they set its src, w, h, credit and parts, so never copy those from the Lab's example. You still write its operations: show, point, zoom, label, unzoom and clear. The id after \"on\" is one word with no spaces, such as owl, used the same way in every Step. Step 1 has no \"scene\" at all, and looks like {{\"say\": \"...\", \"images\": {{\"on\": \"owl\", \"query\": \"owl\"}}, \"locate\": {{\"on\": \"owl\", \"parts\": [\"eyes\", \"beak\"]}}, \"do\": [{{\"cue\": \"...\", \"op\": \"show\", \"on\": [\"owl\"]}}]}}. Write at least four Steps: Step 1 shows the picture, and each later Step points at, zooms to or labels one more part."

GUIDE = "\n".join([
    "### Directive `images`",
    '`"images": {"on": "owl", "query": "owl"}` finds a real, free to use photo and sets the scene object `owl` for you: its `lab` (picture), `src`, `w`, `h` and `credit`. A list of such objects shows two pictures, for a comparison.',
    "Use it, together with the `locate` directive, whenever the Ask is what something looks like or how it is built: an animal, a vehicle, a machine, a plant, a body part. Never write `src`, `w`, `h`, `credit` or `parts` yourself, and never copy them from the Lab's example.",
    "Use `images` and `locate` once per picture, in Step 1, and make Step 1 `show` it, so the stage is never empty while the narration talks about it. Later Steps reuse the object by its id, such as `owl[beak]`, with no `scene` for it.",
    'The `query` is the plain, common name of one subject, in the words the person asked with, such as "owl" or "steam train", never with extra words such as parts, labelled, diagram, or a second subject (the photo search for those words starts before you write). Free photos are few, and when none is found you are told so and must write the Step again: leave out `images`, `locate` and every operation on the picture, and draw the subject with shapes or a figure from another Lab in the `scene` of that Step, so the stage is never empty. Every Step after it that talks about the subject keeps drawing it that way.',
    "Everything else on the object is yours, such as `at` to put two pictures side by side. The picture starts hidden, so the Step's first operation on it is `show`.",
])


class ImageSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    on: str = Field(min_length=1)
    query: str = Field(min_length=2, max_length=80)


class ImagesSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pictures: list[ImageSpec] = Field(min_length=1, max_length=2)


async def expand(step: dict[str, Any], raw: Any, tools: DirectiveTools) -> tuple[dict[str, Any], dict[str, Any]]:
    wanted = parse_spec(ImagesSpec, {"pictures": raw if isinstance(raw, list) else [raw]}, "images").pictures
    scene = dict(step.get("scene") or {})
    for spec in wanted:
        try:
            picture = tools.images.peek(spec.query, not tools.young_child)
        except PictureNotFound:
            tools.images.note_lacking(tools.lesson_id, spec.on)
            continue
        if picture is None:
            tools.images.defer(tools.lesson_id, spec.on, spec.query, not tools.young_child)
        else:
            scene[spec.on] = {**(scene.get(spec.on) or {}), **_picture_object(picture, tools)}
    return {**step, "scene": scene}, {}


async def _arrived(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    for name in dict.fromkeys(_named(step)):
        await tools.images.wait_to_land(tools.lesson_id, name, PICTURE_WAIT)
        landed = tools.images.landed(tools.lesson_id, name)
        if landed is None or name in tools.pictures or name in (step.get("scene") or {}):
            continue
        picture, parts = landed
        operations = list(step["do"])
        if not any(operation.get("op") == "show" and name in operation.get("on", []) for operation in operations):
            operations.insert(0, {"cue": operations[0]["cue"], "op": "show", "on": [name]})
        step = {**step, "scene": {**(step.get("scene") or {}), name: _picture_object(picture, tools)}, "do": operations}
        if parts:
            step, _ = await locate.expand(step, {"on": name, "parts": parts}, tools)
    return step


async def finish(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    step = await _arrived(step, tools)
    drawn = set(step.get("scene") or {}) | set(tools.staged)
    if lacking := sorted(name for name in _named(step) - drawn if tools.images.lacks(tools.lesson_id, name)):
        raise DirectiveError(f"no free photo of {', '.join(repr(name) for name in lacking)} could be found, so no picture exists under that id; draw the subject instead: leave out its \"images\" and \"locate\" and every operation on a part such as {lacking[0]}[part], and put its shapes (the shapes Lab, or a figure from another Lab) in this Step's \"scene\" so the stage is never empty while the narration talks about it")
    return step


def _named(step: dict[str, Any]) -> set[str]:
    return {target.split("[")[0] for operation in step.get("do", []) for target in operation.get("on", [])}


def _picture_object(picture: Picture, tools: DirectiveTools) -> dict[str, Any]:
    return {**({"reading": False} if tools.young_child else {}), "lab": "picture", "src": picture.src, "w": picture.w, "h": picture.h, "credit": {"title": picture.credit.title, "creator": picture.credit.creator, "license": picture.credit.license, "source": picture.credit.source}}
