from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .store import Level, Profile, ProfileKind

DEFAULT_LEVEL = ProfileKind.ADULT.default_level


@dataclass(frozen=True)
class Definition:
    level: Level
    learner: str
    assumes: str
    words: str
    world: str
    point: str
    mechanism: str
    practice: str

    def text(self) -> str:
        return "\n".join([
            f"Level {self.level}: {self.learner}",
            f"- Assumes: {self.assumes}",
            f"- Words: {self.words}",
            f"- World: {self.world}",
            f"- Point: {self.point}",
            f"- Mechanism: {self.mechanism}",
            f"- Practice: {self.practice}",
        ])


DEFINITIONS = {definition.level: definition for definition in (
    Definition(
        level=Level.YOUNG_CHILD,
        learner="A child who cannot read yet, who hears the Lesson and taps the screen.",
        assumes="only the child's own world: toys, food, animals, the body, home, play and weather. No idea from school.",
        words="words a young child uses every day, in a warm, playful voice. No technical term at all, not even once with its meaning, apart from the words of the child's own Ask, such as plus or hexagon when the child asked about them.",
        world="the promise and the normal case are something the child has done or seen, such as rolling a ball or stacking blocks. A character wants something and is on stage from Step 1, and it can be the very thing the Lesson is about, such as a ball that wants to win the race.",
        point="one cause and its effect, said as what happens to the character and what it wants, in words the child could say back.",
        mechanism="one cause and one effect, shown happening on stage and never named or written down. A number is only something to count or a hop on a line.",
        practice='the Rule is one short sentence in words the child could say back, such as "A steeper ramp makes the ball roll faster." Every item is asked out loud and answered with a tap, a tick or a cross, or the child\'s own spoken because.',
    ),
    Definition(
        level=Level.BEGINNER,
        learner="An adult new to the subject: curious and quick, but knowing none of its terms.",
        assumes="everyday knowledge and school arithmetic, and nothing of the field.",
        words='everyday words. A beginner who asks about a compiler knows its name and not what it is, so every field term is explained, the Ask\'s own terms included. Bring in only the few the point needs, each when the story first needs it, say what it means in everyday words that first time, as in "a page table, the list that says where each page of a program sits in memory", and use it the same way after.',
        world="the promise and the normal case come from daily life, such as looking up a word in a dictionary, and the worked example is a small case built from familiar things.",
        point="the mechanism in everyday words, with no term the Lesson has not explained.",
        mechanism="the whole cause chain, one link per Step, with no link skipped. No formula or notation beyond everyday arithmetic, and code only when the Ask is about code, short and walked line by line, so the narration says what each line the stage highlights does. A number on stage is one the learner can check by eye.",
        practice="the Rule's condition is said in everyday words. The near miss breaks that condition in a way a newcomer can see on stage, and the fresh case changes its slot to a value as plain as the worked one.",
    ),
    Definition(
        level=Level.INTERMEDIATE,
        learner="A learner who has taken an intro course in the subject: they know its basic terms and its textbook example, but not its finer points.",
        assumes="the subject's basic terms and its standard example.",
        words='the basic terms used without saying what they mean. A term beyond them is defined once, by tying it to one the learner knows, as in "the TLB, a small cache of page table entries".',
        world="the normal case is the textbook account the learner already holds, and the worked example is a typical case from the field.",
        point="the one link the textbook account skips or glosses over, said in the field's terms.",
        mechanism="move quickly over the links the learner knows, a Step or two for all of them, and slow down on the one new link the point turns on. Use the field's notation and small quantities where they carry the point.",
        practice="the Rule names its condition in the field's terms. The near miss is a case the learner could mistake for one where the Rule holds, and the fresh case changes its slot to a value the learner can only answer by using the Rule.",
    ),
    Definition(
        level=Level.ADVANCED,
        learner="A learner who knows the field's standard model well, such as a graduate student or an engineer who works in it.",
        assumes="the standard model and all of its terms. No Step teaches what the standard model already says, because explaining what an expert knows costs them attention and teaches nothing.",
        words="the field's terms used freely and precisely, with no definitions.",
        world="the promise asks about something this learner meets in their own work, the normal case is the standard model working as they expect, and the break is where it bends: an edge case, a limit, a cost that only shows at scale, or a trade-off between designs.",
        point="where the standard model bends, never what it already says: a Lesson on how a CPU cache speeds up reads proves something about what happens when the working set outgrows it, never that a hit is faster than a miss.",
        mechanism="the mechanism down to its limits and costs, with formulas, numbers and code where they carry the point. The standard model gets one Step at most, as the normal case, and every later Step works where it bends.",
        practice="the Rule's condition is its limit. The near miss sits just past that limit, and the fresh case changes its slot to a value close to the limit, where a learner who half knows the Rule gets it wrong.",
    ),
)}

FIT_TO_LEVEL = (
    "A Lesson fits its Learner's level when the whole of it follows that level's definition, not just its name: the promise, the normal case, the words, how far the mechanism goes, the Rule and the practice items. "
    "A level changes what the Lesson assumes and how far it takes the mechanism, never what is true: the idea stays whole at every level, and only the way in changes. "
    "A Lesson pitched to the level below talks down to its learner, and one pitched to the level above loses them."
)
LEVELS_GUIDE = "\n\n".join(["## Levels", FIT_TO_LEVEL, *(definition.text() for definition in DEFINITIONS.values())])


def level_of(profile: Profile | None) -> Level:
    return profile.level if profile else DEFAULT_LEVEL


def learner_line(level: Level) -> str:
    return f"Learner: {level.kind}, level {level}"


def learner_brief(profile: Profile | None) -> str:
    level = level_of(profile)
    return "\n".join([learner_line(level), FIT_TO_LEVEL, DEFINITIONS[level].text()])


def lesson_level(header: dict[str, Any]) -> Level:
    return Level(header.get("level", DEFAULT_LEVEL))
