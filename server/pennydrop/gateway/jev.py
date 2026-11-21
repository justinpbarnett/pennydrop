from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from ..settings import Settings
from .types import RouteError, Usage

ENDPOINT = "https://openrouter.ai/api/v1/systemone"


@dataclass(frozen=True)
class Choice:
    instructions: str
    criteria: dict[str, str]


@dataclass(frozen=True)
class Score:
    instructions: str
    anchors: list[str]


@dataclass(frozen=True)
class YesNo:
    instructions: str


Question = Choice | Score | YesNo


@dataclass(frozen=True)
class ChoiceAnswer:
    choice: str
    confidence: float


@dataclass(frozen=True)
class ScoreAnswer:
    score: float
    confidence: float


@dataclass(frozen=True)
class YesNoAnswer:
    probability_yes: float

    @property
    def yes(self) -> bool:
        return self.probability_yes >= 0.5


Answer = ChoiceAnswer | ScoreAnswer | YesNoAnswer


class JevRoute:
    def __init__(self, settings: Settings):
        self._key = settings.secret("OPENROUTER_API_KEY")

    def unavailable_reason(self) -> str | None:
        return None if self._key else "OPENROUTER_API_KEY is not set in .env"

    async def classify(self, model: str, state: str, questions: dict[str, Question], timeout: float) -> tuple[dict[str, Answer], Usage]:
        body = {"model": model, "state": state, "questions": {name: _wire_question(q) for name, q in questions.items()}}
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {self._key}"}, json=body)
        if response.status_code != 200:
            raise RouteError(f"jev answered {response.status_code}: {response.text[:300]}")
        reply = response.json()
        usage = reply["usage"]
        return (
            {name: _parse_answer(raw) for name, raw in reply["answers"].items()},
            Usage(usage["input_tokens"], 0, usage["output_tokens"], usage["cost"]),
        )


def _wire_question(question: Question) -> dict[str, Any]:
    match question:
        case Choice(instructions, criteria):
            return {"type": "choice", "instructions": instructions, "criteria": criteria}
        case Score(instructions, anchors):
            return {"type": "score", "instructions": instructions, "criteria": anchors}
        case YesNo(instructions):
            return {"type": "noul", "instructions": instructions}


def _parse_answer(raw: dict[str, Any]) -> Answer:
    match raw["type"]:
        case "choice":
            return ChoiceAnswer(raw["choice"], raw["confidence"])
        case "score":
            return ScoreAnswer(raw["score"], raw["confidence"])
        case "noul":
            return YesNoAnswer(raw["noul"])
    raise RouteError(f"jev returned an answer of unknown type '{raw['type']}'")
