from __future__ import annotations

import asyncio
import json
from itertools import batched
from pathlib import Path

from ..services import Services
from ..settings import Job
from ..store import CallStats
from .ask import answer, prompt, shot_format
from .blender import Engine
from .review import review_stills
from .workspace import Workspace

STILLS_PER_REVIEW = 12


def look_id(role: str, look: str) -> str:
    return f"{role}_{look}"


def storyboard_sets(board: dict) -> str:
    return "\n".join(f"- {entry['id']}: {entry['place']}, {entry['when']}. {entry['look']}" for entry in board["sets"])


def storyboard_cast(board: dict) -> str:
    return "\n".join(
        f"- {role['id']}: {role['who']}\n" + "\n".join(f"  - look {look_id(role['id'], look['id'])}, {look['when']}: {look['wears']}" for look in role["looks"])
        for role in board["cast"]
    )


def design_problems(design: dict, board: dict) -> list[str]:
    sections = {name: design.get(name, {}) for name in ("characters", "looks", "props", "sets")}
    if not all(isinstance(section, dict) for section in sections.values()):
        return ['the design\'s "characters", "looks", "props" and "sets" are each an object keyed by id']
    problems = [f'the design lacks set "{entry["id"]}" from the storyboard' for entry in board["sets"] if entry["id"] not in sections["sets"]]
    problems += [
        f'the design lacks look "{look_id(role["id"], look["id"])}" for role {role["id"]}, dressed as: {look["wears"]}'
        for role in board["cast"]
        for look in role["looks"]
        if look_id(role["id"], look["id"]) not in sections["looks"]
    ]
    return problems


async def review_sheet(services: Services, board: dict, research: str, stills: list[dict], calls: list[CallStats]) -> list[str]:
    """Reviews the design sheet a dozen stills at a time, so each picture gets the reviewer's attention."""
    numbered = list(enumerate(stills, start=1))

    async def review(chunk: tuple[tuple[int, dict], ...]) -> list[str]:
        captions = "\n".join(f"{number}. {still['caption']}" for number, still in chunk)
        question = prompt("review-design", captions=captions, sets=storyboard_sets(board), cast=storyboard_cast(board), research=research)
        return await review_stills(services, question, [Path(still["path"]) for _, still in chunk], calls)

    verdicts = await asyncio.gather(*(review(chunk) for chunk in batched(numbered, STILLS_PER_REVIEW)))
    return [problem for problems in verdicts for problem in problems]


async def design(services: Services, workspace: Workspace) -> dict:
    board = workspace.read("storyboard")
    engine = Engine(services.settings)
    catalog = await engine.catalog(workspace.sheets / "catalog")
    research = json.dumps(workspace.read("research"), indent=1, ensure_ascii=False)
    shots = "\n".join(
        f"- {shot['id']} on {shot['set']}, {', '.join(member['role'] for member in shot['cast']) or 'nobody'}: {shot['action']}" for shot in board["shots"]
    )
    question = prompt(
        "design",
        format=shot_format(),
        catalog=json.dumps(catalog, indent=1, ensure_ascii=False),
        sets=storyboard_sets(board),
        cast=storyboard_cast(board),
        shots=shots,
        research=research,
    )
    calls: list[CallStats] = []

    async def check(candidate: dict) -> list[str]:
        problems = design_problems(candidate, board)
        if problems:
            return problems
        report = await engine.run({"mode": "sheet", "out": str(workspace.sheets), "design": candidate})
        if report["errors"] or report["problems"]:
            return report["errors"] + report["problems"]
        return await review_sheet(services, board, research, report["stills"], calls)

    result = await answer(services, workspace, "design", Job.FILM_DESIGN, question, check, calls=calls)
    workspace.write("design.json", result)
    return result
