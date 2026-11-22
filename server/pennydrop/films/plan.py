from __future__ import annotations

import json
import re

from ..services import Services
from ..settings import Job
from .ask import answer, craft, prompt
from .audit import audit_problems, cue_problems, text_too_small, tight_edges
from .document import FilmError
from .render import film_tool, theme_identity
from .voices import speak_film
from .workspace import Workspace

FENCE = re.compile(r"^```\w*\n|\n```\s*$")
WORD_PARTS = re.compile(r"[^\W_]+")
CLOSER_VIEW = {None: "close", "wide": "fit", "fit": "close"}
FARTHER_VIEW = {None: "wide", "close": "fit", "fit": "wide"}
MEND_PASSES = 4


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
        if shot["shot"] >= len(moves) or moves[shot["shot"]].get("go") != shot["object"]:
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


def as_jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


def plan_problems(services: Services, workspace: Workspace, rows: list[dict], script: dict, brief: dict, voices: list[dict]) -> list[str]:
    try:
        planned = with_script(rows, script, brief)
    except FilmError as error:
        return [str(error)]
    planned = planned[:1] + [in_narration_order(row) for row in planned[1:]]
    try:
        moved_closer: set[int] = set()
        for _ in range(MEND_PASSES):
            workspace.film.write_text(as_jsonl(planned))
            workspace.voiced_film.write_text(as_jsonl(planned[:1] + [{**row, "voice": voice} for row, voice in zip(planned[1:], voices, strict=True)]))
            manifest = json.loads(film_tool(services, "plan", "--film", str(workspace.voiced_film), capture=True).stdout)
            audit = json.loads(film_tool(services, "audit", "--film", str(workspace.voiced_film), capture=True).stdout)
            if not adjusted_views(planned, audit, moved_closer):
                break
    except FilmError as error:
        return [str(error)]
    return cue_problems(manifest) + audit_problems(audit)


async def plan(services: Services, workspace: Workspace) -> dict:
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
    await answer(services, workspace, "plan", Job.FILM_PLAN, question, lambda rows: plan_problems(services, workspace, rows, script, brief, voices), parse=film_rows, timeout=1800.0)
    manifest = json.loads(film_tool(services, "plan", "--film", str(workspace.voiced_film), capture=True).stdout)
    summary = {"lines": len(script["scenes"]), "duration": manifest["duration"], "cues": len(manifest["cues"])}
    workspace.write("plan.json", summary)
    return summary
