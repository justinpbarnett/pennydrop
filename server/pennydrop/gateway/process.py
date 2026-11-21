from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator
from pathlib import Path

from .types import RouteError

STREAM_LIMIT_BYTES = 16 * 1024 * 1024


SPARE_IDLE_SECONDS = 90
MAX_SPARES = 4

type SpareKey = tuple[tuple[str, ...], str, tuple[tuple[str, str], ...]]


async def _spawn(argv: list[str], cwd: Path | None, env: dict[str, str] | None) -> asyncio.subprocess.Process:
    try:
        return await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env={**os.environ, **(env or {})},
            limit=STREAM_LIMIT_BYTES,
        )
    except FileNotFoundError:
        raise RouteError(f"'{argv[0]}' is not installed or not on PATH") from None


class SpareProcesses:
    def __init__(self) -> None:
        self._spares: dict[SpareKey, asyncio.Task[asyncio.subprocess.Process]] = {}
        self._expiries: dict[SpareKey, asyncio.TimerHandle] = {}

    async def take(self, argv: list[str], cwd: Path | None, env: dict[str, str] | None) -> asyncio.subprocess.Process:
        key = (tuple(argv), str(cwd), tuple(sorted((env or {}).items())))
        spare = self._spares.pop(key, None)
        if timer := self._expiries.pop(key, None):
            timer.cancel()
        process = None
        if spare is not None:
            with contextlib.suppress(RouteError):
                process = await spare
            if process is not None and process.returncode is not None:
                process = None
        if process is None:
            process = await _spawn(argv, cwd, env)
        if len(self._spares) < MAX_SPARES:
            self._spares[key] = asyncio.ensure_future(_spawn(argv, cwd, env))
            self._expiries[key] = asyncio.get_running_loop().call_later(SPARE_IDLE_SECONDS, self._retire, key)
        return process

    def _retire(self, key: SpareKey) -> None:
        self._expiries.pop(key, None)
        spare = self._spares.pop(key, None)
        if spare is not None:
            spare.add_done_callback(lambda done: done.cancelled() or done.exception() or done.result().kill())


async def run_process(argv: list[str], *, stdin: bytes, cwd: Path | None, env: dict[str, str] | None = None, spares: SpareProcesses | None = None) -> AsyncIterator[bytes]:
    process = await (spares.take(argv, cwd, env) if spares else _spawn(argv, cwd, env))
    stderr_reader = asyncio.create_task(process.stderr.read())
    try:
        process.stdin.write(stdin)
        await process.stdin.drain()
        process.stdin.close()
        async for line in process.stdout:
            yield line
        exit_code = await process.wait()
        if exit_code != 0:
            stderr = (await stderr_reader).decode(errors="replace").strip()
            raise RouteError(f"{argv[0]} exited with {exit_code}: {stderr[-600:] or 'no error output'}")
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
        stderr_reader.cancel()
