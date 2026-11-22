from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any

SHAPES_LAB = "shapes"
LINE_FIGURE = "line"
HOP = "hop"
SPOT = re.compile(r"^(?P<line>[\w-]+)\[(?P<spot>-?\d+)\]$")


@dataclass(frozen=True)
class Hopper:
    start: int
    at: int
    hopped: int


@dataclass(frozen=True)
class AskedLanding:
    line: str
    spot: int
    standing: int
    asked_in: int


class PlayedHops:
    def __init__(self) -> None:
        self._hoppers: dict[str, Hopper] = {}
        self._asked: AskedLanding | None = None

    def remember(self, step: dict[str, Any]) -> None:
        revealed = self._asked
        self._hoppers = self._play(step)
        if revealed and revealed.line in self._hoppers:
            self._hoppers[revealed.line] = replace(self._hoppers[revealed.line], hopped=0)
        self._asked = _landing_asked(step, self._hoppers)

    def errors_in(self, step: dict[str, Any]) -> list[str]:
        return self._reveal_errors(step) + self._challenge_errors(step)

    def _reveal_errors(self, step: dict[str, Any]) -> list[str]:
        asked = self._asked
        if asked is None:
            return []
        hopper = self._play(step).get(asked.line)
        if hopper is not None and hopper.at == asked.spot:
            return []
        left = f"leaves the hopper on {hopper.at}" if hopper else f"takes {asked.line} off the stage"
        by = asked.spot - asked.standing
        return [f'step {step.get("step")}: Step {asked.asked_in} asked the learner to tap where the hopper lands, and its answer is {asked.spot}; this Step is the reveal and {left}. Keep {asked.line} as it was in Step {asked.asked_in}, with the hopper on {asked.standing}, and hop it {by} from there with {{"op": "{HOP}", "on": ["{asked.line}"], "by": {by}, "each": 1}} so it lands on {asked.spot}, and let the narration tell where it lands']

    def _challenge_errors(self, step: dict[str, Any]) -> list[str]:
        hoppers = self._play(step)
        asked = _landing_asked(step, hoppers)
        if asked is None:
            return []
        hopper = hoppers[asked.line]
        stand_back = f'stand the hopper back on {hopper.start} in this Step, with {asked.line} in its "scene" and "start": {hopper.start}, and make the answer the spot the asked hops from {hopper.start} land on'
        if asked.spot == hopper.at:
            return [f'step {step.get("step")} challenge: the hopper already stands on {asked.spot} when the Challenge waits, so the learner taps where it is instead of predicting where it lands; {stand_back}']
        if hopper.hopped >= abs(asked.spot - hopper.at):
            return [f'step {step.get("step")} challenge: the Steps up to this Challenge already hopped {hopper.hopped} along {asked.line}, and the hops it asks about are only {abs(asked.spot - hopper.at)} from {hopper.at}, so the learner counts on from what they watched instead of predicting. Before the Challenge, hop at most a smaller sum than the one it asks about, such as one hop, then {stand_back}']
        return []

    def _play(self, step: dict[str, Any]) -> dict[str, Hopper]:
        hoppers = dict(self._hoppers)
        for name, spec in (step.get("scene") or {}).items():
            if isinstance(spec, dict) and spec.get("lab") == SHAPES_LAB and spec.get("figure") == LINE_FIGURE:
                start = _whole(spec.get("start"), _whole(spec.get("from"), 0))
                earlier = hoppers.get(name)
                hoppers[name] = Hopper(earlier.start if earlier else start, start, earlier.hopped if earlier else 0)
            elif isinstance(spec, dict) and "lab" not in spec and name in hoppers and "start" in spec:
                hoppers[name] = replace(hoppers[name], at=_whole(spec["start"], hoppers[name].at))
            elif name in hoppers and not (isinstance(spec, dict) and "lab" not in spec):
                hoppers.pop(name)
        for operation in step.get("do") or []:
            targets = operation.get("on") if isinstance(operation, dict) and operation.get("op") == HOP else None
            if isinstance(targets, list) and len(targets) == 1 and targets[0] in hoppers and (by := _whole(operation.get("by"), 0)):
                hopper = hoppers[targets[0]]
                hoppers[targets[0]] = replace(hopper, at=hopper.at + by, hopped=hopper.hopped + abs(by))
        return hoppers


def _landing_asked(step: dict[str, Any], hoppers: dict[str, Hopper]) -> AskedLanding | None:
    challenge = step.get("challenge")
    if not isinstance(challenge, dict) or challenge.get("kind") != "predict":
        return None
    found = SPOT.match(str(challenge.get("answer")))
    if not found or found["line"] not in hoppers:
        return None
    return AskedLanding(found["line"], int(found["spot"]), hoppers[found["line"]].at, step.get("step", 0))


def _whole(value: Any, fallback: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else fallback
