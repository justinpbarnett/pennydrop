from __future__ import annotations

import json
import re
from typing import Any

from ..services import Services
from ..settings import Job
from ..store import CallStats
from .ask import answer, craft, prompt
from .audit import (
    audit_problems,
    cue_problems,
    settles,
    silence_problems,
    staging_problems,
    text_too_small,
    tight_edges,
)
from .document import FilmError
from .render import film_tool, theme_identity
from .truth import untrue_map_events
from .voices import speak_film
from .workspace import Workspace

FENCE = re.compile(r"^```\w*\n|\n```\s*$")
WORD_PARTS = re.compile(r"[^\W_]+")
CLOSER_VIEW = {None: "close", "wide": "fit", "fit": "close"}
FARTHER_VIEW = {None: "wide", "close": "fit", "fit": "wide"}
MEND_PASSES = 4
NUMBER_WORDS = (
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    " twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion"
)
SPELLED_NUMBER = re.compile(r"\b(?:" + "|".join(NUMBER_WORDS.split()) + r")(?:[\s-]+(?:" + "|".join(NUMBER_WORDS.split()) + r"))+\b", re.IGNORECASE)
SPOKEN_KEYS = {"say", "cue", "spine", "voice"}


def catalog(services: Services) -> str:
    return film_tool(services, "--md", "--film", capture=True, tool="player/tools/catalog.ts").stdout


def film_rows(text: str) -> list[dict]:
    rows = []
    for number, raw in enumerate(FENCE.sub("", text.strip()).splitlines(), 1):
        if not raw.strip():
            continue
        try:
            rows.append(json.loads(raw))
        except json.JSONDecodeError as error:
            raise FilmError(f"line {number} of the answer is not valid JSON: {error}") from error
    return rows


def with_script(rows: list[dict], script: dict, brief: dict) -> list[dict]:
    if not rows or "film" not in rows[0]:
        raise FilmError('the first line must be the {"film": ...} header')
    scenes = script["scenes"]
    lines = rows[1:]
    if len(lines) != len(scenes):
        raise FilmError(f"the script has {len(scenes)} scenes and the answer has {len(lines)} lines; make one line for each scene")
    header = {**rows[0]["film"], "title": script["title"], "theme": brief["theme"], "thread": brief["thread"], "armature": script["armature"], "spine": script["spine"]}
    return [{"film": header}] + [{**line, "line": number, "spine": scene["spine"], "say": scene["say"]} for number, (line, scene) in enumerate(zip(lines, scenes, strict=True), 1)]


def word_parts(text: str) -> list[tuple[str, int]]:
    return [(part.lower(), index) for index, token in enumerate(text.split()) for part in WORD_PARTS.findall(token)]


def locate(say_parts: list[tuple[str, int]], cue: str) -> tuple[int, int] | None:
    wanted = [part for part, _ in word_parts(cue)]
    spoken = [part for part, _ in say_parts]
    for start in range(len(spoken) - len(wanted) + 1):
        if wanted and spoken[start : start + len(wanted)] == wanted:
            return say_parts[start][1], say_parts[start + len(wanted) - 1][1]
    return None


def in_narration_order(row: dict) -> dict:
    say = row.get("say", "")
    say_tokens = say.split()
    say_parts = word_parts(say)
    mended = dict(row)
    for key in ("do", "camera", "sound"):
        entries = row.get(key)
        if not isinstance(entries, list):
            continue
        placed = []
        for position, entry in enumerate(entries):
            where = locate(say_parts, entry["cue"]) if isinstance(entry, dict) and isinstance(entry.get("cue"), str) else None
            if where:
                entry = {**entry, "cue": " ".join(say_tokens[where[0] : where[1] + 1]).strip(".,;:!?\"")}
            placed.append((where[0] if where else position, position, entry))
        mended[key] = [entry for _, _, entry in sorted(placed, key=lambda item: item[:2])]
    return mended


def adjusted_views(rows: list[dict], audit: list[dict], moved_closer: set[int]) -> bool:
    moves = [move for row in rows[1:] for move in row.get("camera", []) if isinstance(move, dict)]
    changed = False
    for shot in audit:
        if shot["shot"] >= len(moves) or moves[shot["shot"]].get("go") != shot["object"] or not settles(shot):
            continue
        move = moves[shot["shot"]]
        view = move.get("view")
        too_small = text_too_small(shot)
        too_tight = bool(tight_edges(shot))
        if (too_small or shot["peeking"]) and not too_tight and view != "close":
            move["view"] = CLOSER_VIEW.get(view, "close")
            moved_closer.add(shot["shot"])
            changed = True
        elif too_tight and shot["shot"] not in moved_closer and view != "wide":
            move["view"] = FARTHER_VIEW.get(view, "wide")
            changed = True
    return changed


def shown_texts(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in shown_texts(item)]
    if isinstance(value, dict):
        return [text for key, item in value.items() if key not in SPOKEN_KEYS for text in shown_texts(item)]
    return []


def spelled_numbers(rows: list[dict]) -> list[str]:
    return [
        f"line {row.get('line')}: the on-screen text {text!r} spells out {found.group()!r}; write numbers, years and amounts as digits on screen, such as 1795, 42 or 1,562, and spell them only in say and cues"
        for row in rows[1:]
        for text in shown_texts(row)
        for found in SPELLED_NUMBER.finditer(text)
        if not found.group().istitle()
    ]


def as_jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


def plan_problems(services: Services, workspace: Workspace, rows: list[dict], script: dict, brief: dict, voices: list[dict]) -> list[str]:
    try:
        planned = with_script(rows, script, brief)
    except FilmError as error:
        return [str(error)]
    planned = planned[:1] + [in_narration_order(row) for row in planned[1:]]
    found = spelled_numbers(planned) + staging_problems(planned)
    try:
        moved_closer: set[int] = set()
        for _ in range(MEND_PASSES):
            voiced = planned[:1] + [{**row, "voice": voice} for row, voice in zip(planned[1:], voices, strict=True)]
            workspace.film.write_text(as_jsonl(planned))
            workspace.voiced_film.write_text(as_jsonl(voiced))
            manifest = json.loads(film_tool(services, "plan", "--film", str(workspace.voiced_film), capture=True).stdout)
            audit = json.loads(film_tool(services, "audit", "--film", str(workspace.voiced_film), capture=True).stdout)
            if not adjusted_views(planned, audit, moved_closer):
                break
    except FilmError as error:
        return [*found, str(error)]
    return found + silence_problems(voiced, manifest) + cue_problems(manifest) + audit_problems(audit)


async def plan(services: Services, workspace: Workspace) -> dict:
    return await planned_film(services, workspace, "plan")


async def revise(services: Services, workspace: Workspace) -> dict:
    if not workspace.film.exists():
        raise FilmError(f"{workspace.film} is missing; run the plan stage first, then revise it")
    return await planned_film(services, workspace, "revise", previous=workspace.film.read_text())


async def planned_film(services: Services, workspace: Workspace, stage: str, previous: str | None = None) -> dict:
    brief = workspace.brief()
    script = workspace.read("script")
    question = prompt(
        "plan",
        script=json.dumps(script, indent=1, ensure_ascii=False),
        craft=craft(),
        catalog=catalog(services),
        theme=brief["theme"],
        thread=brief["thread"],
    )
    voice = theme_identity(services, brief["theme"])["voice"]
    spoken = await speak_film(services.speaker, services.settings.tts_provider, voice, [scene["say"] for scene in script["scenes"]])
    voices = [line.voice.for_player() for line in spoken]
    judge_calls: list[CallStats] = []

    async def problems(rows: list[dict]) -> list[str]:
        return plan_problems(services, workspace, rows, script, brief, voices) or await untrue_map_events(services, with_script(rows, script, brief), judge_calls)

    try:
        await answer(services, workspace, stage, Job.FILM_PLAN, question, problems, parse=film_rows, timeout=1800.0, previous=previous)
    finally:
        if judge_calls:
            workspace.record(f"{stage} map check", judge_calls)
    manifest = json.loads(film_tool(services, "plan", "--film", str(workspace.voiced_film), capture=True).stdout)
    summary = {"lines": len(script["scenes"]), "duration": manifest["duration"], "cues": len(manifest["cues"])}
    workspace.write("plan.json", summary)
    return summary
