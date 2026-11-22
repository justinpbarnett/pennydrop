from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from ..review import NEW_ITEM, next_schedule, quality_for
from ..store import Store
from . import FORMS, Direction, Form
from .records import PracticeCase, RuleReview

if TYPE_CHECKING:
    from .author import PracticeAuthor

RETRY_AFTER = timedelta(minutes=10)


class RuleQueue:
    def __init__(self, store: Store):
        self._store = store

    def enroll(self, profile_id: int, lesson_id: str) -> RuleReview | None:
        rule = self._store.rule_for_lesson(lesson_id)
        return self._review_of(profile_id, rule.id) if rule else None

    def answer(self, profile_id: int, case: PracticeCase, answer: object, correct: bool, feedback: str) -> RuleReview:
        review = self._review_of(profile_id, case.rule_id)
        self._store.log_practice_answer(profile_id, case, answer, correct, feedback)
        updated = _after_answer(review, case, correct, _now())
        self._store.save_rule_review(updated)
        return updated

    def due(self, profile_id: int) -> list[RuleReview]:
        return self._store.rule_reviews(profile_id, due_by=_now())

    def queue(self, profile_id: int) -> list[RuleReview]:
        return self._store.rule_reviews(profile_id)

    def held_rule_ids(self, profile_id: int) -> set[int]:
        return {review.rule.id for review in self._store.rule_reviews(profile_id) if review.held}

    async def next_case(self, profile_id: int, rule_id: int, author: PracticeAuthor) -> PracticeCase:
        review = self._store.rule_review(profile_id, rule_id)
        if review is None:
            raise LookupError(f"Profile {profile_id} has no Rule {rule_id} in the review queue")
        seen = [case.item for case in self._store.rule_cases(rule_id)]
        direction = review.next_direction if review.next_form is Form.FRESH else None
        item = await author.case(review.rule.rule, review.next_form, direction, review.rule.lesson_id, seen, self._store.profile(profile_id))
        return self._store.add_review_case(rule_id, item)

    def _review_of(self, profile_id: int, rule_id: int) -> RuleReview:
        existing = self._store.rule_review(profile_id, rule_id)
        if existing:
            return existing
        self._store.profile(profile_id)
        enrolled = RuleReview(profile_id, self._store.rule(rule_id), FORMS[0], self._first_review_direction(rule_id), {}, NEW_ITEM, _now())
        self._store.save_rule_review(enrolled)
        return enrolled

    def _first_review_direction(self, rule_id: int) -> Direction:
        own_fresh = [case for case in self._store.rule_cases(rule_id) if case.form is Form.FRESH and case.direction]
        return own_fresh[0].direction.other if own_fresh else Direction.FORWARD


def _after_answer(review: RuleReview, case: PracticeCase, correct: bool, now: datetime) -> RuleReview:
    latest = {**review.latest, case.form: correct}
    direction = case.direction.other if case.direction else review.next_direction
    if not correct:
        return RuleReview(review.profile_id, review.rule, case.form, direction, latest, next_schedule(review.schedule, quality_for(False)), now + RETRY_AFTER)
    following = FORMS[(FORMS.index(case.form) + 1) % len(FORMS)]
    if review.due > now:
        return RuleReview(review.profile_id, review.rule, following, direction, latest, review.schedule, review.due)
    schedule = next_schedule(review.schedule, quality_for(True))
    return RuleReview(review.profile_id, review.rule, following, direction, latest, schedule, now + timedelta(days=schedule.interval_days))


def _now() -> datetime:
    return datetime.now(UTC)
