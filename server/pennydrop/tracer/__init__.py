from __future__ import annotations

import asyncio
import contextlib
import json
import resource
import sys
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, Field

from ..settings import Settings
from . import trace_events as events
from .library import ALGORITHMS, Algorithm

__all__ = ["ALGORITHMS", "Trace", "TraceError", "Tracer"]

WORKER_PATH = Path(__file__).with_name("worker.py")
RUN_SECONDS = 5.0
KILL_GRACE_SECONDS = 2.0
MAX_EVENTS = 3000
CPU_LIMIT_SECONDS = 8
MEMORY_LIMIT_KILOBYTES = 1024 * 1024
MEMORY_POLL_SECONDS = 0.2

Event = Annotated[
    events.LineEvent | events.CallEvent | events.ReturnEvent | events.PrintEvent
    | events.GetEvent | events.SetEvent | events.CompareEvent | events.SwapEvent,
    Field(discriminator="type"),
]


class TraceError(RuntimeError):
    pass


class Trace(BaseModel):
    events: list[Event]
    counters: events.Counters
    result: Any
    finals: Any
    stdout: str
    truncated: bool
    error: str | None


class Tracer:
    def __init__(self, settings: Settings):
        self._profile = _sandbox_profile(settings)

    async def trace_named(self, name: str, arguments: Any) -> Trace:
        if name not in ALGORITHMS:
            raise TraceError(f"no algorithm named '{name}', known algorithms: {', '.join(ALGORITHMS)}")
        algorithm: Algorithm = ALGORITHMS[name]
        return await self.trace_source(algorithm.source, algorithm.entry, arguments)

    async def trace_source(self, source: str, entry: str, arguments: Any) -> Trace:
        request = {"source": source, "entry": entry, "arguments": arguments, "max_events": MAX_EVENTS, "deadline_seconds": RUN_SECONDS}
        process = await asyncio.create_subprocess_exec(
            "sandbox-exec", "-p", self._profile, sys.executable, "-I", "-B", str(WORKER_PATH),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            preexec_fn=_apply_limits,
        )
        memory_guard = asyncio.create_task(_kill_when_too_large(process))
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(json.dumps(request).encode()), RUN_SECONDS + KILL_GRACE_SECONDS
            )
        except TimeoutError:
            raise TraceError(f"the traced program did not stop within {RUN_SECONDS + KILL_GRACE_SECONDS:.0f} s") from None
        finally:
            memory_guard.cancel()
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
        if memory_guard.done() and memory_guard.result():
            raise TraceError(f"the traced program used more than {MEMORY_LIMIT_KILOBYTES // 1024} MB of memory")
        if process.returncode != 0:
            raise TraceError(f"the sandboxed worker exited with {process.returncode}: {stderr.decode(errors='replace')[-500:]}")
        return Trace.model_validate_json(stdout)


def _sandbox_profile(settings: Settings) -> str:
    secrets = [settings.repo_root / ".env", settings.data_dir]
    denied_reads = " ".join(f'(subpath "{path}")' for path in secrets)
    return (
        "(version 1)(allow default)(deny network*)"
        "(deny file-write*)(allow file-write* (literal \"/dev/null\"))"
        f"(deny file-read* {denied_reads})"
    )


def _apply_limits() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_LIMIT_SECONDS, CPU_LIMIT_SECONDS))


async def _kill_when_too_large(process: asyncio.subprocess.Process) -> bool:
    while process.returncode is None:
        await asyncio.sleep(MEMORY_POLL_SECONDS)
        probe = await asyncio.create_subprocess_exec("ps", "-o", "rss=", "-p", str(process.pid), stdout=asyncio.subprocess.PIPE)
        output, _ = await probe.communicate()
        if output.strip() and int(output) > MEMORY_LIMIT_KILOBYTES:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            return True
    return False
