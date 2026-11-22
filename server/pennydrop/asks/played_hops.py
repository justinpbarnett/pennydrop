from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any

SHAPES_LAB = "shapes"
LINE_FIGURE = "line"
BLOCKS_FIGURE = "blocks"
HOP = "hop"
SPOT = re.compile(r"^(?P<line>[\w-]+)\[(?P<spot>-?\d+)\]$")


@dataclass(frozen=True)
class Hopper:
    base: int
    at: int
    landed: tuple[tuple[int, int], ...]
    asked: bool = False

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
    def __init__(self, warm_up_only_one: bool = False) -> None:
        self._warm_up_only_one = warm_up_only_one
        self._hoppers: dict[str, Hopper] = {}
        self._piles: set[str] = set()
        self._asked: AskedLanding | None = None

    def remember(self, step: dict[str, Any]) -> None:
        revealed = self._asked
        self._hoppers = self._play(step)
        self._piles = self._piles_after(step)
        if revealed and revealed.line in self._hoppers:
            settled = self._hoppers[revealed.line]
            self._hoppers[revealed.line] = Hopper(settled.at, settled.at, (), asked=True)
        self._asked = _landing_asked(step, self._hoppers)
        if self._asked:
            self._hoppers[self._asked.line] = replace(self._hoppers[self._asked.line], asked=True)

    def errors_in(self, step: dict[str, Any]) -> list[str]:
        return self._reveal_errors(step) + self._warm_up_errors(step) + self._challenge_errors(step) + self._block_tapped(step)

    def _block_tapped(self, step: dict[str, Any]) -> list[str]:
        challenge = step.get("challenge")
        found = SPOT.match(str(challenge.get("answer"))) if self._warm_up_only_one and isinstance(challenge, dict) else None
        if not found or found["line"] not in self._piles_after(step):
            return []
        pile = found["line"]
        return [f'step {step.get("step")} challenge: a child cannot answer a sum by tapping one block of {pile}, so ask on a number line instead: in this Step\'s "scene" set {pile} to null and bring in {{"lab": "{SHAPES_LAB}", "figure": "{LINE_FIGURE}", "from": 0, "to": 10, "start": <the first number of the sum>}}, ask where the hopper lands after the asked hops, make that spot the answer, such as line[7], and let the next Step hop there']

    def _piles_after(self, step: dict[str, Any]) -> set[str]:
        piles = set(self._piles)
        for name, spec in (step.get("scene") or {}).items():
            if isinstance(spec, dict) and spec.get("lab") == SHAPES_LAB and spec.get("figure") == BLOCKS_FIGURE:
                piles.add(name)
            else:
                piles.discard(name)
        return piles

    def _warm_up_errors(self, step: dict[str, Any]) -> list[str]:
        if not self._warm_up_only_one:
            return []
        errors = []
        for name, hopper in self._play(step).items():
            earlier = self._hoppers.get(name)
            far = [spot for spot, _ in hopper.landed[len(earlier.landed) :] if abs(spot - hopper.base) > 1] if earlier and not earlier.asked else []
            if far:
                errors.append(f'step {step.get("step")}: before its Challenge, a sum on {name} plays only one hop of one away from where it starts, {hopper.base}, and back, so the hops the Challenge asks about stay unplayed; this Step takes the hopper to {far[-1]}. Hop it at most to {hopper.base + 1} or {hopper.base - 1}, then back to {hopper.base} before the Challenge, and narrate only those hops')
        return errors

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
