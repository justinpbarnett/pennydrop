from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass

from .asks import AskRequest
from .courses import Course, CourseTopic
from .gateway import GatewayError
from .judge import Scorecard
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


async def pregenerate(
    services: Services, course: Course, codes: list[str] | None, concurrency: int, redo: bool, report: Callable[[Pregenerated], None]
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
                result = await _write(services, topic)
        report(result)
        return result

    try:
        return await asyncio.gather(*(one(topic) for topic in topics))
    finally:
        await services.asks.close()


async def _write(services: Services, topic: CourseTopic) -> Pregenerated:
    started = time.monotonic()
    context = services.store.course_context(topic.id)
    lesson_id = await services.asks.start(AskRequest(context.ask, None, None, started, course=context))
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
    return Pregenerated(topic, lesson_id, record.status, seconds, record.cost_usd, error or record.error, scorecard, scoring_error)
