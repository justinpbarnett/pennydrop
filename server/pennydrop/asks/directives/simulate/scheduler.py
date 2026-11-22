from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .._support import DirectiveError, Simulation

GUIDE = "\n".join([
    '`{"lab": "scheduler", "policy": "fcfs" | "sjf" | "round_robin", "quantum": 2, "processes": [{"id": "P1", "burst": 5, "arrive": 0}, ...]}` schedules up to 6 processes on one CPU.',
    "`fcfs` runs in arrival order, `sjf` runs the shortest ready job to the end, `round_robin` needs a `quantum` and gives each turn at most that long. Bursts and arrivals are whole numbers.",
    "Values: `total_time`, `avg_wait`, `avg_turnaround`, `avg_response`, and `burst_<id>`, `wait_<id>`, `turnaround_<id>`, `finish_<id>`, `response_<id>` for each process, such as `{simulate.wait_P2}`. A response is the ticks from arrival to a process's first turn: a smaller round robin quantum lowers the responses even where it raises the average wait, so pick the value that proves the Lesson's point. The first process in line runs at once under every policy and quantum, so its response is 0 in each run, and a claim about first turns coming sooner names the processes that wait, such as P2 and P3, not every process.",
    "A switch between processes costs no time in this Lab, so it cannot show switch overhead. Pick bursts that prove the Lesson's point: with equal bursts, such as 4, 4 and 4, a smaller quantum gives P2 and P3 their first turn sooner and raises the average wait; with a long job first, such as 8, 2 and 2, a smaller quantum lowers the average wait too.",
    "A run is named by its policy, and a round robin run by its quantum too: `{simulate.fcfs.avg_wait}`, `{simulate.sjf.avg_wait}`, `{simulate.round_robin_2.avg_wait}`.",
    "Runs show side by side: a run with another policy or quantum appears as a second scheduler beside the first, so a Lesson that compares two runs keeps both on stage to its last Step, and a third run replaces the older one. Play each run far enough to know every value a Step compares, such as both runs to their end before a Step says which average wait is lower. A Step that goes back to an earlier run carries that run's simulation again and plays on its own scheduler. The directive places and removes schedulers itself, so never remove one with null.",
    "To tell the run in stages, add `\"until\": 4` to play only the turns that end by clock time 4. A later Step carries the same simulation with a later `until`, or none for the rest of the run, and plays only the new part on the same Lab.",
    "A value can be used only in a Step whose `until` has reached it: `response_P2` when P2 has had its first turn, `finish_P2`, `wait_P2` and `turnaround_P2` when P2 has finished, `avg_response` when every process has had a turn, and `total_time`, `avg_wait` and `avg_turnaround` when every process has finished.",
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
    until: int | None = Field(default=None, ge=0, le=200)
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
    timeline: list[tuple[int, dict[str, Any]]] = []
    finished: dict[str, int] = {}
    started: dict[str, tuple[int, int]] = {}
    clock = 0

    def play(operation: dict[str, Any]) -> None:
        timeline.append((clock, operation))

    def admit() -> None:
        while waiting and arrivals[waiting[0]] <= clock:
            process = waiting.pop(0)
            play({"op": "arrive", "p": process})
            ready.append(process)

    while len(finished) < len(spec.processes):
        if not ready:
            clock = arrivals[waiting[0]]
            play({"op": "idle", "until": clock})
            admit()
            continue
        chosen = min(ready, key=lambda process: left[process]) if spec.policy == "sjf" else ready[0]
        ready.remove(chosen)
        turn = left[chosen]
        if spec.policy == "round_robin" and spec.quantum:
            turn = min(left[chosen], spec.quantum)
            while turn < left[chosen] and not ready and not (waiting and arrivals[waiting[0]] <= clock + turn):
                turn = min(left[chosen], turn + spec.quantum)
        started.setdefault(chosen, (clock, clock + turn))
        clock += turn
        left[chosen] -= turn
        play({"op": "run", "p": chosen, "until": clock})
        admit()
        if left[chosen] == 0:
            finished[chosen] = clock
            play({"op": "finish", "p": chosen})
        else:
            ready.append(chosen)
            play({"op": "preempt", "p": chosen})
    values, known_at = _values(spec, finished, started)
    return Simulation("sched", _scene(spec), timeline, values, known_at, until=spec.until, run=_run_name(spec), side_by_side=True)


def _run_name(spec: Spec) -> str:
    return f"round_robin_{spec.quantum}" if spec.policy == "round_robin" else spec.policy


def describe_run(run: str) -> str | None:
    named = {"fcfs": "the first come, first served run", "sjf": "the shortest job first run"}
    quantum = run.removeprefix("round_robin_")
    return named.get(run) or (f"the round robin run with quantum {quantum}" if quantum != run else None)


def _scene(spec: Spec) -> dict[str, Any]:
    names = {"fcfs": "First come, first served", "sjf": "Shortest job first", "round_robin": f"Round robin, quantum {spec.quantum}"}
    return {
        "lab": "scheduler",
        "policy": names[spec.policy],
        "processes": [{"id": process.id, "burst": process.burst, **({"arrive": process.arrive} if process.arrive else {})} for process in spec.processes],
    }


def _values(spec: Spec, finished: dict[str, int], started: dict[str, tuple[int, int]]) -> tuple[dict[str, int | float | str], dict[str, int]]:
    if not finished:
        raise DirectiveError("simulate directive: nothing was scheduled")
    turnaround = {process.id: finished[process.id] - process.arrive for process in spec.processes}
    wait = {process.id: turnaround[process.id] - process.burst for process in spec.processes}
    response = {process.id: started[process.id][0] - process.arrive for process in spec.processes}
    count = len(spec.processes)
    total_time = max(finished.values())
    values = {
        "total_time": total_time,
        "avg_wait": _number(sum(wait.values()) / count),
        "avg_turnaround": _number(sum(turnaround.values()) / count),
        "avg_response": _number(sum(response.values()) / count),
        **{f"wait_{name}": value for name, value in wait.items()},
        **{f"turnaround_{name}": value for name, value in turnaround.items()},
        **{f"finish_{name}": value for name, value in finished.items()},
        **{f"response_{name}": value for name, value in response.items()},
        **{f"burst_{process.id}": process.burst for process in spec.processes},
    }
    first_turns = {name: shown for name, (_, shown) in started.items()}
    known_at = {"total_time": total_time, "avg_wait": total_time, "avg_turnaround": total_time, "avg_response": max(first_turns.values())}
    known_at |= {f"response_{name}": time for name, time in first_turns.items()}
    for name, time in finished.items():
        known_at |= {f"wait_{name}": time, f"turnaround_{name}": time, f"finish_{name}": time}
    return values, known_at


def _number(value: float) -> int | float:
    rounded = round(value, 2)
    return int(rounded) if rounded == int(rounded) else rounded
