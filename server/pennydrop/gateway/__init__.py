from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn, TypedDict, Unpack

from ..settings import Job, RouteKind, RouteSpec, Settings
from ..store import CallStats, Store
from .api import AnthropicRoute, OpenRouterRoute
from .claude import ClaudeRoute
from .codex import CodexRoute
from .jev import Answer, Choice, ChoiceAnswer, JevRoute, Question, Score, ScoreAnswer, YesNo, YesNoAnswer
from .types import Completion, GatewayError, Image, Request, RouteError, Thinking, Usage

MAX_HEDGED_ATTEMPTS = 5
MAX_HEDGES_IN_FLIGHT = 4
LOG = logging.getLogger("pennydrop.gateway")

__all__ = [
    "Answer", "Choice", "ChoiceAnswer", "Classification", "Completion", "Gateway", "GatewayError", "Image", "PingResult",
    "Question", "RequestOptions", "Score", "ScoreAnswer", "CallStats", "YesNo", "YesNoAnswer",
]

PING_PROMPT = "Reply with the single word: ready"
PING_SYSTEM = "You answer with one word."


class RequestOptions(TypedDict, total=False):
    system: str
    images: tuple[Image, ...]
    tools: str
    cwd: Path
    permission_mode: str
    allowed_tools: str
    sandbox: str
    timeout: float
    lesson_id: str
    effort: str
    hedge_after: float


@dataclass(frozen=True)
class Classification:
    answers: dict[str, Answer]
    stats: CallStats


@dataclass(frozen=True)
class PingResult:
    job: Job
    route: str
    seconds: float | None
    detail: str


class Gateway:
    def __init__(self, settings: Settings, store: Store):
        self._settings = settings
        self._store = store
        self._text_routes = {
            RouteKind.CLAUDE: ClaudeRoute(settings),
            RouteKind.CODEX: CodexRoute(settings),
            RouteKind.ANTHROPIC: AnthropicRoute(settings),
            RouteKind.OPENROUTER: OpenRouterRoute(settings),
        }
        self._jev = JevRoute(settings)
        self._hedges_in_flight = 0

    async def complete(self, job: Job, prompt: str, **options: Unpack[RequestOptions]) -> Completion:
        pieces: list[str] = []
        stats = None
        async for item in self.stream(job, prompt, **options):
            if isinstance(item, CallStats):
                stats = item
            else:
                pieces.append(item)
        return Completion("".join(pieces), stats)

    async def stream(self, job: Job, prompt: str, **options: Unpack[RequestOptions]) -> AsyncIterator[str | CallStats]:
        request = Request(prompt, **options)
        failures: list[str] = []
        for route in self._settings.routes[job]:
            reason = self._unavailable_reason(route)
            if reason:
                failures.append(f"{route}: skipped, {reason}")
                continue
            emitted_text = False
            try:
                async for item in self._hedged(job, route, request):
                    emitted_text = emitted_text or isinstance(item, str)
                    yield item
                return
            except GatewayError as error:
                if emitted_text:
                    raise
                failures.append(f"{route}: {error}")
        raise GatewayError(f"every route for job '{job}' failed:\n  " + "\n  ".join(failures))

    async def classify(self, state: str, questions: dict[str, Question], timeout: float = 20.0, lesson_id: str | None = None) -> Classification:
        route = self._settings.routes[Job.CLASSIFY][0]
        return await self._classify_on(route, state, questions, timeout, lesson_id)

    async def ping(self, job: Job) -> list[PingResult]:
        results = []
        for route in self._settings.routes[job]:
            reason = self._unavailable_reason(route)
            if reason:
                results.append(PingResult(job, str(route), None, f"skipped, {reason}"))
                continue
            started = time.monotonic()
            try:
                detail = await self._ping_route(job, route)
                results.append(PingResult(job, str(route), time.monotonic() - started, detail))
            except GatewayError as error:
                results.append(PingResult(job, str(route), time.monotonic() - started, f"failed, {error}"))
        return results

    async def _ping_route(self, job: Job, route: RouteSpec) -> str:
        if route.kind is RouteKind.JEV:
            result = await self._classify_on(route, "The sky is blue.", {"blue": YesNo("Is the sky blue?")}, 20.0, None)
            return f"answered {result.answers['blue']}"
        text = ""
        async for item in self._attempt(job, route, Request(PING_PROMPT, system=PING_SYSTEM, timeout=60.0)):
            if isinstance(item, str):
                text += item
        return f"answered {text.strip()[:40]!r}"

    def _unavailable_reason(self, route: RouteSpec) -> str | None:
        adapter = self._jev if route.kind is RouteKind.JEV else self._text_routes[route.kind]
        return adapter.unavailable_reason()

    async def _classify_on(self, route: RouteSpec, state: str, questions: dict[str, Question], timeout: float, lesson_id: str | None) -> Classification:
        if route.kind is not RouteKind.JEV:
            raise GatewayError(f"job 'classify' needs a jev route, found {route}")
        started = time.monotonic()
        try:
            answers, usage = await self._jev.classify(route.model, state, questions, timeout)
        except Exception as error:
            self._log(Job.CLASSIFY, route, started, None, Usage(), error, lesson_id)
            _reraise_as_gateway_error(route, error)
        return Classification(answers, self._log(Job.CLASSIFY, route, started, None, usage, None, lesson_id))

    async def _hedged(self, job: Job, route: RouteSpec, request: Request) -> AsyncIterator[str | CallStats]:
        if request.hedge_after is None:
            async for item in self._attempt(job, route, request):
                if not isinstance(item, Thinking):
                    yield item
            return
        queue: asyncio.Queue[tuple[int, str | CallStats | Thinking | GatewayError | None]] = asyncio.Queue()
        starts: dict[int, float] = {}

        def spawn(index: int) -> asyncio.Task[None]:
            starts[index] = time.monotonic()
            task = asyncio.create_task(pump(index))
            if index:
                self._hedges_in_flight += 1
                task.add_done_callback(self._hedge_landed)
            return task

        async def pump(index: int) -> None:
            try:
                async for item in self._attempt(job, route, request):
                    await queue.put((index, item))
                await queue.put((index, None))
            except GatewayError as error:
                await queue.put((index, error))

        def hedge() -> None:
            nonlocal latest, next_hedge
            next_hedge = time.monotonic() + request.hedge_after
            if self._hedges_in_flight < MAX_HEDGES_IN_FLIGHT:
                latest += 1
                tasks[latest] = spawn(latest)

        tasks = {0: spawn(0)}
        latest = 0
        next_hedge = time.monotonic() + request.hedge_after
        winner: int | None = None
        lost: list[int] = []
        stats: CallStats | None = None
        try:
            while True:
                may_hedge = winner is None and latest + 1 < MAX_HEDGED_ATTEMPTS
                try:
                    index, item = await asyncio.wait_for(queue.get(), max(next_hedge - time.monotonic(), 0) if may_hedge else None)
                except TimeoutError:
                    hedge()
                    continue
                if isinstance(item, Thinking):
                    if index == latest and may_hedge:
                        LOG.warning("hedge: %s attempt %d began thinking %.1fs in, so another attempt starts now", route, index + 1, time.monotonic() - starts[index])
                        hedge()
                    continue
                if winner is None and isinstance(item, str):
                    winner = index
                    lost = [other for other, task in tasks.items() if other != winner and not task.done()]
                    await _cancel(tasks[other] for other in lost)
                if winner is not None and index != winner:
                    continue
                if isinstance(item, GatewayError):
                    if winner is None and len(tasks) > 1:
                        del tasks[index]
                        continue
                    raise item
                if item is None:
                    return
                if isinstance(item, CallStats):
                    stats = item
                yield item
                if stats:
                    return
        finally:
            await _cancel(tasks.values())
            for other in lost:
                self._log_hedge_loser(job, route, request, starts[other], stats)

    def _hedge_landed(self, _: asyncio.Task[None]) -> None:
        self._hedges_in_flight -= 1

    async def _attempt(self, job: Job, route: RouteSpec, request: Request) -> AsyncIterator[str | CallStats | Thinking]:
        started = time.monotonic()
        first_token_seconds = None
        usage = Usage()
        try:
            async with contextlib.aclosing(self._text_routes[route.kind].run(request, route.model)) as items:
                async for item in _with_deadline(items, started + request.timeout, route):
                    if isinstance(item, Usage):
                        usage = item
                        continue
                    if first_token_seconds is None and not isinstance(item, Thinking):
                        first_token_seconds = time.monotonic() - started
                    yield item
        except Exception as error:
            self._log(job, route, started, first_token_seconds, usage, error, request.lesson_id)
            _reraise_as_gateway_error(route, error)
        yield self._log(job, route, started, first_token_seconds, usage, None, request.lesson_id)

    def _log(self, job: Job, route: RouteSpec, started: float, first_token_seconds: float | None, usage: Usage, error: Exception | None, lesson_id: str | None) -> CallStats:
        stats = CallStats(
            job, str(route), time.monotonic() - started, first_token_seconds, usage.input_tokens, usage.cached_tokens,
            usage.output_tokens, self._cost(route, usage), str(error) if error else None, lesson_id, usage.stop_reason,
        )
        self._store.log_model_call(stats)
        return stats

    def _log_hedge_loser(self, job: Job, route: RouteSpec, request: Request, started: float, winner: CallStats | None) -> None:
        usage = Usage(input_tokens=winner.input_tokens, cached_tokens=winner.cached_tokens) if winner else Usage()
        self._log(job, route, started, None, usage, GatewayError("hedge: the slower attempt was cancelled"), request.lesson_id)

    def _cost(self, route: RouteSpec, usage: Usage) -> float:
        if usage.cost_usd is not None:
            return usage.cost_usd
        price = self._settings.prices.get(route.model)
        return price.cost(usage.input_tokens, usage.cached_tokens, usage.output_tokens) if price else 0.0


async def _cancel(tasks) -> None:
    pending = [task for task in tasks if not task.done()]
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


def _reraise_as_gateway_error(route: RouteSpec, error: Exception) -> NoReturn:
    if isinstance(error, GatewayError):
        raise error
    raise RouteError(f"{route} failed with {type(error).__name__}: {error}") from error


async def _with_deadline(items: AsyncIterator[str | Usage | Thinking], deadline: float, route: RouteSpec) -> AsyncIterator[str | Usage | Thinking]:
    iterator = aiter(items)
    while True:
        try:
            async with asyncio.timeout_at(asyncio.get_running_loop().time() + max(deadline - time.monotonic(), 0)):
                item = await anext(iterator)
        except StopAsyncIteration:
            return
        except TimeoutError:
            raise RouteError(f"{route} timed out") from None
        yield item
