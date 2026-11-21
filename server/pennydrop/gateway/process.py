from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator
from pathlib import Path

from .types import RouteError

STREAM_LIMIT_BYTES = 16 * 1024 * 1024


async def run_process(argv: list[str], *, stdin: bytes, cwd: Path | None, env: dict[str, str] | None = None) -> AsyncIterator[bytes]:
    try:
        process = await asyncio.create_subprocess_exec(
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
