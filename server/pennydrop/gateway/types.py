from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path

from ..store import CallStats


class GatewayError(RuntimeError):
    pass


class RouteError(GatewayError):
    pass


@dataclass(frozen=True)
class Image:
    media_type: str
    data: bytes

    @classmethod
    def from_file(cls, path: Path) -> Image:
        media_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
        media_type = media_types.get(path.suffix.lower())
        if media_type is None:
            raise ValueError(f"{path.name} is not a png, jpeg, gif or webp image")
        return cls(media_type, path.read_bytes())

    @property
    def base64(self) -> str:
        return base64.b64encode(self.data).decode()


@dataclass(frozen=True)
class Request:
    prompt: str
    system: str | None = None
    images: tuple[Image, ...] = ()
    tools: str = ""
    cwd: Path | None = None
    permission_mode: str | None = None
    sandbox: str | None = None
    timeout: float = 120.0
    lesson_id: str | None = None
    effort: str | None = None
    hedge_after: float | None = None


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None


@dataclass(frozen=True)
class Thinking:
    pass


@dataclass(frozen=True)
class Completion:
    text: str
    stats: CallStats
