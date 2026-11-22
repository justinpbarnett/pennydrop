from __future__ import annotations

import logging
from typing import Any

from ..gateway import GatewayError
from .classify import Classifier

LOG = logging.getLogger("pennydrop.asks")

ANSWER_TOLD = 'challenge: the narration so far, this Step\'s "say" included, already tells the answer to this Challenge, so the learner remembers it instead of predicting; take the answer out of this Step\'s "say", and when an earlier Step told it, ask about the next thing the run or story does that no Step has said or played yet, and let the next Step show it'
ASKS_ANOTHER_QUESTION = 'challenge: this Step\'s "say" asks a different question from its Challenge, so the learner hears one question and is asked to answer another; make "say" ask the Challenge prompt\'s own question, for the same form of answer, and keep the Challenge as it is'
ANSWER_FORMS = {"number": "The learner answers with a number.", "choice": "The learner picks one of: {choices}.", "click": "The learner answers by tapping a thing on the stage.", "order": "The learner puts these in order: {choices}.", "match": "The learner matches pairs."}


def predicted(step: dict[str, Any], place: str | None) -> str | None:
    challenge = step.get("challenge")
    if not isinstance(challenge, dict) or challenge.get("kind") != "predict" or "answer" not in challenge:
        return None
    choices = f' Choices: {", ".join(map(str, challenge["choices"]))}.' if isinstance(challenge.get("choices"), list) else ""
    placed = f" ({place})" if place else ""
    return f'{challenge.get("prompt")}{choices} Answer: {challenge["answer"]}{placed}'


async def answer_told(classifier: Classifier, step: dict[str, Any], told: list[str], place: str | None, lesson_id: str) -> str | None:
    asked = predicted(step, place)
    if asked is None:
        return None
    try:
        said = await classifier.answer_told(" ".join([*told, str(step.get("say", ""))]), asked, lesson_id)
    except GatewayError as error:
        LOG.warning("lesson %s Challenge could not be checked against the narration: %s", lesson_id, error)
        return None
    return ANSWER_TOLD if said else None


async def asks_another_question(classifier: Classifier, step: dict[str, Any], lesson_id: str) -> str | None:
    challenge, say = step.get("challenge"), step.get("say")
    if not isinstance(challenge, dict) or not isinstance(say, str) or not isinstance(challenge.get("prompt"), str):
        return None
    choices = ", ".join(map(str, challenge.get("choices") or []))
    form = ANSWER_FORMS.get(str(challenge.get("type")), "").format(choices=choices)
    try:
        same = await classifier.asks_the_challenge(say, f'{challenge["prompt"]} {form}'.strip(), lesson_id)
    except GatewayError as error:
        LOG.warning("lesson %s Challenge could not be checked against its narration: %s", lesson_id, error)
        return None
    return None if same else ASKS_ANOTHER_QUESTION
