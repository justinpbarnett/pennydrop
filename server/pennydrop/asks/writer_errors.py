from __future__ import annotations

import json

from pydantic import ValidationError

STEP_FIELDS = "A Step holds only step, say, scene, do, challenge and its directives"
SHOWN_INPUT = 80


def describe(error: ValidationError, fields: str = STEP_FIELDS) -> list[str]:
    messages = []
    for item in error.errors():
        where = ".".join(str(part) for part in item["loc"])
        if item["type"] == "extra_forbidden":
            messages.append(f"{where}: unknown field. {fields}" if len(item["loc"]) == 1 else f"{where}: unknown field")
        elif item["type"] == "missing" and isinstance(item.get("input"), dict):
            messages.append(f"{where}: Field required; the entry holds only {', '.join(item['input']) or 'nothing'}")
        elif item["type"] == "union_tag_invalid":
            messages.append(f"{where}: unknown challenge type. Use number, choice, click, order, match, yesno or words")
        elif item["type"] in ("dict_type", "list_type", "string_type", "int_type"):
            messages.append(f"{where}: {item['msg']}, and the line has {json.dumps(item.get('input'))[:SHOWN_INPUT]} there")
        else:
            messages.append(f"{where}: {item['msg']}")
    return messages
