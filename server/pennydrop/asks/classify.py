from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from ..gateway import Choice, ChoiceAnswer, Gateway, Question, Score, ScoreAnswer, YesNo, YesNoAnswer
from ..settings import Job
from ..store import Profile, ProfileKind
from .catalog import LabEntry

STRONG_TIER_FROM_SCORE = 1.5
LAB_QUESTION_PREFIX = "lab_"
KID_LAB_HINTS = {
    "picture": "Answer yes when a child asks what a real thing looks like, asks to see it, or asks what is inside it or what parts it has: a real photo shows it better than drawn shapes.",
}
FOLLOW_UP = "follow_up"
NEW_TOPIC = "new_topic"


class Tier(StrEnum):
    FAST = "fast"
    STRONG = "strong"

    @property
    def job(self) -> Job:
        return Job.WRITER_STRONG if self is Tier.STRONG else Job.WRITER_FAST


@dataclass(frozen=True)
class Viewing:
    title: str
    goal: str
    current_say: str


@dataclass(frozen=True)
class Plan:
    follow_up: bool
    labs: tuple[str, ...]
    tier: Tier
    fine_for_young_child: bool
    graded_assignment: bool


class Classifier:
    def __init__(self, gateway: Gateway):
        self._gateway = gateway

    async def plan(self, ask: str, profile: Profile | None, labs: tuple[LabEntry, ...], viewing: Viewing | None, lesson_id: str) -> Plan:
        questions: dict[str, Question] = {
            "depth": Score(
                "How deep or subtle is the idea the person asks about?",
                [
                    "0: a plain, well known fact or simple mechanism a beginner can follow",
                    "1: a multi step mechanism with several interacting parts",
                    "2: a deep, subtle or advanced idea where precision and nuance matter",
                ],
            ),
            "graded_assignment": YesNo("Does the person want code or answers for a graded course assignment, rather than to understand a concept?"),
        }
        is_kid = profile is not None and profile.kind is ProfileKind.KID
        for lab in labs:
            question = f"Would the {lab.title} Lab help show this Ask as an animation? The {lab.title} Lab is: {lab.summary}"
            if is_kid and lab.id in KID_LAB_HINTS:
                question += " " + KID_LAB_HINTS[lab.id]
            questions[LAB_QUESTION_PREFIX + lab.id] = YesNo(question)
        if viewing:
            questions["relation"] = Choice(
                "Does the Ask continue the Lesson the person is watching, or start a new Topic?",
                {FOLLOW_UP: "it builds on, questions or goes deeper into the Lesson being watched", NEW_TOPIC: "it is about something else"},
            )
        if is_kid:
            questions["young_child_ok"] = YesNo("Is this question fine for a young child to learn about?")
        result = await self._gateway.classify(_state(ask, profile, viewing), questions, lesson_id=lesson_id)
        answers = result.answers
        depth = answers["depth"]
        assert isinstance(depth, ScoreAnswer)
        relation = answers.get("relation")
        return Plan(
            follow_up=isinstance(relation, ChoiceAnswer) and relation.choice == FOLLOW_UP,
            labs=tuple(lab.id for lab in labs if _yes(answers[LAB_QUESTION_PREFIX + lab.id])),
            tier=Tier.STRONG if depth.score >= STRONG_TIER_FROM_SCORE else Tier.FAST,
            fine_for_young_child=_yes(answers["young_child_ok"]) if is_kid else True,
            graded_assignment=_yes(answers["graded_assignment"]),
        )

    async def fine_for_young_child(self, say: str, lesson_id: str) -> bool:
        question = YesNo("Is this narration fine for a young child to hear: gentle, true, and free of frightening, violent or adult content?")
        result = await self._gateway.classify(say, {"fine": question}, lesson_id=lesson_id)
        return _yes(result.answers["fine"])

    async def keeps_honor_code(self, step_text: str, honor_code: str, lesson_id: str) -> bool:
        question = YesNo(f"Does this Lesson Step keep this honor code: {honor_code}")
        result = await self._gateway.classify(step_text, {"keeps": question}, lesson_id=lesson_id)
        return _yes(result.answers["keeps"])


def _yes(answer) -> bool:
    assert isinstance(answer, YesNoAnswer)
    return answer.yes


def _state(ask: str, profile: Profile | None, viewing: Viewing | None) -> str:
    lines = [f"Ask: {ask}"]
    if profile:
        lines.append(f"Learner: {profile.kind.value}, level {profile.level}")
    if viewing:
        lines.append(f"Watching the Lesson '{viewing.title}' (goal: {viewing.goal}), now at: {viewing.current_say}")
    return "\n".join(lines)
