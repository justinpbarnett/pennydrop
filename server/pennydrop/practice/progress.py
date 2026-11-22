from __future__ import annotations

from dataclasses import dataclass

from ..courses import Course, CourseTopic
from ..store import Store
from .records import RuleLink, RuleRecord


@dataclass(frozen=True)
class TopicProgress:
    topic: CourseTopic
    rule: RuleRecord | None
    held: bool


@dataclass(frozen=True)
class CourseProgress:
    course: Course
    topics: list[TopicProgress]
    links: list[RuleLink]

    @property
    def rules(self) -> list[TopicProgress]:
        return [progress for progress in self.topics if progress.rule]

    @property
    def rules_total(self) -> int:
        return len(self.rules)

    @property
    def rules_held(self) -> int:
        return sum(1 for progress in self.rules if progress.held)


def course_progress(store: Store, course: Course, profile_id: int | None) -> CourseProgress:
    held = {review.rule.id for review in store.rule_reviews(profile_id) if review.held} if profile_id is not None else set()
    topics = []
    for topic in store.course_topics(course.id):
        rule = store.rule_for_lesson(topic.lesson_id) if topic.lesson_id else None
        topics.append(TopicProgress(topic, rule, rule is not None and rule.id in held))
    return CourseProgress(course, topics, store.rule_links(course.id))
