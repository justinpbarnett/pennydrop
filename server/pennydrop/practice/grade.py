from __future__ import annotations

from dataclasses import dataclass

from ..gateway import Gateway, GatewayError
from ..settings import Job
from ..store import Profile, ProfileKind
from .records import PracticeCase, RuleRecord

GRADE_TIMEOUT_SECONDS = 60.0

SYSTEM = """You grade one answer a learner gave in their own words, for a Pennydrop Practice question about a Rule.

The answer passes when both hold:
- it states the idea of the Rule, in any words that carry the same meaning: exact wording is never needed;
- it gives a reason for the idea, with "because" or a plain equivalent ("since", "so that", "that is why").

A correct idea with no reason fails, and the feedback asks for the reason. A wrong idea fails, and the feedback says in one sentence what the Rule says. A reason that is wrong fails.
Feedback is one or two short sentences to the learner, in the second person, warm and specific, never a lecture.

Reply with one JSON object and nothing else: {"correct": true or false, "feedback": "..."}"""

KID_NOTE = """The learner is a young child and the answer was spoken, then turned into text, so expect odd grammar, fillers, repeated words and small transcription slips. Grade kindly: the child needs no exact words and no long sentence. A simple reason such as "because it goes down" counts. Feedback uses short, friendly words a child knows."""


class GradingError(GatewayError):
    pass


@dataclass(frozen=True)
class Grade:
    correct: bool
    feedback: str


class WordsGrader:
    def __init__(self, gateway: Gateway):
        self._gateway = gateway

    async def grade(self, rule: RuleRecord, case: PracticeCase, answer: str, profile: Profile) -> Grade:
        prompt = "\n".join([
            f"Rule: {rule.statement}",
            f"It holds when: {rule.condition}",
            f"Question the learner was asked: {case.item['say']}",
            f"Learner's answer: {answer.strip() or '(nothing)'}",
        ])
        system = f"{SYSTEM}\n\n{KID_NOTE}" if profile.kind is ProfileKind.KID else SYSTEM
        completion = await self._gateway.complete(Job.GRADE, prompt, system=system, timeout=GRADE_TIMEOUT_SECONDS)
        reply = completion.json_object
        try:
            return Grade(bool(reply["correct"]), str(reply["feedback"]))
        except (KeyError, TypeError):
            raise GradingError(f"the grader did not reply with the expected JSON: {completion.text[:300]}") from None
