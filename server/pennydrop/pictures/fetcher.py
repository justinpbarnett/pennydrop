from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

import httpx

from .sources import USER_AGENT

PER_HOST = 3
TRIES = 4
MIN_WAIT = 0.5
MAX_WAIT = 5.0
SLOW_DOWN = frozenset({429, 503})


class PoliteFetcher:
    def __init__(self) -> None:
        self._gates: dict[str, asyncio.Semaphore] = {}

    async def get(self, url: str, timeout: float) -> bytes:
        gate = self._gates.setdefault(urlsplit(url).netloc, asyncio.Semaphore(PER_HOST))
        async with gate, httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=timeout, follow_redirects=True) as client:
            attempt = 1
            while (response := await client.get(url)).status_code in SLOW_DOWN and attempt < TRIES and (wait := _retry_after(response, attempt)) <= MAX_WAIT:
                await asyncio.sleep(wait)
                attempt += 1
            response.raise_for_status()
            return response.content


def _retry_after(response: httpx.Response, attempt: int) -> float:
    try:
        return max(float(response.headers["Retry-After"]), MIN_WAIT)
    except (KeyError, ValueError):
        return float(attempt)
