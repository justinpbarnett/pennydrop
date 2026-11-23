from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

from .._support import Simulation

LOCK = "m"
COUNT_OBJECT = "count"
COUNTER_STEPS = ("read", "add", "write")

GUIDE = """`{"lab": "threads", "threads": ["A", "B"], "lock": false, "increments": 1, "interleave": true}` runs the threads that each do `count++` on one shared counter that starts at 0. Each `count++` is three separate steps: read, add one, write.
`increments` is 1 or 2 and never more. `lock: true` wraps every increment in acquire and release of one lock, so a thread that finds it held blocks. `interleave: true` switches thread after every step, the worst case for a race, and `false` lets each thread finish before the next starts.
The directive also draws the shared counter as a text object named `count`, which shows its value after every write, so the lost update is visible; never write a second counter yourself.
Values: `final` (what the counter ends at), `expected` (threads times increments) and `lost` (the increments that vanished), such as `{simulate.final}`.
A run with `lock: true` is named `locked`, one without a lock `interleaved` or `serial`: `{simulate.interleaved.final}`, `{simulate.locked.final}`.
To tell the run in stages, add `"until": 6` to play only the first 6 steps, where a step is one read, add, write, acquire, block or release. A later Step carries the same simulation with a later `until`, or none for the rest of the run, and plays only the new part on the same Lab and counter.
`expected` can be used in any Step. `final` and `lost` can be used only in the Step that plays the run to its end."""

ThreadName = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9]{0,9}$")]


class Spec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    threads: list[ThreadName] = Field(min_length=2, max_length=3)
    lock: bool = False
    increments: int = Field(default=1, ge=1, le=2)
    interleave: bool = True
    until: int | None = Field(default=None, ge=0, le=30)
    on: str | None = None


def simulate(spec: Spec) -> Simulation:
    program = _program(spec)
    counter = 0
    local = dict.fromkeys(spec.threads, 0)
    position = dict.fromkeys(spec.threads, 0)
    blocked: set[str] = set()
    owner: str | None = None
    queue: list[str] = []
    timeline: list[tuple[int, dict[str, Any]]] = []
    steps = 0
    last = -1

    def play(operation: dict[str, Any]) -> None:
        timeline.append((steps, operation))

    while any(position[name] < len(program) for name in spec.threads):
        runnable = [index for index, name in enumerate(spec.threads) if position[name] < len(program) and name not in blocked]
        later = [index for index in runnable if index > last]
        index = (later or runnable)[0] if spec.interleave else runnable[0]
        last = index
        steps += 1
        name = spec.threads[index]
        action = program[position[name]]
        if action == "acquire":
            if owner is None:
                owner = name
                position[name] += 1
                play({"op": "acquire", "t": name, "lock": LOCK})
            else:
                blocked.add(name)
                queue.append(name)
                play({"op": "block", "t": name, "lock": LOCK})
            continue
        position[name] += 1
        if action == "read":
            local[name] = counter
            play({"op": "run", "t": name, "label": f"read {counter}"})
        elif action == "add":
            local[name] += 1
            play({"op": "run", "t": name, "label": f"add 1 = {local[name]}"})
        elif action == "write":
            counter = local[name]
            play({"op": "run", "t": name, "label": f"write {counter}"})
            play({"op": "write", "on": [COUNT_OBJECT], "text": f"count = {counter}"})
        else:
            play({"op": "release", "t": name, "lock": LOCK})
            owner = queue.pop(0) if queue else None
            if owner:
                blocked.discard(owner)
                position[owner] += 1
    expected = len(spec.threads) * spec.increments
    scene = {"lab": "threads", "threads": spec.threads, **({"locks": [LOCK]} if spec.lock else {})}
    shared = {COUNT_OBJECT: {"kind": "text", "text": "count = 0", "size": 36, "at": "bottom"}}
    values = {"final": counter, "expected": expected, "lost": expected - counter}
    return Simulation("th", scene, timeline, values, {"final": steps, "lost": steps}, shared, until=spec.until, run=_run_name(spec))


RUN_WORDS = {
    "locked": "the locked run, with a lock around each update",
    "interleaved": "the interleaved run without a lock",
    "serial": "the serial run without a lock, one thread after another",
}


def _run_name(spec: Spec) -> str:
    if spec.lock:
        return "locked"
    return "interleaved" if spec.interleave else "serial"


def describe_run(run: str) -> str | None:
    return RUN_WORDS.get(run)


def _program(spec: Spec) -> list[str]:
    increment = ["acquire", *COUNTER_STEPS, "release"] if spec.lock else list(COUNTER_STEPS)
    return increment * spec.increments
