from __future__ import annotations

import asyncio
import contextlib
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
from .types import Completion, GatewayError, Image, Request, RouteError, Usage

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
    sandbox: str
    timeout: float


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
                async for item in self._attempt(job, route, request):
                    emitted_text = emitted_text or isinstance(item, str)
                    yield item
                return
            except GatewayError as error:
                if emitted_text:
                    raise
                failures.append(f"{route}: {error}")
        raise GatewayError(f"every route for job '{job}' failed:\n  " + "\n  ".join(failures))

    async def classify(self, state: str, questions: dict[str, Question], timeout: float = 20.0) -> Classification:
        route = self._settings.routes[Job.CLASSIFY][0]
        return await self._classify_on(route, state, questions, timeout)

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
            result = await self._classify_on(route, "The sky is blue.", {"blue": YesNo("Is the sky blue?")}, 20.0)
            return f"answered {result.answers['blue']}"
        text = ""
        async for item in self._attempt(job, route, Request(PING_PROMPT, system=PING_SYSTEM, timeout=60.0)):
            if isinstance(item, str):
                text += item
        return f"answered {text.strip()[:40]!r}"

    def _unavailable_reason(self, route: RouteSpec) -> str | None:
        adapter = self._jev if route.kind is RouteKind.JEV else self._text_routes[route.kind]
        return adapter.unavailable_reason()

    async def _classify_on(self, route: RouteSpec, state: str, questions: dict[str, Question], timeout: float) -> Classification:
        if route.kind is not RouteKind.JEV:
            raise GatewayError(f"job 'classify' needs a jev route, found {route}")
        started = time.monotonic()
        try:
            answers, usage = await self._jev.classify(route.model, state, questions, timeout)
        except Exception as error:
            self._log(Job.CLASSIFY, route, started, None, Usage(), error)
            _reraise_as_gateway_error(route, error)
        return Classification(answers, self._log(Job.CLASSIFY, route, started, None, usage, None))

    async def _attempt(self, job: Job, route: RouteSpec, request: Request) -> AsyncIterator[str | CallStats]:
        started = time.monotonic()
        first_token_seconds = None
        usage = Usage()
        try:
            async with contextlib.aclosing(self._text_routes[route.kind].run(request, route.model)) as items:
                async for item in _with_deadline(items, started + request.timeout, route):
                    if isinstance(item, Usage):
                        usage = item
                        continue
                    if first_token_seconds is None:
                        first_token_seconds = time.monotonic() - started
                    yield item
        except Exception as error:
            self._log(job, route, started, first_token_seconds, usage, error)
            _reraise_as_gateway_error(route, error)
        yield self._log(job, route, started, first_token_seconds, usage, None)

    def _log(self, job: Job, route: RouteSpec, started: float, first_token_seconds: float | None, usage: Usage, error: Exception | None) -> CallStats:
        stats = CallStats(
            job, str(route), time.monotonic() - started, first_token_seconds, usage.input_tokens, usage.cached_tokens,
            usage.output_tokens, self._cost(route, usage), str(error) if error else None,
        )
        self._store.log_model_call(stats)
        return stats

    def _cost(self, route: RouteSpec, usage: Usage) -> float:
        if usage.cost_usd is not None:
            return usage.cost_usd
        price = self._settings.prices.get(route.model)
        return price.cost(usage.input_tokens, usage.cached_tokens, usage.output_tokens) if price else 0.0


def _reraise_as_gateway_error(route: RouteSpec, error: Exception) -> NoReturn:
    if isinstance(error, GatewayError):
        raise error
    raise RouteError(f"{route} failed with {type(error).__name__}: {error}") from error


async def _with_deadline(items: AsyncIterator[str | Usage], deadline: float, route: RouteSpec) -> AsyncIterator[str | Usage]:
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
