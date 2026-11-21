from __future__ import annotations

import json
from dataclasses import dataclass
from collections.abc import AsyncIterator

from ..settings import Settings
from .process import run_process
from .types import Request, RouteError, Usage

MAX_THINKING_RESTARTS = 4


class ClaudeRoute:
    def __init__(self, settings: Settings):
        self._neutral_cwd = settings.scratch_dir

    def unavailable_reason(self) -> str | None:
        return None

    async def run(self, request: Request, model: str) -> AsyncIterator[str | Usage]:
        for restarts_left in range(MAX_THINKING_RESTARTS, -1, -1):
            outcome = _Attempt()
            async for item in self._attempt(request, model, outcome, abort_on_thinking=bool(request.effort) and restarts_left > 0):
                yield item
            if not outcome.thought_first:
                return

    async def _attempt(self, request: Request, model: str, outcome: _Attempt, abort_on_thinking: bool) -> AsyncIterator[str | Usage]:
        argv = [
            "claude", "-p", "--model", model,
            "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
            "--tools", request.tools,
        ]
        if request.system is not None:
            argv += ["--system-prompt", request.system]
        if request.effort:
            argv += ["--effort", request.effort]
        if request.permission_mode:
            argv += ["--permission-mode", request.permission_mode]
        if request.images:
            argv += ["--input-format", "stream-json"]
        cwd = request.cwd or self._neutral_cwd
        cwd.mkdir(parents=True, exist_ok=True)
        lines = run_process(argv, stdin=_stdin_for(request), cwd=cwd, env={"CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_THINKING": "1"})
        answered = False
        try:
            async for line in lines:
                event = json.loads(line)
                if event["type"] == "stream_event":
                    delta = event["event"].get("delta", {})
                    if delta.get("type") == "text_delta":
                        answered = True
                        yield delta["text"]
                    elif delta.get("type") == "thinking_delta" and not answered and abort_on_thinking:
                        outcome.thought_first = True
                        return
                elif event["type"] == "result":
                    if event.get("is_error"):
                        raise RouteError(f"claude reported an error: {event.get('result')}")
                    usage = event["usage"]
                    yield Usage(
                        input_tokens=usage["input_tokens"] + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0),
                        cached_tokens=usage.get("cache_read_input_tokens", 0),
                        output_tokens=usage["output_tokens"],
                        cost_usd=event.get("total_cost_usd"),
                    )
                    return
            raise RouteError("claude ended without a result event")
        finally:
            await lines.aclose()


@dataclass
class _Attempt:
    thought_first: bool = False


def _stdin_for(request: Request) -> bytes:
    if not request.images:
        return request.prompt.encode()
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": image.media_type, "data": image.base64}}
        for image in request.images
    ]
    content.append({"type": "text", "text": request.prompt})
    message = {"type": "user", "message": {"role": "user", "content": content}}
    return (json.dumps(message) + "\n").encode()
