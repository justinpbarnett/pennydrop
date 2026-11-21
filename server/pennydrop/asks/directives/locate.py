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
    picture = (step.get("scene") or {}).get(spec.on)
    if not isinstance(picture, dict) or not str(picture.get("src", "")).startswith(MEDIA_PREFIX):
        raise DirectiveError(f"locate directive: '{spec.on}' is not a picture in this Step's scene; add an images directive for '{spec.on}' in the same Step")
    names = [name.strip() for name in spec.parts]
    _check_names(names)
    try:
        located = await tools.locator.locate(picture["src"].removeprefix(MEDIA_PREFIX), names, tools.lesson_id)
    except PartsNotFound as reason:
        raise DirectiveError(f"locate directive: the photo of '{spec.on}' cannot show its parts, because {reason}; change the query of its images directive to get another photo") from None
    except GatewayError as error:
        raise DirectiveError(f"locate directive: the vision call failed ({error}); write the same Step again") from None
    if located.missing:
        shown = ", ".join(located.found) or "none"
        raise DirectiveError(f"locate directive: cannot see {', '.join(located.missing)} in the photo of '{spec.on}' (found: {shown}); drop the missing parts from the Step and its narration, or change the images query to get a photo that shows them")
    parts = [{"name": name, "box": box} for name, box in located.found.items()]
    return {**step, "scene": {**step["scene"], spec.on: {**picture, "parts": parts}}}, {}


def _check_names(names: list[str]) -> None:
    for name in names:
        if not PART_NAME.match(name):
            raise DirectiveError(f"locate directive: part name '{name}' must be one or two plain words a small child says, with no brackets or digits")
    if len({name.lower() for name in names}) != len(names):
        raise DirectiveError("locate directive: each part name must appear once")
