from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..gateway import json_object
from ..services import Services
from ..settings import Job
from ..store import CallStats
from .document import FilmError
from .workspace import Workspace

PROMPTS = Path(__file__).parent / "prompts"
SEARCH_TOOLS = "WebSearch,WebFetch"
ROUNDS = 3


def prompt(name: str, **values: str) -> str:
    return (PROMPTS / f"{name}.md").read_text().format(**values)


def craft() -> str:
    return (PROMPTS / "craft.md").read_text()


def craft_narration() -> str:
    whole = craft()
    return whole[: whole.index("### Set pieces")].rstrip() + "\n"


def armature() -> str:
    return (PROMPTS / "armature.md").read_text()


def json_in(text: str) -> dict:
    parsed = json_object(text)
    if parsed is None:
        raise FilmError("the answer holds no valid JSON object")
    return parsed


async def answer(
    services: Services,
    workspace: Workspace,
    stage: str,
    job: Job,
    question: str,
    check: Callable[[Any], list[str]],
    parse: Callable[[str], Any] = json_in,
    search: bool = False,
    timeout: float = 1500.0,
) -> Any:
    options = {"tools": SEARCH_TOOLS, "allowed_tools": SEARCH_TOOLS} if search else {}
    calls: list[CallStats] = []
    asked = question
    problems: list[str] = []
    try:
        for _ in range(ROUNDS):
            completion = await services.gateway.complete(job, asked, timeout=timeout, **options)
            calls.append(completion.stats)
            parsed: Any = None
            try:
                parsed = parse(completion.text)
                problems = check(parsed)
            except FilmError as error:
                problems = [str(error)]
            if not problems:
                return parsed
            listing = "\n".join(f"- {problem}" for problem in problems)
            asked = f"{question}\n\nYour previous answer:\n\n{completion.text}\n\nIt has these problems:\n{listing}\n\nAnswer again in full, with every problem fixed and nothing else changed."
        rejected = workspace.home / f"{stage}.rejected.txt"
        rejected.write_text(completion.text)
        raise FilmError(f"{stage} still had problems after {ROUNDS} rounds, and its last answer is in {rejected}:\n" + "\n".join(f"- {problem}" for problem in problems))
    finally:
        if calls:
            workspace.record(stage, calls)
