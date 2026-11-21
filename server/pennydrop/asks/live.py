from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

Event = tuple[str, dict[str, Any]]


class LiveLesson:
    def __init__(self) -> None:
        self._events: list[Event] = []
        self._closed = False
        self._waiters: list[asyncio.Future[None]] = []

    def publish(self, name: str, data: dict[str, Any]) -> None:
        self._events.append((name, data))
        self._wake()

    def close(self) -> None:
        self._closed = True
        self._wake()

    async def stream(self) -> AsyncIterator[Event]:
        index = 0
        while True:
            while index < len(self._events):
                yield self._events[index]
                index += 1
            if self._closed:
                return
            waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            await waiter

    def _wake(self) -> None:
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_result(None)
        self._waiters.clear()
