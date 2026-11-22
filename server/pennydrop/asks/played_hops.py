from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any

from ..spoken import comparable_script

SHAPES_LAB = "shapes"
LINE_FIGURE = "line"
BLOCKS_FIGURE = "blocks"
HOP = "hop"
PILE_SUMS = ("add", "take")
SPOT = re.compile(r"^(?P<line>[\w-]+)\[(?P<spot>-?\d+)\]$")
NUMBER_NAMES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
STANDING_CLAIM = re.compile(r"\b(?:stands?|is|sits?|starts?|waits?)\s+(?:on|at)\s+(?P<number>\w+)", re.IGNORECASE)
HOPPING_CLAIM = re.compile(r"\b(?P<preposition>on|at|to)\s+(?P<number>\w+)", re.IGNORECASE)


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
        self._challenged = False
        self._asked: AskedLanding | None = None

    def remember(self, step: dict[str, Any]) -> None:
        revealed = self._asked
        self._hoppers = self._play(step)
        self._piles = self._piles_after(step)
        self._challenged = self._challenged or isinstance(step.get("challenge"), dict)
        if revealed and revealed.line in self._hoppers:
            settled = self._hoppers[revealed.line]
            self._hoppers[revealed.line] = Hopper(settled.at, settled.at, (), asked=True)
        self._asked = _landing_asked(step, self._hoppers)
        if self._asked:
            self._hoppers[self._asked.line] = replace(self._hoppers[self._asked.line], asked=True)

    def errors_in(self, step: dict[str, Any]) -> list[str]:
        return self._reveal_errors(step) + self._warm_up_errors(step) + self._challenge_errors(step) + self._block_tapped(step) + self._pile_sum_too_early(step) + self._position_errors(step)

    def plain_step(self, step: dict[str, Any]) -> dict[str, Any] | None:
        if not self._warm_up_only_one or self._challenged or len(self._hoppers) != 1:
            return None
        (name, hopper), = self._hoppers.items()
        asked = _landing_asked(step, self._hoppers)
        if asked is not None:
            if hopper.at != hopper.base or not hopper.landed:
                return None
            count = asked.spot - hopper.at
            hops = f"{_number_name(abs(count))} hop{'s' if abs(count) != 1 else ''}{' back' if count < 0 else ''}"
            return {"say": f"Tap the spot where {hops} from {_number_name(hopper.at)} will land.", "challenge": step["challenge"]}
        if "challenge" in step:
            return None
        if hopper.at == hopper.base:
            written = next((operation.get("by") for operation in step.get("do") or [] if isinstance(operation, dict) and operation.get("op") == HOP and operation.get("on") == [name]), 1)
            by = -1 if _whole(written, 1) < 0 else 1
            say = f"Hop one {'more' if by > 0 else 'back'}, to {_number_name(hopper.at + by)}."
        elif abs(hopper.at - hopper.base) == 1:
            by = hopper.base - hopper.at
            say = f"Hop back to {_number_name(hopper.base)}."
        else:
            return None
        return {"say": say, "do": [{"op": HOP, "on": [name], "by": by, "each": 1}]}

    def _position_errors(self, step: dict[str, Any]) -> list[str]:
        say = step.get("say")
        if not self._warm_up_only_one or self._challenged or not isinstance(say, str):
            return []
        before, after = self._play({**step, "do": []}), self._play(step)
        if len(after) != 1 or set(before) != set(after):
            return []
        (name, hopper), = after.items()
        start = before[name].at
        landed = {spot for spot, _ in hopper.landed[len(before[name].landed) :]} | {hopper.at}
        hopping = hopper.landed != before[name].landed
        claims = HOPPING_CLAIM.finditer(say) if hopping else STANDING_CLAIM.finditer(say)
        for claim in claims:
            spot = _spoken_whole(claim["number"])
            allowed = landed if hopping and claim["preposition"].lower() == "to" else landed | {start}
            if spot is not None and spot not in allowed:
                where = f"goes from {start} to {hopper.at}" if hopping else f"stands on {start}"
                return [f'step {step.get("step")}: the narration puts the hopper on {spot}, but in this Step the hopper on {name} {where}; tell only the spots the hopper stands on and lands on in this Step']
        return []

    def landing_told(self, step: dict[str, Any]) -> int | None:
        hoppers = self._play(step)
        asked = _landing_asked(step, hoppers)
        if asked is None or asked.spot in (hoppers[asked.line].base, abs(asked.spot - hoppers[asked.line].base)):
            return None
        return asked.spot if says_number(asked.spot, step.get("say")) else None

    def _pile_sum_too_early(self, step: dict[str, Any]) -> list[str]:
        if not self._warm_up_only_one or self._challenged:
            return []
        piles = self._piles_after(step)
        summed = next((target for operation in step.get("do") or [] if isinstance(operation, dict) and operation.get("op") in PILE_SUMS for target in operation.get("on") or [] if target in piles), None)
        if summed is None:
            return []
        return [f'step {step.get("step")}: the pile {summed} plays the sum before the child predicts it, so the child counts the answer instead of predicting where it lands; tell the sum on a number line first: in this Step\'s "scene" set {summed} to null and bring in {{"lab": "{SHAPES_LAB}", "figure": "{LINE_FIGURE}", "from": 0, "to": 10, "start": <the first number of the sum>}}, play at most one hop of one, and show the pile only after the Challenge\'s reveal']

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
            if not far:
                continue
            if earlier.at == hopper.base:
                fix = f'make this Step\'s "do" one hop of one, {{"op": "{HOP}", "on": ["{name}"], "by": 1, "each": 1}}, or "by": -1 for a take away, and narrate only that hop'
            else:
                fix = f'make this Step\'s "do" only {{"op": "{HOP}", "on": ["{name}"], "by": {hopper.base - earlier.at}, "each": 1}}, which hops the hopper from {earlier.at} back to {hopper.base}, and narrate only that hop back'
            errors.append(f'step {step.get("step")}: before its Challenge, a sum on {name} plays only one hop of one away from where it starts, {hopper.base}, and back, so the hops the Challenge asks about stay unplayed; this Step takes the hopper to {far[-1]}; {fix}')
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
        if self._warm_up_only_one and not hopper.asked and not hopper.landed:
            return [f"{prefix} the child has not seen the hopper hop on {asked.line} yet, so the Challenge comes before the normal case; leave the Challenge out of this Step, let the Steps after it hop one and hop back to {hopper.base}, and ask in the Step after those"]
        if (told := self.landing_told(step)) is not None:
            return [f'{prefix} the narration says {told}, where the hopper will land, before the learner taps it; leave that number out of "say" and let the next Step tell it']
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


def says_number(number: int, text: Any) -> bool:
    return isinstance(text, str) and str(number) in comparable_script(text)


def _number_name(number: int) -> str:
    return NUMBER_NAMES[number] if 0 <= number < len(NUMBER_NAMES) else str(number)


def _spoken_whole(token: str) -> int | None:
    plain = token.lower()
    if plain.isdigit():
        return int(plain)
    return NUMBER_NAMES.index(plain) if plain in NUMBER_NAMES else None


def _whole(value: Any, fallback: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else fallback
