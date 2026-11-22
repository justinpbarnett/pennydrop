from __future__ import annotations

import json
from collections.abc import AsyncIterator

from ..settings import Settings
from .process import run_process
from .types import Request, RouteError, Usage


class CodexRoute:
    def __init__(self, settings: Settings):
        self._neutral_cwd = settings.scratch_dir

    def unavailable_reason(self) -> str | None:
        return None

    async def run(self, request: Request, model: str) -> AsyncIterator[str | Usage]:
        if request.images:
            raise RouteError("codex routes do not take images")
        argv = ["codex"]
        if "WebSearch" in request.tools:
            argv.append("--search")
        argv += [
            "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
            "--json", "-m", model,
        ]
        cwd = request.cwd or self._neutral_cwd
        cwd.mkdir(parents=True, exist_ok=True)
        argv += ["-C", str(cwd), "-s", request.sandbox or "read-only", "-"]
        prompt = request.prompt if request.system is None else f"{request.system}\n\n{request.prompt}"
        message = None
        failure = None
        usage = None
        try:
            async for line in run_process(argv, stdin=prompt.encode(), cwd=cwd):
                if not line.startswith(b"{"):
                    continue
                event = json.loads(line)
                if event["type"] == "item.completed" and event["item"]["type"] == "agent_message":
                    message = event["item"]["text"]
                elif event["type"] == "turn.completed":
                    raw = event["usage"]
                    usage = Usage(raw["input_tokens"], raw.get("cached_input_tokens", 0), raw["output_tokens"])
                elif event["type"] in ("turn.failed", "error"):
                    failure = event.get("message") or json.dumps(event.get("error", event))
        except RouteError as error:
            raise RouteError(f"codex failed: {failure}") if failure else error from None
        if failure:
            raise RouteError(f"codex failed: {failure}")
        if message is None or usage is None:
            raise RouteError("codex ended without a final message and usage")
        yield message
        yield usage
