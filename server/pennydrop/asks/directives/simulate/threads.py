from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

from .._support import Simulation

LOCK = "m"
COUNTER_STEPS = ("read", "add", "write")

GUIDE = "\n".join([
    '`{"lab": "threads", "threads": ["A", "B"], "lock": false, "increments": 1, "interleave": true}` runs the threads that each do `count++` on one shared counter that starts at 0. Each `count++` is three separate steps: read, add one, write.',
    "`increments` is 1 or 2 and never more. `lock: true` wraps every increment in acquire and release of one lock, so a thread that finds it held blocks. `interleave: true` switches thread after every step, the worst case for a race, and `false` lets each thread finish before the next starts.",
    "Values: `final` (what the counter ends at), `expected` (threads times increments) and `lost` (the increments that vanished), such as `{simulate.final}`.",
])

ThreadName = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9]{0,9}$")]


class Spec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    threads: list[ThreadName] = Field(min_length=2, max_length=3)
    lock: bool = False
    increments: int = Field(default=1, ge=1, le=2)
    interleave: bool = True
    on: str | None = None


def simulate(spec: Spec) -> Simulation:
    program = _program(spec)
    counter = 0
    local = dict.fromkeys(spec.threads, 0)
    position = dict.fromkeys(spec.threads, 0)
    blocked: set[str] = set()
    owner: str | None = None
    queue: list[str] = []
    operations: list[dict[str, Any]] = []
    last = -1
    while any(position[name] < len(program) for name in spec.threads):
        runnable = [index for index, name in enumerate(spec.threads) if position[name] < len(program) and name not in blocked]
        later = [index for index in runnable if index > last]
        index = (later or runnable)[0] if spec.interleave else runnable[0]
        last = index
        name = spec.threads[index]
        action = program[position[name]]
        if action == "acquire":
            if owner is None:
                owner = name
                position[name] += 1
                operations.append({"op": "acquire", "t": name, "lock": LOCK})
            else:
                blocked.add(name)
                queue.append(name)
                operations.append({"op": "block", "t": name, "lock": LOCK})
            continue
        position[name] += 1
        if action == "read":
            local[name] = counter
            operations.append({"op": "run", "t": name, "label": f"read {counter}"})
        elif action == "add":
            local[name] += 1
            operations.append({"op": "run", "t": name, "label": f"add 1 = {local[name]}"})
        elif action == "write":
            counter = local[name]
            operations.append({"op": "run", "t": name, "label": f"write {counter}"})
        else:
            operations.append({"op": "release", "t": name, "lock": LOCK})
            owner = queue.pop(0) if queue else None
            if owner:
                blocked.discard(owner)
                position[owner] += 1
    expected = len(spec.threads) * spec.increments
    scene = {"lab": "threads", "threads": spec.threads, **({"locks": [LOCK]} if spec.lock else {})}
    return Simulation("th", scene, operations, {"final": counter, "expected": expected, "lost": expected - counter})


def _program(spec: Spec) -> list[str]:
    increment = ["acquire", *COUNTER_STEPS, "release"] if spec.lock else list(COUNTER_STEPS)
    return increment * spec.increments
