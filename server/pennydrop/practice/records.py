from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..review import Schedule
from . import FORMS, Direction, Form, Rule

PracticeWire = dict[str, Any]


@dataclass(frozen=True)
class RuleRecord:
    id: int
    lesson_id: str
    topic_id: int | None
    statement: str
    condition: str
    slots: tuple[str, ...]

    @property
    def rule(self) -> Rule:
        return Rule(self.statement, self.condition, self.slots)


@dataclass(frozen=True)
class PracticeCase:
    id: int
    rule_id: int
    form: Form
    direction: Direction | None
    item: dict[str, Any]

    @property
    def is_graded_by_model(self) -> bool:
        return self.item["challenge"]["type"] == "words"


@dataclass(frozen=True)
class RuleReview:
    profile_id: int
    rule: RuleRecord
    next_form: Form
    next_direction: Direction
    latest: dict[Form, bool]
    schedule: Schedule
    due: datetime

    @property
    def passed(self) -> list[Form]:
        return [form for form in FORMS if self.latest.get(form)]

    @property
    def held(self) -> bool:
        return len(self.passed) == len(FORMS)


@dataclass(frozen=True)
class RuleLink:
    lesson_id: str
    rule_ids: tuple[int, int]


@dataclass(frozen=True)
class FormRate:
    rule_id: int
    rule: str
    form: Form
    answered: int
    passed: int

    @property
    def rate(self) -> float:
        return self.passed / self.answered
