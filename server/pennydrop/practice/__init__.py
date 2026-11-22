from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class Form(StrEnum):
    SAY = "say"
    APPLIES = "applies"
    FRESH = "fresh"


FORMS: tuple[Form, ...] = (Form.SAY, Form.APPLIES, Form.FRESH)


class Direction(StrEnum):
    FORWARD = "forward"
    BACK = "back"

    @property
    def other(self) -> Direction:
        return Direction.BACK if self is Direction.FORWARD else Direction.FORWARD


@dataclass(frozen=True)
class Rule:
    statement: str
    condition: str
    slots: tuple[str, ...]


@dataclass(frozen=True)
class Practice:
    rule: Rule
    items: tuple[dict[str, Any], ...]

    def line(self) -> dict[str, Any]:
        return {"practice": {"rule": self.rule.statement, "condition": self.rule.condition, "slots": list(self.rule.slots), "challenges": list(self.items)}}


class PracticeError(RuntimeError):
    pass
