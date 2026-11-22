from __future__ import annotations

import json
from typing import Any

PHYSICS_LAB = "physics"
RUN_OF_SETUP = {"launch": "launch", "drop": "release", "ramp": "release", "pendulum": "swing", "orbit": "orbit"}
RUNS = frozenset(RUN_OF_SETUP.values())
RESET = "set"
NOT_SETUP = frozenset({"lab", "reading"})
NOT_VALUES = frozenset({"op", "on", "cue"})


class PlayedSetups:
    def __init__(self) -> None:
        self._setups: dict[str, dict[str, Any]] = {}
        self._played: dict[str, int] = {}
        self._predicted: tuple[str, int] | None = None

    def remember(self, step: dict[str, Any]) -> None:
        self._setups, runs = self._play(step)
        for key in runs:
            self._played.setdefault(key, step.get("step", 0))
        challenge = step.get("challenge")
        name = _asked_about(challenge, self._setups) if isinstance(challenge, dict) and challenge.get("kind") == "predict" else None
        self._predicted = (name, step.get("step", 0)) if name else None

    def with_reveal_run(self, step: dict[str, Any]) -> dict[str, Any]:
        if self._predicted is None:
            return step
        name = self._predicted[0]
        setups, runs = self._play(step)
        setup = setups.get(name)
        if setup is None or setup != self._setups.get(name) or _key(setup) in runs or setup.get("setup") not in RUN_OF_SETUP:
            return step
        return {**step, "do": [{"op": RUN_OF_SETUP[setup["setup"]], "on": [name]}, *(step.get("do") or [])]}

    def errors_in(self, step: dict[str, Any]) -> list[str]:
        return self._reveal_errors(step) + self._challenge_errors(step)

    def _reveal_errors(self, step: dict[str, Any]) -> list[str]:
        if self._predicted is None:
            return []
        name, asked_in = self._predicted
        setups, runs = self._play(step)
        if name in setups and _key(self._setups[name]) in runs:
            return []
        run = RUN_OF_SETUP.get(self._setups[name].get("setup"), "release")
        return [f'step {step.get("step")}: Step {asked_in} asked the learner to predict how {name} ends, and this Step is the reveal; keep {name} as it was in Step {asked_in}, run it with {{"op": "{run}", "on": ["{name}"]}} and let the narration tell what the learner sees happen']

    def _challenge_errors(self, step: dict[str, Any]) -> list[str]:
        challenge = step.get("challenge")
        if not isinstance(challenge, dict) or challenge.get("kind") != "predict":
            return []
        setups, runs = self._play(step)
        name = _asked_about(challenge, setups)
        if name is None:
            return []
        key = _key(setups[name])
        if key in runs:
            return [f'step {step.get("step")} challenge: this Step runs {name} before the challenge waits, so the learner watches how it ends and only remembers the answer; take that run out of this Step\'s "do" and let the next Step run it as the reveal']
        played_in = self._played.get(key)
        if played_in is None:
            return []
        fields = " or ".join(field for field in setups[name] if field != "setup")
        return [f'step {step.get("step")} challenge: Step {played_in} already ran {name} with these same values, so the learner watched how it ends and only remembers the answer. Keep the challenge and, in this Step\'s "do", first change {name} with a "set" op to a value the learner has not seen run, such as {{"op": "set", "on": ["{name}"], "<{fields}>": <new value>}}, so the next Step can run it as the reveal; make the narration tell the change, and keep the challenge\'s answer true for the new value']

    def _play(self, step: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
        setups = dict(self._setups)
        for name, spec in (step.get("scene") or {}).items():
            if isinstance(spec, dict) and spec.get("lab") == PHYSICS_LAB:
                setups[name] = {field: value for field, value in spec.items() if field not in NOT_SETUP}
            elif isinstance(spec, dict) and "lab" not in spec and name in setups:
                setups[name] = {**setups[name], **{field: value for field, value in spec.items() if field not in NOT_SETUP}}
            else:
                setups.pop(name, None)
        runs: list[str] = []
        for operation in step.get("do") or []:
            name = _single_target(operation)
            if name not in setups:
                continue
            if operation.get("op") == RESET:
                setups[name] = {**setups[name], **{field: value for field, value in operation.items() if field not in NOT_VALUES}}
            elif operation.get("op") in RUNS:
                runs.append(_key(setups[name]))
        return setups, runs


def _single_target(operation: Any) -> str | None:
    targets = operation.get("on") if isinstance(operation, dict) else None
    return targets[0] if isinstance(targets, list) and len(targets) == 1 and isinstance(targets[0], str) else None


def _asked_about(challenge: dict[str, Any], setups: dict[str, dict[str, Any]]) -> str | None:
    for field in ("answer", "on"):
        value = challenge.get(field)
        for target in value if isinstance(value, list) else [value]:
            name = str(target).split("[")[0]
            if name in setups:
                return name
    return None


def _key(setup: dict[str, Any]) -> str:
    return json.dumps(setup, sort_keys=True)
