from __future__ import annotations

import json
import math
import statistics
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from .settings import Settings

CONNECT_SECONDS = 5.0
LESSON_SECONDS = 180.0


class AskClientError(RuntimeError):
    pass


@dataclass(frozen=True)
class Arrival:
    step: dict[str, Any]
    seconds: float


@dataclass
class Outcome:
    ask: str
    lesson_id: str
    transcript: str
    header: dict[str, Any] = field(default_factory=dict)
    arrivals: list[Arrival] = field(default_factory=list)
    done: dict[str, Any] | None = None
    error: str | None = None
    posted_seconds: float = 0.0
    finished_seconds: float = 0.0


class AskClient:
    def __init__(self, settings: Settings):
        self._base = f"http://{settings.host}:{settings.port}"

    def profile_id(self) -> int | None:
        profiles = self._get("/api/profiles")
        return next((profile["id"] for profile in profiles if profile["kind"] == "adult"), None)

    def ask(
        self, text: str | None, audio: Path | None, profile_id: int | None, from_step: dict[str, Any] | None,
        on_step: Callable[[Arrival], None] | None = None, bench: bool = False,
    ) -> Outcome:
        started = time.monotonic()
        fields: dict[str, Any] = {}
        if text:
            fields["text"] = text
        if profile_id is not None:
            fields["profile_id"] = profile_id
        if bench:
            fields["bench"] = True
        with httpx.Client(base_url=self._base, timeout=httpx.Timeout(LESSON_SECONDS, connect=CONNECT_SECONDS)) as client:
            try:
                if audio:
                    response = client.post("/api/asks", data={**{k: str(v) for k, v in fields.items()}, **({"from": json.dumps(from_step)} if from_step else {})}, files={"audio": (audio.name, audio.read_bytes())})
                else:
                    response = client.post("/api/asks", json={**fields, **({"from": from_step} if from_step else {})})
            except httpx.ConnectError:
                raise AskClientError(f"no server at {self._base}; start it with `uv run pd serve`") from None
            if response.status_code != 200:
                raise AskClientError(f"POST /api/asks answered {response.status_code}: {response.text[:300]}")
            reply = response.json()
            outcome = Outcome(text or reply["transcript"], reply["lesson_id"], reply["transcript"], posted_seconds=time.monotonic() - started)
            with client.stream("GET", f"/api/lessons/{outcome.lesson_id}/events") as events:
                for name, data in _server_sent(events.iter_lines()):
                    now = time.monotonic() - started
                    if name == "lesson":
                        outcome.header = data["lesson"]
                    elif name == "step":
                        arrival = Arrival(data, now)
                        outcome.arrivals.append(arrival)
                        if on_step:
                            on_step(arrival)
                    elif name == "done":
                        outcome.done = data
                    elif name == "error":
                        outcome.error = data["message"]
            outcome.finished_seconds = time.monotonic() - started
        return outcome

    def _get(self, path: str) -> Any:
        try:
            return httpx.get(self._base + path, timeout=CONNECT_SECONDS).json()
        except httpx.ConnectError:
            raise AskClientError(f"no server at {self._base}; start it with `uv run pd serve`") from None


def _server_sent(lines):
    name = None
    for line in lines:
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:") and name:
            yield name, json.loads(line[5:])
            name = None


def breakdown(done: dict[str, Any]) -> list[tuple[str, float]]:
    marks = done["timings"]
    transcription = done.get("transcription_seconds") or 0.0
    stages = [
        ("classify with JEV", marks["classified"] - transcription),
        ("writer process start and first token", marks["writer_first_token"] - marks["classified"]),
        ("Step 1 tokens", marks["first_step_parsed"] - marks["writer_first_token"]),
        ("Step 1 expand and validate", marks["first_step_checked"] - marks["first_step_parsed"]),
        ("Step 1 voice wait", marks["first_step_voiced"] - marks["first_step_checked"]),
        ("Step 1 publish", marks["first_step_published"] - marks["first_step_voiced"]),
    ]
    return ([("transcribe", transcription)] if transcription else []) + stages


def p90(values: list[float]) -> float:
    ranked = sorted(values)
    return ranked[math.ceil(0.9 * len(ranked)) - 1]


def median_and_max(values: list[float]) -> tuple[float, float]:
    return statistics.median(values), max(values)
