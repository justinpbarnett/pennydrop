from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from ..gateway import CallStats, Gateway
from ..settings import Job
from ..store import Profile
from .catalog import Catalog
from .classify import Plan
from .directives import directive_guides
from .lesson_format import Header, Malformed, ParsedLine, parse_line
from .stopwatch import Stopwatch

FORMAT_RULES = """You write Pennydrop Lessons: short narrated animations that teach one idea.
Your whole reply is JSON lines and nothing else: no prose, no code fences, no comments.

Line 1 is the header: {"lesson": {"title": "short title", "goal": "one sentence on what the learner can do or see afterwards", "labs": ["ids of the Labs you use"]}}
Every later line is one Step: {"step": 1, "say": "narration", "scene": {...}, "do": [...], "challenge": {...}}
"scene", "do" and "challenge" are optional.

Rules
- Write 6 to 10 Steps.
- Step 1 is short: one or two sentences and at most one or two scene objects, so it can start playing at once.
- "say" is spoken aloud: plain words, about 25 words at most, no markdown, no symbols that are hard to speak.
- Use only the Labs and primitives of the catalog below, with their exact spec fields and operations. An object with "lab" is a Lab, an object with "kind" is a primitive.
- When no Lab fits the Ask, build the explanation from primitives and the generic verbs.
- Never write coordinates, pixel sizes or colors. Place objects with "at" relations and color with roles.
- A Step's "scene" sets or replaces the objects it names, and null removes one. Every other object stays. A Step with no "scene" keeps the Scene as it was.
- Put new objects in "scene". Use the generic verb "create" only for an object that must appear on a spoken Cue, and then always with "spec" holding the full object spec.
- "do" runs after "scene". Each entry's "cue" is a word or phrase copied exactly from that Step's "say", and cues appear in the order they are spoken.
- Include at least one predict Challenge. Put it on a Step before the Step that reveals the answer, and let that Step's narration ask the question without giving the answer.
- Challenge shapes, all with "kind": "predict":
  {"kind": "predict", "type": "number", "prompt": "...", "answer": 6}
  {"kind": "predict", "type": "choice", "prompt": "...", "choices": ["a", "b"], "answer": "a"}
  {"kind": "predict", "type": "click", "prompt": "...", "answer": "object id or list of ids"}
  {"kind": "predict", "type": "order", "prompt": "...", "choices": ["a", "b", "c"], "answer": ["b", "a", "c"]}
  {"kind": "predict", "type": "match", "prompt": "...", "pairs": [["left", "right"], ["left", "right"]]}
- Every number that comes from running code or from arithmetic comes from a directive, never from you. A directive is a field of the Step that the server runs before the Step plays.
- When "say" brings in a new example, number, list or object, that same Step's "scene" sets it, so the stage always shows what the narration talks about.
- A Learner who is a kid gets words a young child knows, and a warm, playful voice. The kid rules below say more.
- A Learner level of beginner, intermediate or advanced sets how much you assume.

## Kid rules

These hold when the Learner is a kid, and nothing in a kid Lesson may need reading.
- Every Step is one or two short sentences.
- Show with pictures, shapes and physics, and put no text, code or math objects on the stage.
- Every Challenge is "kind": "predict" with "type": "click", where the child taps an object on the stage.
- The narration asks the question out loud, because the child hears it and does not read it.
- Do not write "reading" in the header.

## Directives

"""

REPAIR_INSTRUCTIONS = "Repair one Step of a Lesson. Reply with the corrected Step as exactly one JSON line and nothing else. Keep its step number and the meaning of its narration, and change only what the errors name."


@dataclass(frozen=True)
class Brief:
    ask: str
    profile: Profile | None
    plan: Plan
    scene: Any = None
    watching_title: str | None = None

    def text(self) -> str:
        lines = [f"Ask: {self.ask}", f"Learner: {self.profile.kind.value}, level {self.profile.level}" if self.profile else "Learner: adult, level beginner"]
        lines.append(
            f"Labs that fit this Ask: {', '.join(self.plan.labs)}. Use them where they help, together with primitives."
            if self.plan.labs else "No Lab fits this Ask: build the explanation from primitives."
        )
        if self.plan.follow_up:
            lines.append(f"This is a follow up to the Lesson '{self.watching_title}'. Step 1 continues from the Scene below, so reuse its objects instead of recreating them. When Step 1 brings in a new example, its \"scene\" replaces the objects that still show the old one, so the stage matches the narration.")
            lines.append(f"Current Scene (JSON): {json.dumps(self.scene)}")
        if self.plan.graded_assignment:
            lines.append("The Ask looks like a graded course assignment. Teach the underlying concept on a toy example of your own, and give no code or answers for the assignment.")
        if not self.plan.fine_for_young_child:
            lines.append("This Ask is not for a young child. Write one Step that kindly says this is a question for a grown up to answer together, and stop.")
        return "\n".join(lines)

WRITER_EFFORT = "low"


class Writer:
    def __init__(self, gateway: Gateway, catalog: Catalog):
        self._gateway = gateway
        self._catalog = catalog

    async def lines(self, brief: Brief, stopwatch: Stopwatch, lesson_id: str) -> AsyncIterator[ParsedLine]:
        system = await self._system()
        stopwatch.mark("writer_started")
        buffer = ""
        async for item in self._gateway.stream(brief.plan.tier.job, brief.text(), system=system, lesson_id=lesson_id, effort=WRITER_EFFORT):
            if isinstance(item, CallStats):
                continue
            stopwatch.mark("writer_first_token")
            buffer += item
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if parsed := parse_line(line):
                    yield parsed
        if parsed := parse_line(buffer):
            yield parsed

    async def repair(self, brief: Brief, scene: Any, written: dict[str, Any] | Malformed, errors: list[str], lesson_id: str) -> ParsedLine:
        shown = written.text if isinstance(written, Malformed) else json.dumps(written)
        prompt = "\n".join([
            REPAIR_INSTRUCTIONS,
            brief.text().split("\n")[0],
            f"Scene before this Step (JSON): {json.dumps(scene)}",
            f"The Step as written: {shown}",
            "It failed with:",
            *(f"- {error}" for error in errors),
        ])
        completion = await self._gateway.complete(Job.WRITER_FAST, prompt, system=await self._system(), lesson_id=lesson_id, effort=WRITER_EFFORT)
        for line in completion.text.splitlines():
            parsed = parse_line(line)
            if isinstance(parsed, Header):
                return Malformed(line, "the reply was a lesson header, and a single Step is needed")
            if parsed:
                return parsed
        return Malformed(completion.text, "the reply held no Step line")

    async def _system(self) -> str:
        return FORMAT_RULES + directive_guides() + "\n\n# Catalog\n\n" + (await self._catalog.current()).markdown
