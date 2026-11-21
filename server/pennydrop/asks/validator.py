from __future__ import annotations

import asyncio
import itertools
import json
import logging
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from ..settings import Settings
from .lesson_format import Step, describe

LOG = logging.getLogger("pennydrop.asks")
REQUEST_TIMEOUT_SECONDS = 20.0
STREAM_LIMIT_BYTES = 16 * 1024 * 1024


class ValidatorError(RuntimeError):
    pass


class PlayerCrash(RuntimeError):
    pass


@dataclass(frozen=True)
class Verdict:
    errors: tuple[str, ...]
    scene: Any

    @property
    def ok(self) -> bool:
        return not self.errors


class Validator:
    def __init__(self, settings: Settings):
        self._player_dir = settings.player_dir
        self._session: _Session | None = None
        self._start_lock = asyncio.Lock()

    async def check(self, step: dict[str, Any], scene: Any, reading: bool = True, replay: bool = False) -> Verdict:
        try:
            wire = Step.model_validate(step).as_wire()
        except ValidationError as error:
            return Verdict(tuple(describe(error)), scene)
        for attempt in (1, 2):
            try:
                reply = await (await self._running()).ask({"scene": scene, "step": wire, **({} if reading else {"reading": False}), **({"replay": True} if replay else {})})
                if "crash" in reply:
                    raise PlayerCrash(reply["crash"])
                return Verdict(tuple(reply["errors"]), reply["scene"] if reply["ok"] else scene)
            except ValidatorError:
                if attempt == 2:
                    raise
        raise AssertionError("unreachable")

    async def replay(self, steps: list[dict[str, Any]], reading: bool = True) -> Any:
        scene = None
        for step in steps:
            verdict = await self.check({key: value for key, value in step.items() if key != "voice"}, scene, reading, replay=True)
            if not verdict.ok:
                raise ValidatorError(f"stored step {step.get('step')} no longer plays: {'; '.join(verdict.errors)}")
            scene = verdict.scene
        return scene

    async def close(self) -> None:
        if self._session:
            await self._session.stop()

    async def _running(self) -> _Session:
        async with self._start_lock:
            if self._session is None or not self._session.alive:
                self._session = await _Session.start(self._player_dir)
            return self._session


class _Session:
    def __init__(self, process: asyncio.subprocess.Process):
        self._process = process
        self._pending: dict[int, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._reader = asyncio.create_task(self._read_replies())

    @classmethod
    async def start(cls, player_dir) -> _Session:
        try:
            process = await asyncio.create_subprocess_exec(
                "bun", "tools/validate.ts", cwd=player_dir,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                limit=STREAM_LIMIT_BYTES,
            )
        except FileNotFoundError:
            raise ValidatorError("'bun' is not installed or not on PATH, and the player's validator needs it") from None
        LOG.info("validator started, pid %s", process.pid)
        return cls(process)

    @property
    def alive(self) -> bool:
        return self._process.returncode is None

    async def ask(self, message: dict[str, Any]) -> dict[str, Any]:
        request_id = next(self._ids)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            self._process.stdin.write((json.dumps({"id": request_id, **message}) + "\n").encode())
            await self._process.stdin.drain()
            return await asyncio.wait_for(future, REQUEST_TIMEOUT_SECONDS)
        except (BrokenPipeError, ConnectionResetError):
            raise ValidatorError("the validator process closed its input") from None
        except TimeoutError:
            self._process.kill()
            raise ValidatorError(f"the validator did not answer within {REQUEST_TIMEOUT_SECONDS:.0f} s and was restarted") from None
        finally:
            self._pending.pop(request_id, None)

    async def stop(self) -> None:
        if self.alive:
            self._process.kill()
            await self._process.wait()

    async def _read_replies(self) -> None:
        async for line in self._process.stdout:
            try:
                reply = json.loads(line)
            except json.JSONDecodeError:
                LOG.warning("validator printed a line that is not a reply: %s", line[:200])
                continue
            future = self._pending.get(reply.get("id"))
            if future and not future.done():
                future.set_result(reply)
        await self._process.wait()
        died = ValidatorError(f"the validator process exited with {self._process.returncode}")
        for future in self._pending.values():
            if not future.done():
                future.set_exception(died)
