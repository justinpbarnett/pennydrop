from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass

from .asks import AskRequest
from .courses import Course, CourseTopic
from .gateway import GatewayError, YesNo
from .judge import Scorecard
from .practice.progress import course_progress
from .practice.records import RuleRecord
from .services import Services


@dataclass(frozen=True)
class Pregenerated:
    topic: CourseTopic
    lesson_id: str | None
    status: str
    seconds: float
    cost_usd: float
    error: str | None = None
    scorecard: Scorecard | None = None
    scoring_error: str | None = None
    link: tuple[RuleRecord, RuleRecord] | None = None

    @property
    def label(self) -> str:
        return f"{self.topic.code}+link" if self.link else self.topic.code


async def pregenerate(
    services: Services, course: Course, codes: list[str] | None, concurrency: int, redo: bool, profile_id: int | None, report: Callable[[Pregenerated], None]
) -> list[Pregenerated]:
    topics = services.store.course_topics(course.id)
    if codes:
        unknown = [code for code in codes if code not in {topic.code for topic in topics}]
        if unknown:
            raise LookupError(f"Course {course.slug} has no Topic {', '.join(unknown)}, its Topics are {', '.join(topic.code for topic in topics)}")
        topics = [topic for topic in topics if topic.code in codes]
    gate = asyncio.Semaphore(concurrency)

    async def one(topic: CourseTopic) -> Pregenerated:
        if topic.lesson_status == "ready" and not redo:
            result = Pregenerated(topic, topic.lesson_id, "skipped", 0.0, 0.0)
        else:
            async with gate:
                result = await _write(services, course, topic, None, None)
        report(result)
        return result

    try:
        written = list(await asyncio.gather(*(one(topic) for topic in topics)))
        if profile_id is None:
            return written
        links = await _link_pairs(services, course, profile_id)

        async def link(pair: tuple[RuleRecord, RuleRecord], later: CourseTopic) -> Pregenerated:
            async with gate:
                result = await _write(services, course, later, profile_id, pair)
            report(result)
            return result

        return written + list(await asyncio.gather(*(link(pair, later) for pair, later in links)))
    finally:
        await services.asks.close()


async def _link_pairs(services: Services, course: Course, profile_id: int) -> list[tuple[tuple[RuleRecord, RuleRecord], CourseTopic]]:
    progress = course_progress(services.store, course, profile_id)
    held = [(item.rule, item.topic) for item in progress.rules if item.held]
    linked = {frozenset(link.rule_ids) for link in progress.links}
    candidates = [((earlier, later), later_topic) for position, (earlier, _) in enumerate(held) for later, later_topic in held[position + 1 :] if frozenset((earlier.id, later.id)) not in linked]
    verdicts = await asyncio.gather(*(_related(services, pair) for pair, _ in candidates))
    return [candidate for candidate, related in zip(candidates, verdicts, strict=True) if related]


async def _related(services: Services, pair: tuple[RuleRecord, RuleRecord]) -> bool:
    first, second = pair
    state = f"Rule 1: {first.statement} (it holds when {first.condition}).\nRule 2: {second.statement} (it holds when {second.condition})."
    result = await services.gateway.classify(state, {"related": YesNo("Does one of these two Rules explain the other, or limit where the other holds?")})
    return result.answers["related"].yes


async def _write(services: Services, course: Course, topic: CourseTopic, profile_id: int | None, link: tuple[RuleRecord, RuleRecord] | None) -> Pregenerated:
    started = time.monotonic()
    context = services.store.course_context(topic.id)
    text = context.ask if link is None else f"{link[0].statement}, and {link[1].statement}"
    request = AskRequest(text, profile_id, None, started, course=context, link=None if link is None else (link[0].rule, link[1].rule))
    lesson_id = await services.asks.start(request)
    if link:
        services.store.save_rule_link(course.id, link[0].id, link[1].id, lesson_id)
    error = None
    async for name, data in services.asks.events(lesson_id):
        if name == "error":
            error = data["message"]
    record = services.store.lesson(lesson_id)
    seconds = time.monotonic() - started
    scorecard, scoring_error = None, None
    if record.status == "ready":
        try:
            scorecard = await services.judge.score(lesson_id)
        except GatewayError as failure:
            scoring_error = str(failure)
    return Pregenerated(topic, lesson_id, record.status, seconds, record.cost_usd, error or record.error, scorecard, scoring_error, link)
