from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from ..gateway import Answer, Choice, ChoiceAnswer, Gateway, Question, YesNo, YesNoAnswer
from ..pictures import subject_phrases
from ..tracer import ALGORITHMS
from ..store import Profile, ProfileKind
from .catalog import LabEntry
from .directives.trace import TARGETS, outline_lab

LAB_QUESTION_PREFIX = "lab_"
KID_LAB_HINTS = {
    "picture": "Answer yes when a child asks what a real thing looks like, asks to see it, or asks what is inside it or what parts it has: a real photo shows it better than drawn shapes.",
}
LAB_LIMITS = {
    "picture": "Answer yes when the Ask is about what a physical thing looks like or about its parts, such as an animal, a vehicle, a machine, a building, a plant or a body part: a real photo shows it. Answer no for mathematics, code, data, processes and abstract ideas.",
}
CONTRADICTION_QUESTIONS = {
    "contradicted": YesNo(
        "Does any fact contradict the Step? The facts are correct values from running the example."
        " Answer yes when the Step states a number that differs from a fact, or a comparison the facts disprove, including a claim about every job when one job's facts show it fails, since equal values are not lower or sooner."
        " Answer no when every number and comparison the Step states matches the facts, even if the Step also says things the facts do not cover."
        " A number the Step calls about, roughly or nearly matches a fact that rounds to it, such as about 1,700 for 1744.94."
    ),
    "stated_differently": YesNo(
        "Does the Step state a value that a fact gives differently? The facts are correct values from running the example."
        " Answer yes only when the Step names a value a fact also gives, such as a count, an index, an address or a result of one run, and states it differently, or states a comparison that the facts disprove, such as calling a value lower when the facts show it higher or equal, or a claim about every job when one job's facts show it fails."
        " Answer no when every value the Step states matches the fact for the same thing, and for anything the facts do not give, such as how a step works or why."
        " A value the Step calls about, roughly or nearly matches a fact that rounds to it, such as about 1,700 for 1744.94."
    ),
}
ANSWER_ON_STAGE_QUESTIONS = {
    "readable": YesNo("Can the learner read the Challenge's answer straight off the stage as it stands, without predicting anything? Answer no when the answer is a count or a result of steps the stage has not played yet."),
    "shown": YesNo("Does the stage as it stands already show the very value, order, position or comparison that the Challenge's answer gives? Answer no when the stage shows only an earlier state that the answer comes after."),
}
ANSWER_TOLD_QUESTIONS = {
    "told": YesNo("Does the earlier narration state the Challenge's answer outright? Answer no when it only gives causes or facts that the learner must combine to work the answer out."),
    "said": YesNo("Has the earlier narration already said the very thing the answer says, so the learner only has to remember it? Answer no when the learner still has to reason from the narration to reach the answer."),
}
ASKS_THE_CHALLENGE_QUESTIONS = {
    "same": YesNo("Does the narration ask the learner the same question as the Challenge, so that the Challenge's answer answers what the narration asks?"),
    "form": YesNo("Does the narration ask for the same form of answer the Challenge takes, such as a number, one of the listed choices, or a thing to tap on the stage?"),
}
OTHER_MOVES_QUESTIONS = {
    "other": YesNo("Does the narration say that a value moves in this Step when the stage does not move that value, or say nothing moves when the stage moves values?"),
    "contradicts": YesNo("Does the narration state a move, a swap or a resting place that contradicts the moves listed for the stage? Leaving moves out is not a contradiction."),
}
OTHER_MOVES_CONFIDENCE = 0.7
OTHER_LOOKS_QUESTIONS = {
    "elsewhere": YesNo("Does the narration say this Step checks or looks at a value that no pointer points at in this Step?"),
    "stale": YesNo("Does the narration tell a check whose value differs from every value the pointers point at in this Step, as if the narration were one Step behind the stage?"),
}
OTHER_EVENTS_QUESTIONS = {
    "other": YesNo("Does the narration say that something happens now, in this Step, that is not among the events the stage plays in this Step? Background about what earlier Steps showed, and anything the narration only asks about or says will come later, does not count."),
    "contradicts": YesNo("Does the narration state an event whose parties, values or order differ from the events the stage plays in this Step? Leaving events out is not a contradiction."),
}
FIGURE_NUMBERS_QUESTIONS = {
    "number": YesNo("Does the narration say the hopper stands on, hops to or lands on a number that is not where the stage puts it in this Step, or say the pile holds a number of blocks it does not hold? Numbers the narration only asks about, or says will come later, do not count."),
    "count": YesNo("Does the narration count out or name more or fewer hops, or more or fewer blocks, than the stage plays in this Step? A sum the narration only restates, such as two plus five is seven, does not count."),
}
OPTION_PREFIX = "option_"
NONE_NAMED = "none"
NAMED_CONFIDENCE = 0.6
FOLLOW_UP = "follow_up"
NEW_TOPIC = "new_topic"
PICTURE_LAB = "picture"
NO_SUBJECT = "none"
NO_ALGORITHM = "none"


@dataclass(frozen=True)
class Viewing:
    title: str
    goal: str
    current_say: str


@dataclass(frozen=True)
class Plan:
    follow_up: bool
    labs: tuple[str, ...]
    fine_for_young_child: bool
    graded_assignment: bool
    photo_subject: str | None
    algorithm: str | None = None
    shows_code: bool = False
    charts_quantities: bool = False


class Classifier:
    def __init__(self, gateway: Gateway):
        self._gateway = gateway

    async def plan(self, ask: str, profile: Profile | None, labs: tuple[LabEntry, ...], viewing: Viewing | None, lesson_id: str) -> Plan:
        questions: dict[str, Question] = {
            "graded_assignment": YesNo("Does the person want code or answers for a graded course assignment, rather than to understand a concept?"),
        }
        is_kid = profile is not None and profile.kind is ProfileKind.KID
        labs = tuple(lab for lab in labs if lab.wordless or not is_kid)
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
        if any(lab.id in TARGETS for lab in labs):
            questions["algorithm"] = Choice(
                "Which one of these algorithms does the Ask ask about, how it works or why it behaves as it does? Answer none when the Ask is about anything else, such as a data structure, an operating system idea or a network.",
                {name: algorithm.summary for name, algorithm in ALGORITHMS.items() if not is_kid or algorithm.kid} | {NO_ALGORITHM: "none of these algorithms"},
            )
        if not is_kid and any(lab.id in TARGETS for lab in labs):
            questions["shows_code"] = YesNo("Does the person ask to see the program's code itself, such as its source lines or how it runs line by line, rather than only what it does to its data?")
        if any(lab.id == "plot" for lab in labs):
            questions["plots_a_function"] = YesNo("Is the Ask about the shape, slope or area of one basic function such as ax, ax² or sin x, rather than about how the Ask's own quantities change, such as money over years or the steps two algorithms take as the input grows?")
        if is_kid:
            questions["young_child_ok"] = YesNo("Is this question fine for a young child to learn about: free of frightening, violent, sexual or other adult content? A subject that is only hard, such as code, sorting, math or how machines work, is fine.")
        result = await self._gateway.classify(_state(ask, profile, viewing), questions, lesson_id=lesson_id)
        answers = result.answers
        relation = answers.get("relation")
        subject = answers.get("photo_subject")
        chosen = answers.get("algorithm")
        fitting_labs = tuple(lab.id for lab in labs if _yes(answers[LAB_QUESTION_PREFIX + lab.id]))
        algorithm = chosen.choice if isinstance(chosen, ChoiceAnswer) and chosen.choice in ALGORITHMS and outline_lab(chosen.choice) in fitting_labs else None
        return Plan(
            follow_up=isinstance(relation, ChoiceAnswer) and relation.choice == FOLLOW_UP,
            labs=fitting_labs,
            fine_for_young_child=_yes(answers["young_child_ok"]) if is_kid else True,
            graded_assignment=_yes(answers["graded_assignment"]),
            photo_subject=subject.choice if isinstance(subject, ChoiceAnswer) and subject.choice in phrases else None,
            algorithm=algorithm,
            shows_code=algorithm is not None and "code" in fitting_labs and _yes(answers["shows_code"]),
            charts_quantities="plot" in fitting_labs and not _yes(answers["plots_a_function"]),
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

    async def answers_unasked(self, say: str, asked: str, lesson_id: str) -> bool:
        question = YesNo(f'The learner was never asked this question: "{asked}". Does the narration speak as if the learner had just answered it, such as by opening with the answer on its own, like "It is the ears!" or "Four hops!", or by saying they got it right? Answer no when the narration only tells facts as part of the story, even facts that answer the question.')
        result = await self._gateway.classify(say, {"answers": question}, lesson_id=lesson_id)
        return _yes(result.answers["answers"])

    async def restates_point(self, say: str, point: str, lesson_id: str) -> bool:
        question = YesNo("Does the narration state the point?")
        result = await self._gateway.classify(f"Point: {point}\nNarration: {say}", {"restates": question}, lesson_id=lesson_id)
        return _yes(result.answers["restates"])

    async def tells_other_moves(self, played: str, say: str, lesson_id: str) -> bool:
        result = await self._gateway.classify(f"Stage in this Step: {played}.\nNarration: {say}", OTHER_MOVES_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in OTHER_MOVES_QUESTIONS) >= OTHER_MOVES_CONFIDENCE

    async def tells_other_looks(self, played: str, say: str, lesson_id: str) -> bool:
        result = await self._gateway.classify(f"Stage in this Step: {played}.\nNarration: {say}", OTHER_LOOKS_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in OTHER_LOOKS_QUESTIONS) >= OTHER_MOVES_CONFIDENCE

    async def tells_other_events(self, played: str, say: str, lesson_id: str) -> bool:
        result = await self._gateway.classify(f"Stage in this Step: {played}.\nNarration: {say}", OTHER_EVENTS_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in OTHER_EVENTS_QUESTIONS) >= OTHER_MOVES_CONFIDENCE

    async def card_named(self, say: str, meanings: tuple[str, ...], lesson_id: str) -> int | None:
        return await self._one_named(
            "The stage shows a word and meaning cards. Which one card does the narration say is the word's meaning, or is not its meaning, in this Step?",
            f"Cards: {'; '.join(meanings)}.\nNarration: {say}",
            tuple(f'the card "{meaning}"' for meaning in meanings),
            lesson_id,
        )

    async def card_mark_denied(self, say: str, meaning: str, right: bool, lesson_id: str) -> bool:
        mark, opposite = ("a check mark", "is not what the word means, or that this match is wrong") if right else ("a cross", "is what the word means, or that this match is right or checks out")
        question = YesNo(f'The stage puts {mark} on the card "{meaning}" in this Step. Read only the narration: does it say the opposite of that mark, that "{meaning}" {opposite}?')
        result = await self._gateway.classify(say, {"denied": question}, lesson_id=lesson_id)
        return _yes(result.answers["denied"])

    async def stress_off_stage(self, say: str, syllables: tuple[str, ...], marked: int, lesson_id: str) -> bool:
        word, mark, listed = "-".join(syllables), syllables[marked], ", ".join(f'"{syllable}"' for syllable in dict.fromkeys(syllables))
        questions = {
            "elsewhere": YesNo(f'The word on stage is "{word}", and the syllable marked as stressed is "{mark}", number {marked + 1} of {len(syllables)}. Does the narration name by its sound or count by its place a stressed, loud or listened-for syllable that is not "{mark}" or not number {marked + 1}?'),
            "unlisted": YesNo(f'The word on stage is "{word}", whose syllables are {listed}. Does the narration name, by its sound, a syllable to listen for or stress that is none of {listed}?'),
        }
        result = await self._gateway.classify(say, questions, lesson_id=lesson_id)
        return any(_yes(result.answers[name]) for name in questions)

    async def answer_confirmed(self, say: str, asked: str, answers: tuple[str, ...], lesson_id: str) -> int | None:
        return await self._one_named(
            f'The learner was just asked: "{asked}". Read only the narration, not what you know: which one answer does the narration itself name as the answer to that question? When the narration names none of them as the answer, choose none.',
            f"Answers: {'; '.join(answers)}.\nNarration: {say}",
            tuple(f'"{answer}"' for answer in answers),
            lesson_id,
        )

    async def _one_named(self, instructions: str, text: str, options: tuple[str, ...], lesson_id: str) -> int | None:
        question = Choice(instructions, {f"{OPTION_PREFIX}{index}": option for index, option in enumerate(options)} | {NONE_NAMED: "the narration names no one of them as the answer"})
        result = await self._gateway.classify(text, {"named": question}, lesson_id=lesson_id)
        answer = result.answers["named"]
        named = answer.choice.removeprefix(OPTION_PREFIX) if isinstance(answer, ChoiceAnswer) and answer.confidence >= NAMED_CONFIDENCE else NONE_NAMED
        return int(named) if named.isdigit() else None

    async def misnumbers_figures(self, played: str, say: str, lesson_id: str) -> bool:
        result = await self._gateway.classify(f"Stage in this Step: {played}.\nNarration: {say}", FIGURE_NUMBERS_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in FIGURE_NUMBERS_QUESTIONS) >= 0.5

    async def answer_on_stage(self, shown: str, challenge: str, lesson_id: str) -> bool:
        result = await self._gateway.classify(f"Stage now: {shown}.\nChallenge: {challenge}", ANSWER_ON_STAGE_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in ANSWER_ON_STAGE_QUESTIONS) >= 0.5

    async def answer_told(self, told: str, challenge: str, lesson_id: str) -> bool:
        result = await self._gateway.classify(f"Earlier narration: {told}\nChallenge: {challenge}", ANSWER_TOLD_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in ANSWER_TOLD_QUESTIONS) >= 0.5

    async def asks_the_challenge(self, say: str, challenge: str, lesson_id: str) -> bool:
        result = await self._gateway.classify(f"Narration: {say}\nChallenge: {challenge}", ASKS_THE_CHALLENGE_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in ASKS_THE_CHALLENGE_QUESTIONS) >= 0.5

    async def claims_agree(self, claimed: str, facts: list[str], lesson_id: str) -> bool:
        text = "\n".join([*(f"Fact: {fact}" for fact in facts), f"Step: {claimed}"])
        result = await self._gateway.classify(text, CONTRADICTION_QUESTIONS, lesson_id=lesson_id)
        return _mean_yes(result.answers[name] for name in CONTRADICTION_QUESTIONS) < 0.5


def _yes(answer) -> bool:
    assert isinstance(answer, YesNoAnswer)
    return answer.yes


def _mean_yes(answers: Iterable[Answer]) -> float:
    probabilities = [answer.probability_yes for answer in answers if isinstance(answer, YesNoAnswer)]
    return sum(probabilities) / len(probabilities)


def _state(ask: str, profile: Profile | None, viewing: Viewing | None) -> str:
    lines = [f"Ask: {ask}"]
    if profile:
        lines.append(f"Learner: {profile.kind.value}, level {profile.level}")
    if viewing:
        lines.append(f"Watching the Lesson '{viewing.title}' (goal: {viewing.goal}), now at: {viewing.current_say}")
    return "\n".join(lines)
