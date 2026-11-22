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
    base: int
    at: int
    landed: tuple[tuple[int, int], ...]

    def hopped(self, by: int, each: int, step: int) -> Hopper:
        spots = range(self.at + each, self.at + by + each, each) if by > 0 else range(self.at - each, self.at + by - each, -each)
        return replace(self, at=self.at + by, landed=self.landed + tuple((spot, step) for spot in spots))

    def landed_on(self, spot: int) -> int | None:
        return next((step for landed, step in self.landed if landed == spot), None)


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
            settled = self._hoppers[revealed.line]
            self._hoppers[revealed.line] = Hopper(settled.at, settled.at, ())
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
        return [f'step {step.get("step")}: Step {asked.asked_in} asked the learner to tap where the hopper lands, and its answer is {asked.spot}; this Step is the reveal and {left}. Keep {asked.line} on stage as it was, with the hopper on {asked.standing}, and play the asked hops from there with {{"op": "{HOP}", "on": ["{asked.line}"], "by": {by}, "each": 1}} so it lands on {asked.spot}, and let the narration tell where it lands']

    def _challenge_errors(self, step: dict[str, Any]) -> list[str]:
        hoppers = self._play(step)
        asked = _landing_asked(step, hoppers)
        if asked is None:
            return []
        hopper = hoppers[asked.line]
        prefix = f"step {step.get('step')} challenge:"
        if hopper.at != hopper.base:
            back = hopper.base - hopper.at
            return [f'{prefix} the sum starts with the hopper on {hopper.base}, but when the Challenge waits it stands on {hopper.at}, after the hops played so far, so the learner predicts only the last few hops instead of the sum. Add {{"op": "{HOP}", "on": ["{asked.line}"], "by": {back}, "each": {abs(back)}}} to the end of this Step\'s "do" so the hopper is back on {hopper.base}, say that it goes back, and make the answer the spot the asked hops from {hopper.base} land on']
        if asked.spot == hopper.at:
            return [f"{prefix} the hopper already stands on {asked.spot} when the Challenge waits, so the learner taps where it is instead of predicting where it lands; ask where it lands after the hops the Ask is about, and make that spot the answer"]
        if (seen := hopper.landed_on(asked.spot)) is not None:
            return [f"{prefix} the hopper already landed on {asked.spot} in Step {seen}, so the learner remembers the spot instead of predicting it; the Steps before the Challenge must hop only a smaller sum that stops short of {asked.spot}, so rewrite the hops before the Challenge to stop short of it and hop back to {hopper.base}"]
        return []

    def _play(self, step: dict[str, Any]) -> dict[str, Hopper]:
        hoppers = dict(self._hoppers)
        brought: set[str] = set()
        for name, spec in (step.get("scene") or {}).items():
            if isinstance(spec, dict) and spec.get("lab") == SHAPES_LAB and spec.get("figure") == LINE_FIGURE:
                start = _whole(spec.get("start"), _whole(spec.get("from"), 0))
                if name in hoppers:
                    hoppers[name] = replace(hoppers[name], at=start)
                else:
                    hoppers[name] = Hopper(start, start, ())
                    brought.add(name)
            else:
                hoppers.pop(name, None)
        for operation in step.get("do") or []:
            targets = operation.get("on") if isinstance(operation, dict) and operation.get("op") == HOP else None
            by = _whole(operation.get("by"), 0) if targets else 0
            if isinstance(targets, list) and len(targets) == 1 and targets[0] in hoppers and by:
                each = abs(_whole(operation.get("each"), by)) or abs(by)
                hoppers[targets[0]] = hoppers[targets[0]].hopped(by, each, step.get("step", 0))
        for name in brought:
            hoppers[name] = replace(hoppers[name], base=hoppers[name].at)
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
