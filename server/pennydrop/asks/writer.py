from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from ..courses import CourseContext
from ..gateway import CallStats, Gateway
from ..pictures import Picture
from ..settings import Job
from ..practice import Direction, Form, Rule
from ..store import Profile
from .catalog import Catalog
from .classify import Plan
from .directives import directive_briefs, directive_guides
from .lesson_format import Header, Malformed, ParsedLine, is_practice_line, parse_line
from .stopwatch import Stopwatch

FORMAT_RULES = """You write Pennydrop Lessons: short narrated animations that teach one idea.
Your whole reply is JSON lines and nothing else: no prose, no code fences, no comments.
Begin the header line at once, without reasoning first: the directives compute every value, so the Steps need no working out ahead.

Line 1 is the header: {"lesson": {"title": "short title in sentence case: capitalize only the first word, proper nouns and acronyms", "point": "the one full sentence this Lesson proves: a claim that could be wrong, never a topic, as in \\"Bubble sort is slow because each pass moves only one more value into place\\", and that names the direction of a comparison by its measure, such as \\"takes fewer steps\\" or \\"grows more slowly\\", never by a word such as ahead, behind or beats, which reads both ways", "goal": "one sentence on what the learner can do or see afterwards", "labs": ["ids of the Labs that at least one Step draws, and no others"]}}
Every later line is one Step: {"step": 1, "say": "narration", "scene": {...}, "do": [...]}
"scene" and "do" are optional.
After the last Step, one more line is the practice line, described under Practice below.
One Step, the hinge, also asks a predict Challenge: {"step": 6, "say": "narration that asks the question", "scene": {...}, "do": [...], "challenge": {"kind": "predict", "type": "choice", "prompt": "...", "choices": ["a", "b"], "answer": "a"}}

Rules
- The Ask may be a speech transcript, so it can hold misheard words. Fix an evident mishearing, such as "Mudex" for "mutex", in the title and in the narration, and never repeat the wrong word.
- The title is in sentence case: only its first word and proper nouns start with a capital, as in "Bubble sort" and "A page table walk".
- Write 6 to 10 Steps that tell a story proving the point. Write the point first and make every Step serve it.
- Step 1 is the promise: one question sentence of at most 14 words, such as "Why does sorting a thousand names take so long?", that asks what the Lesson answers, in the learner's own world, with at most one or two scene objects so it can start playing at once. Put the concrete example the learner can picture inside that one sentence, as the thousand names are, and never open with a setup sentence or ask a bare abstract question. The Steps after it carry the detail.
- Order the Steps as a story: the normal case the learner already knows or assumes; the break, where that assumption fails or the problem shows; a chain of Steps where each follows from the last by cause (because of that) and never by "and then", which is the mechanism being taught; the reveal; and a last Step that says the point again in plain words over the proof still on stage, never over an emptied stage. Keep the proof on stage from the Step that builds it: an object you will need in the last Step is never removed to be brought back, because a Step that declares an object again sets it to exactly the spec it names, undoing everything played on it, so continue it with "do" instead. Declare an object in the Step that brings it in with room for everything later Steps play on it, such as a roll's low and high or the length of a list, so no later Step has to declare it again to make room. The last Step also points at that proof with an operation, such as a highlight on the counter or the result that shows the point, while its narration says the point; that operation marks what the story already built, and never adds a message, value or event the story did not have. When the brief offers a contrast run, play it as the brief says: it is the normal case or the break of the story. Do not write these labels into the narration.
- Between the promise and the last Step the stage proves the point with something the learner watches happen, such as a trace, a simulation or a picture that changes, and narration alone does not.
- Cut every Step that does not move the point, however true it is. Each Step changes what the learner sees or advances the cause chain: no filler operation that changes nothing, no Step that only talks over an unchanged stage, and no pulsing of two objects while saying "this one... this one".
- "say" is spoken aloud: plain words, about 25 words at most, no markdown, no symbols that are hard to speak.
- Use only the Labs and primitives of the catalog below, with their exact spec fields and operations. An object with "lab" is a Lab, an object with "kind" is a primitive.
- When no Lab fits the Ask, build the explanation from primitives and the generic verbs.
- Never write coordinates, pixel sizes or colors. Place objects with "at" relations and color with roles.
- A Step's "scene" sets or replaces the objects it names, and null removes one. Every other object stays. A Step with no "scene" keeps the Scene as it was.
- Because objects stay, a note or label that names one case, such as "Insert 6", stays true only while the story is on that case: the Step that moves to another case replaces or removes it. A text never states a value the story changes, such as a count, a balance or an index, because the Lab shows that value live and the text goes stale: a title names the subject, as in "A shared counter". The stage only moves forward: never reset an object to an emptier state to build it up again; start it that way in Step 1.
- Keep at most about three objects on stage at once, because a Scene that fits only below 60% size fails. Remove what a Step no longer talks about (null in "scene") before it adds a big panel such as a code trace or a simulation, and never show the same Lab twice, except where a directive's notes say it shows runs side by side, as a contrast run does on its own second object.
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

## Practice

The practice line comes after the last Step. It checks that the learner can use the Lesson's Rule alone: {"practice": {"rule": "Binary search halves the range at every look", "condition": "the list is sorted", "slots": ["the list", "the target"], "challenges": [item, item, item]}}
- The Rule is the reusable statement under the point, one sentence that holds beyond this example and states the claim without its reason, never with a "because", since the say item asks the learner for the reason, and "condition" is what it holds under. The condition is a property of the input or setup that a case can lack, such as "the list is sorted", "the entry is valid" or "the triangle has a square corner", never a description of how the algorithm works, such as "each value is inserted into the sorted part", because no case can break a mechanism. When the Lesson teaches a mechanism, state the Rule about what that mechanism buys and when, such as "insertion sort makes few comparisons when the list is nearly sorted" (condition: the list is nearly sorted), so a near miss exists. "slots" lists the details a fresh case changes, such as the list and the target.
- "challenges" holds three items in this order: say, applies, fresh. An item is a Step without "step", plus "form" and, for fresh only, "direction". It continues the story after the last Step, so its "scene" changes only what it names, and sets null on the Lesson objects it does not use.
- say: {"form": "say", "say": "Tell me why binary search needs so few looks, with a because.", "challenge": {"kind": "explain", "type": "words"}}. It asks for the Rule in the learner's own words with a "because", never gives the reason, and has no scene, so the proof stays on stage.
- applies: a near miss, one condition away from the worked example, that lacks the Rule's condition on the same algorithm or setup the Lesson taught, never a different algorithm, such as the same search on a list that is not sorted. It is a case no Step ran: keep the worked example's setup and change only the detail the condition is about. It asks whether the Rule still works there: {"kind": "predict", "type": "yesno", "answer": "no"}. It shows the case on the stage with a scene (a kid's too) or a directive, and a directive runs it wherever a Lab can, so the Rule's failure is computed. Keep every number inside what the Lesson's own runs used.
- fresh: {"form": "fresh", "direction": "forward", ...} changes exactly one slot from the worked example and keeps the others, with an input no Step used, and asks what the Rule predicts there in a predict Challenge of any type the Labs allow, so a learner who understood the Rule can work the answer out. A number answer names a directive value such as "trace.comparisons". The Lesson may have played several runs, so when the Lesson's runs are named by their "on" objects, put the item's run on its own new object with "on", and write that object's name in every value, such as "{trace.fresh.swaps}", never "{trace.swaps}". A forward item stops its directive with an "until" before the value it asks (on a plot, it graphs the asked line part way with "to"), so the narration never writes that value and only the Challenge's answer names it. A forward item that holds its run back also carries "reveal": one sentence the stage says while it plays the rest of the run after the learner answers, which states the answer and the because the Rule gives, such as "Insertion sort made {trace.fresh.comparisons} comparisons, because each card moved left only past the cards bigger than it."; it carries no directive or "do", since the server plays the run. A click names an object on the stage that a tap can answer, such as one of several arrays or an array's bar.
- Compute, never narrate: every number and answer comes from a directive, and the narration asks without giving the answer.

## Kid rules

These hold when the Learner is a kid, and nothing in a kid Lesson may need reading.
- Every Step is one or two short sentences.
- The story has a character on stage who wants something, such as a ball that wants to roll farthest, so the point has a stake; Step 1 shows what it wants. The Steps follow the same order as above, and the Challenge comes before the Step that reveals who wins.
- Never run the setup the Challenge asks about before the Challenge: the Steps before it show the normal case with a simpler setup, such as one ball, and the Step right after the Challenge runs the asked setup for the first time as the reveal.
- Tell a sum or a take away on a number line, with the numbers the child asked about, and make the point tell it as hops, in the form "A and B more make C, because B hops from A land on C." Write its Steps in this order: Step 1 brings in the line with the hopper on the first number, plays nothing, has no Challenge, and its narration asks the sum as a question; Step 2 hops one, such as three and one more make four; Step 3 hops one back to the first number; Step 4 is the click Challenge, asking the child to tap the spot where the asked hops will land; Step 5 plays the asked hops for the first time and says where the hopper lands; and the last Step says the point. Before the Challenge the hopper never goes more than one spot from the first number. A pile of blocks may show the same sum only after that reveal, with "add" or "take" and a "count".
- Show with pictures, shapes and physics, and put no text, code or math objects on the stage. Give a shape the real color of the thing it stands for, such as "fill": "blue" for the sky, "yellow" for the sun or "green" for grass, and draw a color the narration names in that color. A sort or a search shows as an array traced with a library algorithm, which a child sees as bars as tall as their values trading places, never as code.
- Keep one Lab object on the stage at a time, so it fills the screen: to show a new setup, change the one on stage with its own ops, such as "set" on a physics setup, or bring the new object in and remove the old one with null in the same Step's "scene".
- Every Challenge is "kind": "predict" with "type": "click", where the child taps an object on the stage.
- The narration asks the question out loud, because the child hears it and does not read it.
- Do not write "reading" in the header.
- The practice items need no reading either: say is spoken as "Tell me why" with the words Challenge, applies as "Will it still roll if...?" or "What happens when...?" with the yesno Challenge, which the child answers with a tick or a cross, and fresh is a click or yesno Challenge on a stage with no text.
"""

REPAIR_INSTRUCTIONS = "Repair one Step of a Lesson. Reply with the corrected Step as exactly one JSON line and nothing else, and begin that line at once, without reasoning first: each error names its own fix. Keep its step number and the meaning of its narration, and change only what the errors name."


@dataclass(frozen=True)
class MainPhoto:
    query: str
    found: Picture | None = None
    missing: bool = False

    def line(self) -> str:
        if self.missing:
            return f'No free photo of "{self.query}" could be found, so leave out "images" and "locate" for it, and draw it with shapes, or a figure from another Lab, in every Step that talks about it.'
        if self.found is None:
            return f'A photo search for "{self.query}" is already running: use the images directive with exactly that query for the Ask\'s main subject. You still choose freely for any other subject.'
        found = f'The photo of "{self.query}" is found: use the images directive with exactly that query for the Ask\'s main subject. You still choose freely for any other subject.'
        if not self.found.parts:
            return found
        return f'{found} The parts a child can see and tap on this photo are: {", ".join(self.found.parts)}. Put only parts from this list in "locate", and build the whole story on them, its promise, hinge and point included: promise only what these parts can answer, and never speak of a part this photo does not show.'


@dataclass(frozen=True)
class Brief:
    ask: str
    profile: Profile | None
    plan: Plan
    scene: Any = None
    watching_title: str | None = None
    course: CourseContext | None = None
    photo: MainPhoto | None = None
    outline: str | None = None
    link: tuple[Rule, Rule] | None = None

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
        if self.outline:
            lines.append(self.outline)
        if self.link:
            first, second = self.link
            lines.append(f'This Lesson links two Rules the learner holds: "{first.statement}" (it holds when {first.condition}) and "{second.statement}" (it holds when {second.condition}). Teach how one joins the other with "because" or "but", and let the point and the Rule say that join.')
        if self.photo:
            lines.append(self.photo.line())
        if self.plan.follow_up:
            lines.append(f"This is a follow up to the Lesson '{self.watching_title}'. Step 1 continues from the Scene below, so reuse its objects instead of recreating them. When Step 1 brings in a new example, its \"scene\" replaces the objects that still show the old one, so the stage matches the narration.")
            lines.append(f"Current Scene (JSON): {json.dumps(self.scene)}")
        if self.plan.graded_assignment:
            lines.append("The Ask looks like a graded course assignment. Teach the underlying concept on a toy example of your own, and give no code or answers for the assignment.")
        if not self.plan.fine_for_young_child:
            lines.append("This Ask is not for a young child. Write one Step that kindly says this is a question for a grown up to answer together, with one gentle figure on stage, such as two friendly shapes side by side, and stop.")
        return "\n".join(lines)

PRACTICE_INSTRUCTIONS = "Write the practice line of a Lesson. Reply with exactly one JSON line, the practice line, and nothing else, and begin it at once, without reasoning first: the Lesson below is told, and the stage after its last Step holds what its Steps built. When errors are listed, each names its own fix; change only what they name."
CASE_INSTRUCTIONS = "Write one new Practice item for a Rule, to play after the Lesson below. Reply with exactly one JSON line, the item, and nothing else, and begin it at once, without reasoning first. The stage starts empty, so the item's scene declares every object it uses, a say item's too: its scene shows the Rule's proof, with no do and no directive, and the words Challenge asks for the Rule's why."
BACK_CASE = 'Running back: the item shows a finished result and asks which input made it, as a "choice" of at least three candidate inputs (a kid gets a "click" on one of three arrays on stage instead, which needs a trace). Its narration says the result and never the input. Where the Rule runs a code trace, the item carries a "trace" with no "until", and the choices are inputs written as JSON, such as "[4, 9, 2]". Where a "math" directive computes the result, the item carries it with no "until", and "inputs" maps each choice, letter for letter, to the full "math" spec that candidate gives, such as {"5 and 12": {"expr": "sqrt(5**2 + 12**2)"}}. Where a "simulate" directive computes it, the same with the full simulate spec of each candidate. Exactly one candidate gives the shown result; leave "answer" out, because the server computes it. When no directive can run this Rule backwards from an input, reply {"back": false} and nothing else.'
WRITER_EFFORT = "low"
WRITER_HEDGE_SECONDS = 1.5
ANSWER_AT_ONCE = "Latency-sensitive; begin your visible answer immediately."
MAX_CONTINUATIONS = 2
FEWEST_STORY_STEPS = 5
STORY_CUT_SHORT = "the writer started the Lesson over part way, so tell the rest of this story: whatever of its cause chain, hinge and reveal is still to come, and a last Step that says the point again"


def _missing_from_story(brief: Brief, steps: list[dict[str, Any] | Malformed], cut_short: bool) -> str | None:
    if not brief.plan.fine_for_young_child:
        return None
    asked = [number for number, step in enumerate(steps, 1) if isinstance(step, dict) and "challenge" in step]
    if asked and asked[-1] == len(steps):
        return f"Step {len(steps)} asked the hinge's predict Challenge, so write the reveal that answers it and a last Step that says the point again"
    if len(steps) >= FEWEST_STORY_STEPS:
        return STORY_CUT_SHORT if cut_short else None
    told = f"{len(steps)} Step{'s' if len(steps) > 1 else ''}"
    if asked:
        return f"the story is only {told} long, so carry its cause chain on to the reveal and a last Step that says the point again"
    return f"the story is only {told} long and has not asked the hinge's predict Challenge, so write the rest of its cause chain, the hinge that asks the Challenge, the reveal and a last Step that says the point again"


def _continuation(brief: Brief, steps: list[dict[str, Any] | Malformed], missing: str) -> str:
    return "\n".join([
        brief.text(),
        f"You began this Lesson and stopped after Step {len(steps)}, before its story was told. These are the Step lines you wrote, and the stage now holds what they built:",
        *(step.text if isinstance(step, Malformed) else json.dumps(step) for step in steps),
        f"Continue the same Lesson from Step {len(steps) + 1}: {missing}.",
        "Reply with only the new Step lines, numbered on from there and ending with the practice line: no header and no Step already written.",
        ANSWER_AT_ONCE,
    ])


def lesson_text(header: dict[str, Any], steps: list[dict[str, Any]]) -> str:
    told = [f"Step {number}: {json.dumps({name: value for name, value in step.items() if name not in ('step', 'do', 'voice')})}" for number, step in enumerate(steps, 1)]
    return "\n".join([f"The Lesson is titled \"{header.get('title', '')}\" and proves: {header.get('point', '')}", f"Labs it draws: {', '.join(header.get('labs') or []) or 'none'}", *told])


class Writer:
    def __init__(self, gateway: Gateway, catalog: Catalog):
        self._gateway = gateway
        self._catalog = catalog

    async def lines(self, brief: Brief, stopwatch: Stopwatch, lesson_id: str) -> AsyncIterator[ParsedLine]:
        system = await self._system()
        stopwatch.mark("writer_started")
        steps: list[dict[str, Any] | Malformed] = []
        cut_short = False
        async with aclosing(self._streamed(brief, f"{brief.text()}\n{ANSWER_AT_ONCE}", system, lesson_id, stopwatch)) as first:
            async for parsed in first:
                if isinstance(parsed, Header) and steps:
                    cut_short = True
                    break
                if not isinstance(parsed, Header) and not is_practice_line(parsed):
                    steps.append(parsed)
                yield parsed
        for _ in range(MAX_CONTINUATIONS):
            missing = _missing_from_story(brief, steps, cut_short)
            cut_short = False
            if not steps or missing is None:
                return
            async for parsed in self._streamed(brief, _continuation(brief, steps, missing), system, lesson_id, stopwatch):
                if isinstance(parsed, Header) or (isinstance(parsed, dict) and isinstance(parsed.get("step"), int) and parsed["step"] <= len(steps)):
                    continue
                if not is_practice_line(parsed):
                    steps.append(parsed)
                yield parsed

    async def _streamed(self, brief: Brief, prompt: str, system: str, lesson_id: str, stopwatch: Stopwatch) -> AsyncIterator[ParsedLine]:
        buffer = ""
        async with aclosing(self._gateway.stream(Job.WRITER, prompt, system=system, lesson_id=lesson_id, effort=WRITER_EFFORT, hedge_after=WRITER_HEDGE_SECONDS)) as items:
            async for item in items:
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
            *([brief.outline] if brief.outline else []),
            f"Scene before this Step (JSON): {json.dumps(scene)}",
            f"The Step as written: {shown}",
            "It failed with:",
            *(f"- {error}" for error in errors),
            ANSWER_AT_ONCE,
        ])
        return await self._one_line(prompt, lesson_id, "Step")

    async def practice_line(self, brief: Brief, lesson: str, lesson_id: str, previous: ParsedLine | None = None, errors: list[str] | None = None) -> ParsedLine:
        shown = [] if previous is None else [f"The practice line as written: {previous.text if isinstance(previous, Malformed) else json.dumps(previous)}", "It failed with:", *(f"- {error}" for error in errors or [])]
        prompt = "\n".join([
            PRACTICE_INSTRUCTIONS,
            *brief.text().split("\n")[:2],
            *brief.course_lines(),
            lesson,
            *shown,
            ANSWER_AT_ONCE,
        ])
        parsed = await self._one_line(prompt, lesson_id, "practice line")
        return parsed if isinstance(parsed, Malformed) or is_practice_line(parsed) else Malformed(json.dumps(parsed), "the reply was not a practice line")

    async def case(self, rule: Rule, form: Form, direction: Direction | None, lesson: str, seen: list[dict[str, Any]], profile: Profile | None, errors: list[str], lesson_id: str) -> ParsedLine:
        prompt = "\n".join([
            CASE_INSTRUCTIONS,
            f"Learner: {profile.kind.value}, level {profile.level}" if profile else "Learner: adult, level beginner",
            f'Rule: "{rule.statement}", holding when {rule.condition}; its slots are {", ".join(rule.slots)}.',
            lesson,
            f"Write the {form.value} item" + (f", running {direction.value}." if direction else "."),
            *([BACK_CASE] if direction is Direction.BACK else []),
            "Cases the learner has already had, which the new one must differ from:",
            *(f"- {json.dumps({name: value for name, value in item.items() if name in ('form', 'say', 'scene', 'direction')})}" for item in seen),
            *(["The item as last written failed with:", *(f"- {error}" for error in errors)] if errors else []),
            ANSWER_AT_ONCE,
        ])
        parsed = await self._one_line(prompt, lesson_id, "item")
        return parsed if isinstance(parsed, Malformed) or "form" in parsed or parsed.get("back") is False else Malformed(json.dumps(parsed), 'the reply was not an item with a "form"')

    async def _one_line(self, prompt: str, lesson_id: str, wanted: str) -> ParsedLine:
        completion = await self._gateway.complete(Job.WRITER, prompt, system=await self._system(), lesson_id=lesson_id, effort=WRITER_EFFORT, hedge_after=WRITER_HEDGE_SECONDS)
        for line in completion.text.splitlines():
            parsed = parse_line(line)
            if isinstance(parsed, Header):
                return Malformed(line, f"the reply was a lesson header, and a single {wanted} is needed")
            if parsed:
                return parsed
        return Malformed(completion.text, f"the reply held no {wanted} line")

    async def _system(self) -> str:
        return FORMAT_RULES + "\n\n# Catalog\n\n" + (await self._catalog.current()).markdown + "\n\n# Directives, which replace the hand written operations above\n\n" + directive_guides()
