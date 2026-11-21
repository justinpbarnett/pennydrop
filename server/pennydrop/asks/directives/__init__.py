from __future__ import annotations

import sys
from typing import Any

from ._support import DirectiveError, DirectiveTools, discover

DIRECTIVES = discover(sys.modules[__name__])


async def expand_directives(step: dict[str, Any], tools: DirectiveTools) -> dict[str, Any]:
    expanded = dict(step)
    for name, directive in DIRECTIVES.items():
        if name in expanded:
            expanded = await directive.expand(expanded, expanded.pop(name), tools)
    return expanded


def directive_guides() -> str:
    return "\n\n".join(directive.GUIDE for directive in DIRECTIVES.values())


__all__ = ["DIRECTIVES", "DirectiveError", "DirectiveTools", "directive_guides", "expand_directives"]
