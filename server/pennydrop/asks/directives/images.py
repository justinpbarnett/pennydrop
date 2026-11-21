from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from ...gateway import GatewayError
from ...pictures import PictureNotFound
from ._support import DirectiveError, DirectiveTools, parse_spec

TARGETS = ("picture",)
BRIEF = "Show the {lab} Lab with the images and locate directives in Step 1: they set its src, w, h, credit and parts, so never copy those from the Lab's example. You still write its operations: show, point, zoom, label, unzoom and clear. Write at least four Steps: Step 1 shows the picture, and each later Step points at, zooms to or labels one more part."

GUIDE = "\n".join([
    "### Directive `images`",
    '`"images": {"on": "owl", "query": "owl"}` finds a real, free to use photo and sets the scene object `owl` for you: its `lab` (picture), `src`, `w`, `h` and `credit`. A list of such objects shows two pictures, for a comparison.',
    "Use it, together with the `locate` directive, whenever the Ask is what something looks like or how it is built: an animal, a vehicle, a machine, a plant, a body part. Never write `src`, `w`, `h`, `credit` or `parts` yourself, and never copy them from the Lab's example.",
    "Use `images` and `locate` once per picture, in Step 1, and make Step 1 `show` it, so the stage is never empty while the narration talks about it. Later Steps reuse the object by its id, such as `owl[beak]`, with no `scene` for it.",
    'The `query` is the plain, common name of one subject, in the words the person asked with, such as "owl" or "steam train" (the photo search for those words starts before you write). Free photos are few, so when a repair says none was found, use a more common name once, and otherwise teach without a picture, from shapes, in this Step and every later one.',
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
        scene[spec.on] = {**(scene.get(spec.on) or {}), **await _picture_object(spec, tools)}
    return {**step, "scene": scene}, {}


async def _picture_object(spec: ImageSpec, tools: DirectiveTools) -> dict[str, Any]:
    try:
        picture = await tools.images.find(spec.query, not tools.young_child, tools.lesson_id)
    except PictureNotFound:
        kind = "public domain or CC0" if tools.young_child else "free to use"
        raise DirectiveError(f"images directive: no clear {kind} photo of '{spec.query}' was found; use a simpler, more common name once, and otherwise drop the images directive and draw the subject from shapes in this Step's scene, such as rectangles, circles and lines, so the stage is never empty") from None
    except (httpx.HTTPError, GatewayError) as error:
        raise DirectiveError(f"images directive: finding a photo failed ({type(error).__name__}); write the same Step again") from None
    return {"lab": "picture", "src": picture.src, "w": picture.w, "h": picture.h, "credit": {"title": picture.credit.title, "creator": picture.credit.creator, "license": picture.credit.license, "source": picture.credit.source}}
