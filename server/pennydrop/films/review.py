from __future__ import annotations

from pathlib import Path

from ..gateway import Image, json_object
from ..services import Services
from ..settings import Job
from ..store import CallStats

REVIEW_TIMEOUT_SECONDS = 900.0
REVIEW_ATTEMPTS = 2


class ReviewError(RuntimeError):
    pass


async def review_stills(services: Services, question: str, stills: list[Path], calls: list[CallStats]) -> list[str]:
    """Asks a reviewer in a fresh context to judge rendered stills; returns the problems it names, or nothing when it passes them."""
    images = tuple(Image.from_file(path) for path in stills)
    for _ in range(REVIEW_ATTEMPTS):
        completion = await services.gateway.complete(Job.FILM_REVIEW, question, images=images, timeout=REVIEW_TIMEOUT_SECONDS, effort="high")
        calls.append(completion.stats)
        verdict = json_object(completion.text)
        if verdict is None or verdict.get("verdict") not in ("pass", "fail"):
            continue
        if verdict["verdict"] == "pass":
            return []
        problems = [str(problem) for problem in verdict.get("problems", []) if str(problem).strip()]
        return problems or ["the reviewer failed the stills without naming a problem; look again at what the narration says and what the stills show"]
    raise ReviewError(f"the reviewer gave no readable verdict in {REVIEW_ATTEMPTS} attempts; its last answer began: {completion.text[:400]}")
