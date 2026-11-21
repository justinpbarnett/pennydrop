from __future__ import annotations

from dataclasses import dataclass

MINIMUM_EASE = 1.3
PASSING_QUALITY = 3
CORRECT_QUALITY = 4
WRONG_QUALITY = 1


@dataclass(frozen=True)
class Schedule:
    ease: float
    interval_days: int
    reps: int
    lapses: int


NEW_ITEM = Schedule(ease=2.5, interval_days=0, reps=0, lapses=0)

ANSWER_SHAPES = {
    "number": "a number",
    "choice": "one of the choices, as its text",
    "click": "the id of one object on the stage",
    "order": "all the choices, in order, as a list of their text",
    "match": "a list of [left, right] pairs",
}


def answer_shape(challenge: dict) -> str:
    return ANSWER_SHAPES[challenge["type"]]


def quality_for(correct: bool) -> int:
    return CORRECT_QUALITY if correct else WRONG_QUALITY


def next_schedule(current: Schedule, quality: int) -> Schedule:
    ease = max(MINIMUM_EASE, current.ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    if quality < PASSING_QUALITY:
        return Schedule(ease=ease, interval_days=1, reps=0, lapses=current.lapses + 1)
    reps = current.reps + 1
    if reps == 1:
        interval = 1
    elif reps == 2:
        interval = 6
    else:
        interval = round(current.interval_days * ease)
    return Schedule(ease=ease, interval_days=interval, reps=reps, lapses=current.lapses)
