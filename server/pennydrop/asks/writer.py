from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from ..courses import CourseContext
from ..gateway import CallStats, Gateway
from ..settings import Job
from ..store import Profile
from .catalog import Catalog
from .classify import Plan
from .directives import directive_briefs, directive_guides
from .lesson_format import Header, Malformed, ParsedLine, parse_line
from .stopwatch import Stopwatch

FORMAT_RULES = """You write Pennydrop Lessons: short narrated animations that teach one idea.
Your whole reply is JSON lines and nothing else: no prose, no code fences, no comments.

Line 1 is the header: {"lesson": {"title": "short title in sentence case: capitalize only the first word, proper nouns and acronyms", "point": "the one full sentence this Lesson proves: a claim that could be wrong, never a topic, as in \\"Bubble sort is slow because each pass moves only one more value into place\\"", "goal": "one sentence on what the learner can do or see afterwards", "labs": ["ids of the Labs that at least one Step draws, and no others"]}}
Every later line is one Step: {"step": 1, "say": "narration", "scene": {...}, "do": [...]}
"scene" and "do" are optional.
One Step, the hinge, also asks a predict Challenge: {"step": 6, "say": "narration that asks the question", "scene": {...}, "do": [...], "challenge": {"kind": "predict", "type": "choice", "prompt": "...", "choices": ["a", "b"], "answer": "a"}}

Rules
- The Ask may be a speech transcript, so it can hold misheard words. Fix an evident mishearing, such as "Mudex" for "mutex", in the title and in the narration, and never repeat the wrong word.
- The title is in sentence case: only its first word and proper nouns start with a capital, as in "Bubble sort" and "A page table walk".
- Write 6 to 10 Steps that tell a story proving the point. Write the point first and make every Step serve it.
- Step 1 is the promise: one sentence of at most 14 words that asks the question the Lesson answers, in the learner's own world, with at most one or two scene objects so it can start playing at once. The Steps after it carry the detail.
- Order the Steps as a story: the normal case the learner already knows or assumes; the break, where that assumption fails or the problem shows; a chain of Steps where each follows from the last by cause (because of that) and never by "and then", which is the mechanism being taught; the reveal; and a last Step that says the point again in plain words over the proof still on stage, never over an emptied stage. Do not write these labels into the narration.
- Between the promise and the last Step the stage proves the point with something the learner watches happen, such as a trace, a simulation or a picture that changes, and narration alone does not.
- Cut every Step that does not move the point, however true it is. Each Step changes what the learner sees or advances the cause chain: no filler operation that changes nothing, no Step that only talks over an unchanged stage, and no pulsing of two objects while saying "this one... this one".
- "say" is spoken aloud: plain words, about 25 words at most, no markdown, no symbols that are hard to speak.
- Use only the Labs and primitives of the catalog below, with their exact spec fields and operations. An object with "lab" is a Lab, an object with "kind" is a primitive.
- When no Lab fits the Ask, build the explanation from primitives and the generic verbs.
- Never write coordinates, pixel sizes or colors. Place objects with "at" relations and color with roles.
- A Step's "scene" sets or replaces the objects it names, and null removes one. Every other object stays. A Step with no "scene" keeps the Scene as it was.
- Because objects stay, a note or label that names one case, such as "Insert 6", stays true only while the story is on that case: the Step that moves to another case replaces or removes it. A text never states a value the story changes, such as a count, a balance or an index, because the Lab shows that value live and the text goes stale: a title names the subject, as in "A shared counter". The stage only moves forward: never reset an object to an emptier state to build it up again; start it that way in Step 1.
- Keep at most about three objects on stage at once, because a Scene that fits only below 60% size fails. Remove what a Step no longer talks about (null in "scene") before it adds a big panel such as a code trace or a simulation, and never show the same Lab twice, except where a directive's notes say it shows runs side by side.
- An object's "scene" entry creates it, or resets it to the state of that entry when it is already on stage. A Step that continues an object leaves it out of "scene" and only adds "do" entries on it, and a "do" entry never names an object that is not on stage yet.
- Put new objects in "scene". Use the generic verb "create" only for an object that must appear on a spoken Cue, and then always with "spec" holding the full object spec.
- "do" runs after "scene". Each entry's "cue" is a word or phrase copied exactly from that Step's "say", and cues appear in the order they are spoken.
- A Step with a Challenge only asks: its "say", "scene" text and labels never state, show or hint at the answer. The next Step plays the reveal.
- Spoken Cues are copied letter for letter from the same Step's "say". Write "say" first and pick each cue from it.
- A number Challenge's "answer" is a plain number, or the name of a directive value such as "simulate.final" or "trace.swaps" only when a directive of that name computed it.
- A braced placeholder such as {trace.comparisons} in "say" works only in a Step that carries that same directive, or after a Step that already ran it. In every earlier Step write the narration without the number.
- In a sequence diagram, every "send" is followed by one "receive" or "drop" on the same diagram before the next "send".
- A plot, chart or graph of numbers shows the Ask's own quantity, computed from the formula or data the Ask is about, and never a stand-in curve.
- Every Lesson has one hinge: a predict Challenge on the Step just before the reveal, where the learner can add up the earlier Steps and reach the answer, and no earlier Step states it. The hinge Step's narration asks the question without giving the answer, and the next Step reveals it.
- Challenge shapes, all with "kind": "predict":
  {"kind": "predict", "type": "number", "prompt": "...", "answer": 6}
  {"kind": "predict", "type": "choice", "prompt": "...", "choices": ["a", "b"], "answer": "a"}
  {"kind": "predict", "type": "click", "prompt": "...", "answer": "object id or list of ids"}, where an id names a whole object or one part as object[part], such as a node tree[10]; only what is on stage can be tapped, so ask where a new key lands as the node it joins under
  {"kind": "predict", "type": "order", "prompt": "...", "choices": ["a", "b", "c"], "answer": ["b", "a", "c"]}
  {"kind": "predict", "type": "match", "prompt": "...", "pairs": [["left", "right"], ["left", "right"]]}
- Every number that comes from running code or from arithmetic comes from a directive, never from you. A directive is a field of the Step that the server runs before the Step plays.
- A Lab whose operations are steps of one process (address, scheduler, threads, hash, shapes) accepts them only in the order its catalog example shows, and each operation needs what the earlier ones built: copy the example's order, start from its first operation, and write in a Step only the operations its narration says.
- A trace owns its object's counters and the code object's lines and variables: no Step changes them by hand. Repeat the same trace only to play more of its run with a later "until"; once the run has ended, leave the object on stage and let the narration use the trace's own numbers.
- When a directive can play your example on a Lab (trace for the array, code and graph Labs, simulate for the scheduler, threads and address Labs), always use that directive for it, and never write by hand the operations it writes, even though the Lab's catalog entry shows them. A trace or a simulation tells its run in stages: repeat the same directive in each Step of the story, give every Step but the last a later "until", leave "until" out of the Step that plays the end of the run, and let each Step's narration talk only about the part that Step plays.
- Stage a played run along the story: Step 1 carries it with "until": 0, so the stage shows the setup the question is about; each cause Step plays the next part and explains it; the hinge Step stops before the part that settles the Challenge's answer, and the reveal Step plays that part. Only the Steps after the reveal may talk over a run that has already ended.
- When "say" brings in a new example, number, list or object, that same Step's "scene" sets it, so the stage always shows what the narration talks about.
- A Learner who is a kid gets words a young child knows, and a warm, playful voice. The kid rules below say more.
- A Learner level of beginner, intermediate or advanced sets how much you assume.
- When the brief names a Course Topic, teach that Topic's core idea, use the Terms the brief lists as your vocabulary, and obey the honor code in the brief: explain every concept on a toy example of your own, and never read, write or hint at project code or assignment specs.

## Kid rules

These hold when the Learner is a kid, and nothing in a kid Lesson may need reading.
- Every Step is one or two short sentences.
- The story has a character on stage who wants something, such as a ball that wants to roll farthest, so the point has a stake; Step 1 shows what it wants. The Steps follow the same order as above, and the Challenge comes before the Step that reveals who wins.
- Never run the setup the Challenge asks about before the Challenge: the Steps before it show the normal case with a simpler setup, such as one ball, and the Step right after the Challenge runs the asked setup for the first time as the reveal.
- Show with pictures, shapes and physics, and put no text, code or math objects on the stage.
- Keep one Lab object on the stage at a time, so it fills the screen: to show a new setup, change the one on stage with its own ops, such as "set" on a physics setup, or bring the new object in and remove the old one with null in the same Step's "scene".
- Every Challenge is "kind": "predict" with "type": "click", where the child taps an object on the stage.
- The narration asks the question out loud, because the child hears it and does not read it.
- Do not write "reading" in the header.
"""

REPAIR_INSTRUCTIONS = "Repair one Step of a Lesson. Reply with the corrected Step as exactly one JSON line and nothing else. Keep its step number and the meaning of its narration, and change only what the errors name."


@dataclass(frozen=True)
class Brief:
    ask: str
    profile: Profile | None
    plan: Plan
    scene: Any = None
    watching_title: str | None = None
    course: CourseContext | None = None
    photo_search: str | None = None

    def course_lines(self) -> list[str]:
        if not self.course:
            return []
        return [
            f"Course Topic: {self.course.topic_title}, part {self.course.part} of {self.course.course_title}",
            f"Terms: {'; '.join(self.course.terms)}",
            f"Honor code: {self.course.honor_code}",
        ]

    def text(self) -> str:
        lines = [f"Ask: {self.ask}", f"Learner: {self.profile.kind.value}, level {self.profile.level}" if self.profile else "Learner: adult, level beginner", *self.course_lines()]
        lines.append(
            f"Labs that fit this Ask: {', '.join(self.plan.labs)}. Use them where they help, together with primitives."
            if self.plan.labs else "No Lab fits this Ask: build the explanation from primitives."
        )
        lines.extend(directive_briefs(self.plan.labs))
        if self.photo_search:
            lines.append(f"A photo search for \"{self.photo_search}\" is already running: use the images directive with exactly that query for the Ask's main subject. You still choose freely for any other subject.")
        if self.plan.follow_up:
            lines.append(f"This is a follow up to the Lesson '{self.watching_title}'. Step 1 continues from the Scene below, so reuse its objects instead of recreating them. When Step 1 brings in a new example, its \"scene\" replaces the objects that still show the old one, so the stage matches the narration.")
            lines.append(f"Current Scene (JSON): {json.dumps(self.scene)}")
        if self.plan.graded_assignment:
            lines.append("The Ask looks like a graded course assignment. Teach the underlying concept on a toy example of your own, and give no code or answers for the assignment.")
        if not self.plan.fine_for_young_child:
            lines.append("This Ask is not for a young child. Write one Step that kindly says this is a question for a grown up to answer together, and stop.")
        return "\n".join(lines)

WRITER_EFFORT = "low"
WRITER_HEDGE_SECONDS = 2.0
ANSWER_AT_ONCE = "Latency-sensitive; begin your visible answer immediately."


class Writer:
    def __init__(self, gateway: Gateway, catalog: Catalog):
        self._gateway = gateway
        self._catalog = catalog

    async def lines(self, brief: Brief, stopwatch: Stopwatch, lesson_id: str) -> AsyncIterator[ParsedLine]:
        system = await self._system()
        stopwatch.mark("writer_started")
        buffer = ""
        async for item in self._gateway.stream(brief.plan.tier.job, f"{brief.text()}\n{ANSWER_AT_ONCE}", system=system, lesson_id=lesson_id, effort=WRITER_EFFORT, hedge_after=WRITER_HEDGE_SECONDS):
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
            *brief.course_lines(),
            f"Scene before this Step (JSON): {json.dumps(scene)}",
            f"The Step as written: {shown}",
            "It failed with:",
            *(f"- {error}" for error in errors),
            ANSWER_AT_ONCE,
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
        return FORMAT_RULES + "\n\n# Catalog\n\n" + (await self._catalog.current()).markdown + "\n\n# Directives, which replace the hand written operations above\n\n" + directive_guides()
