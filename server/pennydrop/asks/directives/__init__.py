from __future__ import annotations

import inspect
import sys
from typing import Any

from ._support import DirectiveError, DirectiveTools, discover, fill_values, unclear_values

DIRECTIVES = discover(sys.modules[__name__])
DEFAULT_BRIEF = "Play the {lab} Lab with the {directive} directive: write no operations for it yourself."


async def expand_directives(step: dict[str, Any], tools: DirectiveTools, remembered: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    expanded = prepared(step, tools)
    values: dict[str, Any] = {}
    for name, directive in DIRECTIVES.items():
        if name in expanded:
            expanded, found = await directive.expand(expanded, expanded.pop(name), tools)
            values.update(found)
    for directive in DIRECTIVES.values():
        if hasattr(directive, "finish"):
            expanded = directive.finish(expanded, tools)
            if inspect.isawaitable(expanded):
                expanded = await expanded
    known = {**remembered, **values}
    unclear = unclear_values(expanded, known)
    if unclear:
        raise DirectiveError("; ".join(unclear))
    filled = fill_values(expanded, known)
    for name, thing in (filled.get("scene") or {}).items():
        if isinstance(thing, dict) and (thing.get("lab") == "picture" or thing.get("kind") == "image") and not tools.images.holds(str(thing.get("src") or thing.get("url"))):
            raise DirectiveError(f"scene object '{name}' has a src or url that is not a real photo, so you must not write src, url, w, h, credit or parts yourself; remove the whole '{name}' object from \"scene\" and instead add \"images\": {{\"on\": \"{name}\", \"query\": \"<plain name of the subject>\"}} and \"locate\" to this Step, or teach this Step with shapes")
    return filled, {name: value for name, value in values.items() if name != "math"}


def as_promise(step: Any) -> Any:
    if not isinstance(step, dict) or step.get("step") != 1:
        return step
    staged = [name for name, directive in DIRECTIVES.items() if getattr(directive, "PLAYS_IN_STAGES", False) and isinstance(step.get(name), dict)]
    return {**step, **{name: {**step[name], "until": 0} for name in staged}}


def computed_facts(known: dict[str, Any]) -> list[str]:
    by_value: dict[str, list[str]] = {}
    for key, value in known.items():
        directive, *run, name = key.split(".")
        if run and isinstance(value, int | float | str):
            by_value.setdefault(f"{directive}.{name}", []).append(f"{value} in {_run_words(directive, run[0])}")
    single = [f"{key.split('.')[1].replace('_', ' ')}: {value}" for key, value in known.items() if key.count(".") == 1 and key not in by_value and isinstance(value, int | float | str)]
    return single + [f"{key.split('.')[1].replace('_', ' ')}: {', '.join(values)}" for key, values in by_value.items()]


def _run_words(directive: str, run: str) -> str:
    describe = getattr(DIRECTIVES.get(directive), "describe_run", None)
    return (describe(run) if describe else None) or f"the {run.replace('_', ' ')} run"


def prepared(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    for directive in DIRECTIVES.values():
        if hasattr(directive, "prepare"):
            step = directive.prepare(step, tools)
    return dict(step)


def directives_for_labs(labs: tuple[str, ...]) -> dict[str, str]:
    return {
        lab: name
        for lab in labs
        for name, directive in DIRECTIVES.items()
        if lab in getattr(directive, "TARGETS", {})
    }


def directive_briefs(labs: tuple[str, ...]) -> list[str]:
    grouped: dict[str, list[str]] = {}
    for lab, name in directives_for_labs(labs).items():
        grouped.setdefault(name, []).append(lab)
    return [getattr(DIRECTIVES[name], "BRIEF", DEFAULT_BRIEF).format(lab=", ".join(found), directive=name) for name, found in grouped.items()]


def directive_guides() -> str:
    return "\n\n".join(directive.GUIDE for directive in DIRECTIVES.values())


__all__ = ["DIRECTIVES", "DirectiveError", "DirectiveTools", "directive_briefs", "directive_guides", "directives_for_labs", "expand_directives"]
