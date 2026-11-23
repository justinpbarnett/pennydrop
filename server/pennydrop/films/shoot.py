from __future__ import annotations

import asyncio
import hashlib
import json
from itertools import groupby
from pathlib import Path

from ..gateway import GatewayError
from ..services import Services
from ..settings import Job
from ..store import CallStats
from .ask import answer, prompt, shot_format
from .blender import Engine, EngineError
from .document import FilmError
from .review import ReviewError, review_stills
from .storyboard import Shot, read_shots
from .workspace import Workspace

SHOT_ROUNDS = 5
SEQUENCES_AT_ONCE = 3


def take_key(design: dict, shot: Shot) -> str:
    """A take stays good while the design, the storyboard's shot and its place on the narration clock stay the same."""
    staged = {"design": design, "board": shot.board, "start": shot.start, "end": shot.end}
    return hashlib.sha256(json.dumps(staged, sort_keys=True).encode()).hexdigest()


def take_path(workspace: Workspace, shot: Shot) -> Path:
    return workspace.shots / f"{shot.id}.json"


def read_take(workspace: Workspace, design: dict, shot: Shot) -> tuple[dict, bool] | None:
    """The shot's accepted spec, and whether it is still current."""
    path = take_path(workspace, shot)
    if not path.exists():
        return None
    take = json.loads(path.read_text())
    return take["spec"], take["key"] == take_key(design, shot)


def preview_job(workspace: Workspace, design: dict, shot: Shot, spec: dict) -> dict:
    return {"mode": "preview", "out": str(workspace.shots / shot.id), "design": design, "shot": spec, "words": shot.local_words(), "duration": round(shot.seconds, 3)}


def board_summary(shot: Shot) -> str:
    board = shot.board
    cast = ", ".join(member["role"] + (f" ({member['look']})" if member.get("look") else "") for member in board["cast"]) or "nobody"
    return (
        f"Shot {shot.id}, {shot.start:.1f} to {shot.end:.1f} s of the Film, on set {board['set']}, size {board['size']}.\n"
        f"Cast: {cast}. Subject: {', '.join(board['subject']) or 'the place'}.\n"
        f"Action: {board['action']}\nCamera: {board['camera']}\nShows: {board['shows']}"
    )


def words_table(shot: Shot) -> str:
    return "\n".join(f"{word['start']:6.2f} to {word['end']:6.2f}  {word['word']}" for word in shot.local_words())


def static_problems(spec: dict, shot: Shot) -> list[str]:
    problems = []
    if spec.get("set") != shot.board["set"]:
        problems.append(f'the storyboard puts this shot on set "{shot.board["set"]}", not "{spec.get("set")}"')
    if spec.get("size") != shot.board["size"]:
        problems.append(f'the storyboard makes this a {shot.board["size"]} shot, not "{spec.get("size")}"')
    return problems


def worn_looks(design: dict, spec: dict) -> dict:
    characters = design.get("characters", {})
    names = {person.get("look") or characters.get(person.get("character"), {}).get("look") for person in spec.get("people", [])}
    names |= {look for crowd in spec.get("crowds", []) for look in crowd.get("looks", [])}
    return {name: design["looks"][name] for name in sorted(filter(None, names)) if name in design.get("looks", {})}


class Director:
    """Stages every shot of a Film: a writer drafts each shot's spec, the engine checks and previews it, and a reviewer judges the stills."""

    def __init__(self, services: Services, workspace: Workspace, engine: Engine, catalog: str, shots: list[Shot]):
        self._services = services
        self._workspace = workspace
        self._engine = engine
        self._catalog = catalog
        self._design = workspace.read("design")
        self._overview = "\n".join(f"- {shot.id} ({shot.start:.1f} to {shot.end:.1f} s) on {shot.board['set']}, {shot.board['size']}: {shot.board['shows']}" for shot in shots)

    async def stage_sequence(self, sequence: list[Shot], following: Shot | None) -> list[str]:
        """Stages consecutive shots on one set in order, each matching the one before; returns the shots that failed."""
        failures, before = [], None
        for shot, after in zip(sequence, [*sequence[1:], following], strict=True):
            try:
                before = await self.stage(shot, before, after)
            except (FilmError, EngineError, ReviewError, GatewayError) as error:
                failures.append(f"{shot.id}: {error}")
                before = None
        return failures

    async def stage(self, shot: Shot, before: dict | None, after: Shot | None) -> dict:
        taken = read_take(self._workspace, self._design, shot)
        if taken is not None and taken[1]:
            return taken[0]
        question = prompt(
            "shot",
            format=shot_format(),
            catalog=self._catalog,
            design=json.dumps(self._design, indent=1, ensure_ascii=False),
            overview=self._overview,
            board=board_summary(shot),
            seconds=f"{shot.seconds:.2f}",
            words=words_table(shot),
            previous="## The shot before\n\nOn the same set, staged like this:\n\n```json\n" + json.dumps(before, indent=1, ensure_ascii=False) + "\n```" if before else "",
            following=f"## The shot after\n\n{board_summary(after)}" if after else "",
        )
        calls: list[CallStats] = []

        async def check(spec: dict) -> list[str]:
            problems = static_problems(spec, shot)
            if problems:
                return problems
            report = await self._engine.run(preview_job(self._workspace, self._design, shot, spec))
            if report["errors"] or report["problems"]:
                return report["errors"] + report["problems"]
            captions = "\n".join(f"{number}. at {still['time']:.1f} s: {still['caption']}" for number, still in enumerate(report["stills"], start=1))
            review = prompt(
                "review-shot",
                captions=captions,
                board=board_summary(shot),
                words=words_table(shot),
                looks=json.dumps(worn_looks(self._design, spec), indent=1, ensure_ascii=False),
            )
            return await review_stills(self._services, review, [Path(still["path"]) for still in report["stills"]], calls)

        spec = await answer(
            self._services,
            self._workspace,
            f"shot {shot.id}",
            Job.FILM_SHOT,
            question,
            check,
            previous=json.dumps(taken[0]) if taken else None,
            rounds=SHOT_ROUNDS,
            rejected=self._workspace.shots / f"{shot.id}.rejected.txt",
            calls=calls,
        )
        take_path(self._workspace, shot).write_text(json.dumps({"key": take_key(self._design, shot), "spec": spec}, indent=1, ensure_ascii=False) + "\n")
        return spec


async def shoot(services: Services, workspace: Workspace) -> dict:
    shots = read_shots(workspace)
    workspace.shots.mkdir(parents=True, exist_ok=True)
    engine = Engine(services.settings)
    catalog = json.dumps(await engine.catalog(workspace.shots / "catalog"), indent=1, ensure_ascii=False)
    director = Director(services, workspace, engine, catalog, shots)
    sequences = [list(group) for _, group in groupby(shots, key=lambda shot: shot.board["set"])]
    followers = [sequence[0] for sequence in sequences[1:]] + [None]
    slots = asyncio.Semaphore(SEQUENCES_AT_ONCE)

    async def staged(sequence: list[Shot], following: Shot | None) -> list[str]:
        async with slots:
            return await director.stage_sequence(sequence, following)

    outcomes = await asyncio.gather(*(staged(sequence, following) for sequence, following in zip(sequences, followers, strict=True)))
    failures = [failure for outcome in outcomes for failure in outcome]
    if failures:
        raise FilmError(f"{len(failures)} of {len(shots)} shots are not staged yet; run the shoot stage again to retry them:\n" + "\n".join(f"- {failure}" for failure in failures))
    return {"shots": len(shots)}
