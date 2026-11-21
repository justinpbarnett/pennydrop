from __future__ import annotations

from typing import Any

from .._support import DirectiveError, TracedRun

GUIDE = "\n".join([
    "The `code` Lab steps the traced source line by line: a line marker, the call stack, the variables and the output.",
    'Set one object `{"lab":"code"}` in the Step. The directive fills in its `source` (the traced code, so line numbers match), `language` and `vars`, and writes every `line`, `call`, `set`, `return` and `print` operation from the real run.',
    "Never write `line`, `call`, `set`, `return` or `print` operations yourself: write `{\"trace\": {\"code\": \"<the function source>\", \"input\": {\"n\": 3}}}` and the whole run plays in that one Step, so give it a full 20 to 25 word narration that walks through the run. `input` maps each parameter name to its value.",
    "Shape a Lesson on this Lab like this: early Steps explain the code with the object set in `scene`; one later Step, which sets the object again in its own `scene` and carries `trace`, plays the whole run with narration that follows it; the Steps after it recap and ask the Challenge.",
    "A Step plays at most 40 operations, and each executed line costs one or two, so trace a short function on a tiny input, such as factorial of 3 or a loop of 3 turns.",
])


def apply(step: dict[str, Any], object_id: str, run: TracedRun) -> dict[str, Any]:
    first_call = next((event for event in run.trace.events if event.type == "call"), None)
    if first_call is None:
        raise DirectiveError("trace directive: the traced code made no function call to step through")
    code = {"language": "python", "vars": list(first_call.arguments), **step["scene"][object_id], "source": run.source}
    return {
        **step,
        "scene": {**step["scene"], object_id: code},
        "do": [*step.get("do", []), *_operations(run, object_id)],
    }


def _operations(run: TracedRun, object_id: str) -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    frames: list[dict[str, Any]] = []
    on = [object_id]
    for event in run.trace.events:
        if event.type == "call":
            frames.append(dict(event.arguments))
            operations.append({"op": "call", "on": on, "name": event.function, "args": {name: repr(value) for name, value in event.arguments.items()}})
        elif event.type == "line":
            known = frames[-1] if frames else {}
            for name, value in event.locals.items():
                if name not in known or known[name] != value:
                    operations.append({"op": "set", "on": on, "name": name, "value": repr(value)})
                    known[name] = value
            operations.append({"op": "line", "on": on, "n": event.line})
        elif event.type == "return":
            if frames:
                frames.pop()
            operations.append({"op": "return", "on": on, **({} if event.value is None else {"value": repr(event.value)})})
        elif event.type == "print":
            operations.append({"op": "print", "on": on, "text": event.text})
    return operations
