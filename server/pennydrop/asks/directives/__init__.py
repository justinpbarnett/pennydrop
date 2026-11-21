from __future__ import annotations

import sys
from typing import Any

from ._support import DirectiveError, DirectiveTools, discover, fill_values

DIRECTIVES = discover(sys.modules[__name__])
DEFAULT_BRIEF = "Play the {lab} Lab with the {directive} directive: write no operations for it yourself."


async def expand_directives(step: dict[str, Any], tools: DirectiveTools, remembered: dict[str, Any]) -> dict[str, Any]:
    expanded = prepared(step)
    values: dict[str, Any] = {}
    for name, directive in DIRECTIVES.items():
        if name in expanded:
            expanded, found = await directive.expand(expanded, expanded.pop(name), tools)
            values.update(found)
    remembered.update({name: value for name, value in values.items() if name != "math"})
    filled = fill_values(expanded, {**remembered, **values})
    for name, thing in (filled.get("scene") or {}).items():
        if isinstance(thing, dict) and thing.get("lab") == "picture" and not tools.images.holds(str(thing.get("src"))):
            raise DirectiveError(f"scene object '{name}' has a src that is not a real photo, so you must not write src, w, h, credit or parts yourself; remove the whole '{name}' object from \"scene\" and instead add \"images\": {{\"on\": \"{name}\", \"query\": \"<plain name of the subject>\"}} and \"locate\" to this Step, or teach this Step with shapes")
    return filled


def prepared(step: dict[str, Any]) -> dict[str, Any]:
    for directive in DIRECTIVES.values():
        if hasattr(directive, "prepare"):
            step = directive.prepare(step)
    return dict(step)


def directives_for_labs(labs: tuple[str, ...]) -> dict[str, str]:
    return {
        lab: name
        for lab in labs
        for name, directive in DIRECTIVES.items()
        if lab in getattr(directive, "TARGETS", {})
    }


def directive_briefs(labs: tuple[str, ...]) -> list[str]:
    return [
        getattr(DIRECTIVES[name], "BRIEF", DEFAULT_BRIEF).format(lab=lab, directive=name)
        for lab, name in directives_for_labs(labs).items()
    ]


def directive_guides() -> str:
    return "\n\n".join(directive.GUIDE for directive in DIRECTIVES.values())


__all__ = ["DIRECTIVES", "DirectiveError", "DirectiveTools", "directive_briefs", "directive_guides", "directives_for_labs", "expand_directives"]
