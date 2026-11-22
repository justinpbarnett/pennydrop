from __future__ import annotations

import json
from dataclasses import replace
from collections.abc import AsyncIterator

import httpx

from ..settings import Settings
from .types import Request, RouteError, Usage


async def _server_sent_data(response: httpx.Response) -> AsyncIterator[dict]:
    if response.status_code != 200:
        body = (await response.aread()).decode(errors="replace")
        raise RouteError(f"{response.url.host} answered {response.status_code}: {body[:400]}")
    async for line in response.aiter_lines():
        if line.startswith("data:") and line[5:].strip() != "[DONE]":
            yield json.loads(line[5:])


class AnthropicRoute:
    endpoint = "https://api.anthropic.com/v1/messages"

    def __init__(self, settings: Settings):
        self._key = settings.secret("ANTHROPIC_API_KEY")

    def unavailable_reason(self) -> str | None:
        return None if self._key else "ANTHROPIC_API_KEY is not set in .env"

    async def run(self, request: Request, model: str) -> AsyncIterator[str | Usage]:
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": image.media_type, "data": image.base64}}
            for image in request.images
        ]
        content.append({"type": "text", "text": request.prompt})
        body = {"model": model, "max_tokens": 8192, "stream": True, "messages": [{"role": "user", "content": content}]}
        if request.system is not None:
            body["system"] = request.system
        headers = {"x-api-key": self._key, "anthropic-version": "2023-06-01"}
        input_tokens = cached = output_tokens = 0
        stop_reason = None
        async with httpx.AsyncClient(timeout=request.timeout) as client, client.stream("POST", self.endpoint, headers=headers, json=body) as response:
            async for event in _server_sent_data(response):
                if event["type"] == "message_start":
                    usage = event["message"]["usage"]
                    cached = usage.get("cache_read_input_tokens", 0)
                    input_tokens = usage["input_tokens"] + usage.get("cache_creation_input_tokens", 0) + cached
                elif event["type"] == "content_block_delta" and event["delta"]["type"] == "text_delta":
                    yield event["delta"]["text"]
                elif event["type"] == "message_delta":
                    output_tokens = event["usage"]["output_tokens"]
                    stop_reason = event["delta"].get("stop_reason")
                elif event["type"] == "error":
                    raise RouteError(f"anthropic stream error: {event['error']}")
        yield Usage(input_tokens, cached, output_tokens, stop_reason=stop_reason)


class OpenRouterRoute:
    endpoint = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(self, settings: Settings):
        self._key = settings.secret("OPENROUTER_API_KEY")

    def unavailable_reason(self) -> str | None:
        return None if self._key else "OPENROUTER_API_KEY is not set in .env"

    async def run(self, request: Request, model: str) -> AsyncIterator[str | Usage]:
        content = [{"type": "image_url", "image_url": {"url": f"data:{image.media_type};base64,{image.base64}"}} for image in request.images]
        content.append({"type": "text", "text": request.prompt})
        messages = [{"role": "user", "content": content}]
        if request.system is not None:
            messages.insert(0, {"role": "system", "content": request.system})
        body = {"model": model, "stream": True, "usage": {"include": True}, "messages": messages}
        if "WebSearch" in request.tools:
            body["plugins"] = [{"id": "web"}]
        usage = Usage()
        finish_reason = None
        headers = {"Authorization": f"Bearer {self._key}"}
        async with httpx.AsyncClient(timeout=request.timeout) as client, client.stream("POST", self.endpoint, headers=headers, json=body) as response:
            async for event in _server_sent_data(response):
                if "error" in event:
                    raise RouteError(f"openrouter stream error: {event['error']}")
                for choice in event.get("choices", []):
                    if choice["delta"].get("content"):
                        yield choice["delta"]["content"]
                    finish_reason = choice.get("finish_reason") or finish_reason
                if "usage" in event:
                    raw = event["usage"]
                    cached = raw.get("prompt_tokens_details", {}).get("cached_tokens", 0)
                    usage = Usage(raw["prompt_tokens"], cached, raw["completion_tokens"], raw.get("cost"))
        yield replace(usage, stop_reason=finish_reason)
