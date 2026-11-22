from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from ..gateway import Choice, ChoiceAnswer, Gateway, Question, Score, ScoreAnswer, YesNo, YesNoAnswer
from ..pictures import subject_phrases
from ..settings import Job
from ..store import Profile, ProfileKind
from .catalog import LabEntry

STRONG_TIER_FROM_SCORE = 1.5
LAB_QUESTION_PREFIX = "lab_"
KID_LAB_HINTS = {
    "picture": "Answer yes when a child asks what a real thing looks like, asks to see it, or asks what is inside it or what parts it has: a real photo shows it better than drawn shapes.",
}
LAB_LIMITS = {
    "picture": "Answer yes when the Ask is about what a physical thing looks like or about its parts, such as an animal, a vehicle, a machine, a building, a plant or a body part: a real photo shows it. Answer no for mathematics, code, data, processes and abstract ideas.",
}
FOLLOW_UP = "follow_up"
NEW_TOPIC = "new_topic"
PICTURE_LAB = "picture"
NO_SUBJECT = "none"


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
    photo_subject: str | None


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
            if lab.id in LAB_LIMITS:
                question += " " + LAB_LIMITS[lab.id]
            if is_kid and lab.id in KID_LAB_HINTS:
                question += " " + KID_LAB_HINTS[lab.id]
            questions[LAB_QUESTION_PREFIX + lab.id] = YesNo(question)
        if viewing:
            questions["relation"] = Choice(
                "Does the Ask continue the Lesson the person is watching, or start a new Topic?",
                {FOLLOW_UP: "it builds on, questions or goes deeper into the Lesson being watched", NEW_TOPIC: "it is about something else"},
            )
        phrases = subject_phrases(ask) if any(lab.id == PICTURE_LAB for lab in labs) else []
        if phrases:
            questions["photo_subject"] = Choice(
                "Which words name the one real, physical thing a photo for this Ask should show, as plainly as a child would name it?",
                {phrase: f'a photo of "{phrase}"' for phrase in phrases} | {NO_SUBJECT: "no real thing a photo could show"},
            )
        if is_kid:
            questions["young_child_ok"] = YesNo("Is this question fine for a young child to learn about?")
        result = await self._gateway.classify(_state(ask, profile, viewing), questions, lesson_id=lesson_id)
        answers = result.answers
        depth = answers["depth"]
        assert isinstance(depth, ScoreAnswer)
        relation = answers.get("relation")
        subject = answers.get("photo_subject")
        return Plan(
            follow_up=isinstance(relation, ChoiceAnswer) and relation.choice == FOLLOW_UP,
            labs=tuple(lab.id for lab in labs if _yes(answers[LAB_QUESTION_PREFIX + lab.id])),
            tier=Tier.STRONG if depth.score >= STRONG_TIER_FROM_SCORE else Tier.FAST,
            fine_for_young_child=_yes(answers["young_child_ok"]) if is_kid else True,
            graded_assignment=_yes(answers["graded_assignment"]),
            photo_subject=subject.choice if isinstance(subject, ChoiceAnswer) and subject.choice in phrases else None,
        )

    async def fine_for_young_child(self, say: str, lesson_id: str) -> bool:
        question = YesNo("Is this narration fine for a young child to hear: gentle, true, and free of frightening, violent or adult content?")
        result = await self._gateway.classify(say, {"fine": question}, lesson_id=lesson_id)
        return _yes(result.answers["fine"])

    async def keeps_honor_code(self, step_text: str, honor_code: str, lesson_id: str) -> bool:
        question = YesNo(f"Does this Lesson Step keep this honor code: {honor_code}")
        result = await self._gateway.classify(step_text, {"keeps": question}, lesson_id=lesson_id)
        return _yes(result.answers["keeps"])

    async def states_a_claim(self, point: str, lesson_id: str) -> bool:
        question = YesNo("Is this one full sentence that claims something which could be true or false, such as a cause or an effect, and not just the name of a topic?")
        result = await self._gateway.classify(point, {"claim": question}, lesson_id=lesson_id)
        return _yes(result.answers["claim"])

    async def restates_point(self, say: str, point: str, lesson_id: str) -> bool:
        question = YesNo("Does the narration state the point?")
        result = await self._gateway.classify(f"Point: {point}\nNarration: {say}", {"restates": question}, lesson_id=lesson_id)
        return _yes(result.answers["restates"])

    async def claims_agree(self, claimed: str, facts: list[str], lesson_id: str) -> bool:
        question = YesNo(
            "The facts were computed by running the Lesson's examples and are correct."
            " Does every claim the Step makes about those examples agree with the facts, such as a number, which run gives a lower or higher value,"
            " which job finishes first or sooner, or whether a value drops or rises? A claim about every job, the short jobs or the whole run holds only when the facts show it for each of them,"
            " and two equal values are neither lower nor sooner. A Challenge's stated answer is a claim. A question, or a claim the facts say nothing about, agrees."
        )
        text = "\n".join([*(f"Fact: {fact}" for fact in facts), f"Step: {claimed}"])
        result = await self._gateway.classify(text, {"agree": question}, lesson_id=lesson_id)
        return _yes(result.answers["agree"])


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
