from __future__ import annotations

import json
import random
from dataclasses import dataclass
from typing import Any

from .gateway import Gateway, GatewayError
from .lessons import LessonLibrary
from .settings import Job

JUDGE_EFFORT = "medium"
JUDGE_TIMEOUT_SECONDS = 300.0
TIE = "tie"

CRITERIA = {
    "promise": "Step 1 asks the question the Lesson answers, in the learner's own world, in at most 14 words.",
    "normal_case": "The early Steps show the normal case: what the learner already knows or assumes.",
    "break": "A Step breaks that assumption or shows the problem.",
    "cause_chain": "From the break on, each Step follows from the one before by cause (because of that), never by 'and then'; the chain is the mechanism being taught.",
    "hinge": "A predict Challenge sits where the learner can add up the earlier Steps and reach the answer before the reveal, and it is not a quiz stuck on the end.",
    "reveal": "A Step reveals the answer the promise and the hinge led to.",
    "point_shown_and_restated": "The stage proves the point with something the learner watches happen, and the last Step says the point again in plain words.",
    "on_point": "No Step is off the point: every Step moves the story toward it, with no filler operation, no Step that only talks over an unchanged stage and no Step pulsing objects for nothing.",
}

SYSTEM = f"""You judge Pennydrop Lessons: short narrated animated Lessons that teach one idea, one Step after another. A good Lesson is a story that proves one point, built on Kenn Adams's story spine: the normal case, the break, a cause chain, the reveal, and a last Step that says the point again. A Step holds narration ("say"), the objects it puts on stage ("scene"), operations that animate them ("do"), and sometimes a predict Challenge. A Learner who is a kid has nothing to read, so everything is shown and spoken.

Judge only what the Lesson shows. Be strict and specific: a criterion passes only when the Lesson clearly does it, and every reason names the Step numbers behind it.

The criteria:
{chr(10).join(f"- {name}: {text}" for name, text in CRITERIA.items())}

Reply with one JSON object and nothing else."""

SCORE_SHAPE = '{"criteria": {"<criterion>": {"pass": true, "reason": "one short sentence"}, ...}, "overall": <integer 0 to 10: how well the Lesson tells a story that proves its point>}'
PAIR_SHAPE = '{"criteria": {"<criterion>": {"better": "A" or "B" or "tie", "reason": "one short sentence"}, ...}, "overall": {"better": "A" or "B" or "tie", "reason": "one short sentence"}}'


class JudgeError(GatewayError):
    pass


@dataclass(frozen=True)
class Mark:
    passed: bool
    reason: str


@dataclass(frozen=True)
class Scorecard:
    lesson_id: str
    title: str
    marks: dict[str, Mark]
    overall: int

    @property
    def summary(self) -> str:
        return f"{sum(mark.passed for mark in self.marks.values())}/{len(CRITERIA)} criteria, overall {self.overall}/10"


@dataclass(frozen=True)
class Preference:
    better: str | None
    reason: str


@dataclass(frozen=True)
class Comparison:
    by_criterion: dict[str, Preference]
    overall: Preference


class Judge:
    def __init__(self, gateway: Gateway, library: LessonLibrary):
        self._gateway = gateway
        self._library = library

    async def score(self, lesson_id: str) -> Scorecard:
        raw = self._library.raw(lesson_id)
        prompt = f"{_lesson_text(raw.header, raw.steps, with_point=True)}\n\nReply in this shape: {SCORE_SHAPE}"
        reply = await self._ask(prompt)
        try:
            marks = {name: Mark(bool(reply["criteria"][name]["pass"]), str(reply["criteria"][name]["reason"])) for name in CRITERIA}
            return Scorecard(lesson_id, raw.header.get("title", ""), marks, int(reply["overall"]))
        except (KeyError, TypeError, ValueError):
            raise JudgeError(f"the judge's reply for lesson {lesson_id} does not follow the shape: {json.dumps(reply)[:300]}") from None

    async def compare(self, first_id: str, second_id: str) -> Comparison:
        order = [first_id, second_id]
        random.shuffle(order)
        shown = [self._library.raw(lesson_id) for lesson_id in order]
        prompt = "\n\n".join([
            *(f"Lesson-{label}\n{_lesson_text(raw.header, raw.steps, with_point=False)}" for label, raw in zip("AB", shown)),
            "Neither Lesson states its point: infer what each one proves from its Steps. In every reason, write Lesson-A or Lesson-B and never A or B alone.",
            f"For each criterion say which Lesson does it better, A or B, or tie when they are equal. Then say which Lesson is better overall. Reply in this shape: {PAIR_SHAPE}",
        ])
        reply = await self._ask(prompt)
        owner = {"A": order[0], "B": order[1], TIE: None}

        def unblinded(reason: Any) -> str:
            return str(reason).replace("Lesson-A", order[0]).replace("Lesson-B", order[1])

        try:
            by_criterion = {name: Preference(owner[reply["criteria"][name]["better"]], unblinded(reply["criteria"][name]["reason"])) for name in CRITERIA}
            overall = Preference(owner[reply["overall"]["better"]], unblinded(reply["overall"]["reason"]))
        except (KeyError, TypeError):
            raise JudgeError(f"the judge's reply for {first_id} against {second_id} does not follow the shape: {json.dumps(reply)[:300]}") from None
        return Comparison(by_criterion, overall)

    async def _ask(self, prompt: str) -> dict[str, Any]:
        completion = await self._gateway.complete(Job.JUDGE, prompt, system=SYSTEM, effort=JUDGE_EFFORT, timeout=JUDGE_TIMEOUT_SECONDS)
        start, end = completion.text.find("{"), completion.text.rfind("}")
        try:
            return json.loads(completion.text[start : end + 1])
        except json.JSONDecodeError:
            raise JudgeError(f"the judge did not reply with JSON: {completion.text[:300]}") from None


def _lesson_text(header: dict[str, Any], steps: list[dict[str, Any]], with_point: bool) -> str:
    lines = [f"Title: {header.get('title', '')}", f"Goal: {header.get('goal', '')}"]
    if with_point:
        lines.append(f"Stated point: {header['point']}" if header.get("point") else "Stated point: none was written, so infer what the Lesson proves from its Steps and judge it against that.")
    lines.append(f"Learner: {'kid, nothing to read' if header.get('reading') is False else 'reads along'}")
    lines.extend(f"Step {step['step']}: " + json.dumps({key: value for key, value in step.items() if key not in ("step", "voice")}, separators=(",", ":")) for step in steps)
    return "\n".join(lines)
