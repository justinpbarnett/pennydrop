from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .._support import DirectiveError, Simulation

GUIDE = "\n".join([
    '`{"lab": "scheduler", "policy": "fcfs" | "sjf" | "round_robin", "quantum": 2, "processes": [{"id": "P1", "burst": 5, "arrive": 0}, ...]}` schedules up to 6 processes on one CPU.',
    "`fcfs` runs in arrival order, `sjf` runs the shortest ready job to the end, `round_robin` needs a `quantum` and gives each turn at most that long. Bursts and arrivals are whole numbers.",
    "Values: `total_time`, `avg_wait`, `avg_turnaround`, and `wait_<id>`, `turnaround_<id>`, `finish_<id>` for each process, such as `{simulate.wait_P2}`.",
])

Name = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9]{0,5}$")]


class Process(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Name
    burst: int = Field(ge=1, le=20)
    arrive: int = Field(default=0, ge=0, le=40)


class Spec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policy: Literal["fcfs", "sjf", "round_robin"]
    processes: list[Process] = Field(min_length=1, max_length=6)
    quantum: int | None = Field(default=None, ge=1, le=10)
    on: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Spec:
        if self.policy == "round_robin" and self.quantum is None:
            raise ValueError("round_robin needs a quantum such as 2")
        if len({process.id for process in self.processes}) != len(self.processes):
            raise ValueError("process ids must be unique")
        return self


def simulate(spec: Spec) -> Simulation:
    left = {process.id: process.burst for process in spec.processes}
    arrivals = {process.id: process.arrive for process in spec.processes}
    waiting = [process.id for process in sorted(spec.processes, key=lambda process: process.arrive) if process.arrive > 0]
    ready = [process.id for process in spec.processes if process.arrive == 0]
    operations: list[dict[str, Any]] = []
    finished: dict[str, int] = {}
    clock = 0

    def admit() -> None:
        while waiting and arrivals[waiting[0]] <= clock:
            process = waiting.pop(0)
            operations.append({"op": "arrive", "p": process})
            ready.append(process)

    while len(finished) < len(spec.processes):
        if not ready:
            clock = arrivals[waiting[0]]
            operations.append({"op": "idle", "until": clock})
            admit()
            continue
        chosen = min(ready, key=lambda process: left[process]) if spec.policy == "sjf" else ready[0]
        ready.remove(chosen)
        turn = min(left[chosen], spec.quantum) if spec.policy == "round_robin" and spec.quantum else left[chosen]
        clock += turn
        left[chosen] -= turn
        operations.append({"op": "run", "p": chosen, "until": clock})
        admit()
        if left[chosen] == 0:
            finished[chosen] = clock
            operations.append({"op": "finish", "p": chosen})
        else:
            ready.append(chosen)
            operations.append({"op": "preempt", "p": chosen})
    return Simulation("sched", _scene(spec), operations, _values(spec, finished))


def _scene(spec: Spec) -> dict[str, Any]:
    names = {"fcfs": "First come, first served", "sjf": "Shortest job first", "round_robin": f"Round robin, quantum {spec.quantum}"}
    return {
        "lab": "scheduler",
        "policy": names[spec.policy],
        "processes": [{"id": process.id, "burst": process.burst, **({"arrive": process.arrive} if process.arrive else {})} for process in spec.processes],
    }


def _values(spec: Spec, finished: dict[str, int]) -> dict[str, int | float | str]:
    if not finished:
        raise DirectiveError("simulate directive: nothing was scheduled")
    turnaround = {process.id: finished[process.id] - process.arrive for process in spec.processes}
    wait = {process.id: turnaround[process.id] - process.burst for process in spec.processes}
    count = len(spec.processes)
    return {
        "total_time": max(finished.values()),
        "avg_wait": _number(sum(wait.values()) / count),
        "avg_turnaround": _number(sum(turnaround.values()) / count),
        **{f"wait_{name}": value for name, value in wait.items()},
        **{f"turnaround_{name}": value for name, value in turnaround.items()},
        **{f"finish_{name}": value for name, value in finished.items()},
    }


def _number(value: float) -> int | float:
    rounded = round(value, 2)
    return int(rounded) if rounded == int(rounded) else rounded
