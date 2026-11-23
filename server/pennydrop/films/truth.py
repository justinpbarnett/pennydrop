from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..services import Services
from ..settings import Job
from ..store import CallStats
from .ask import json_in, prompt
from .document import FilmError

EVENT_OPS = ("go", "march", "clash", "surrender")
JUDGE_ATTEMPTS = 2


@dataclass(frozen=True)
class MapEvent:
    id: str
    line: int
    text: str
    given: bool


def added_objects(row: dict) -> list[tuple[str, dict]]:
    scene = row.get("scene") if isinstance(row.get("scene"), dict) else {}
    created = [(op["on"][0], op["spec"]) for op in row.get("do", []) if op.get("op") == "create" and op.get("on") and isinstance(op.get("spec"), dict)]
    return [(object_id, spec) for object_id, spec in [*scene.items(), *created] if isinstance(spec, dict)]


def place_names(spec: dict) -> list[str]:
    return [place["name"] for place in spec["places"]]


def place_index(spec: dict, value: Any) -> int:
    return value if isinstance(value, int) else place_names(spec).index(value)


def place_name(spec: dict, value: Any) -> str:
    return place_names(spec)[place_index(spec, value)]


def journey(cue: str, names: list[str], reached: int, to: int) -> list[tuple[str, bool]]:
    told = [(f"{cue}, the story's traveler is at {names[0]}, where the journey on this map starts", True)] if reached == 0 else []
    path = names[max(reached, 1) - 1 : to + 1]
    if len(path) > 1:
        by_way = f" by way of {', '.join(path[1:-1])}" if len(path) > 2 else ""
        told.append((f"{cue}, the story's traveler goes from {path[0]} to {path[-1]}{by_way}", False))
    return told


def army_of(target: str) -> str:
    return target.partition("[")[2].rstrip("]")


def army_label(spec: dict, army: str) -> str:
    return spec.get("armies", {}).get(army, {}).get("label", army)


def map_events(rows: list[dict]) -> list[MapEvent]:
    maps: dict[str, dict] = {}
    journeys: dict[str, int] = {}
    armies: dict[tuple[str, str], str] = {}
    events: list[MapEvent] = []
    for row in rows[1:]:
        told: list[tuple[str, bool]] = []
        for object_id, spec in added_objects(row):
            if spec.get("kind") != "map":
                continue
            maps[object_id] = spec
            for army_id, army in spec.get("armies", {}).items():
                armies[(object_id, army_id)] = place_name(spec, army["at"])
                told.append((f"the map {object_id} opens with the force \"{army['label']}\" standing at {armies[(object_id, army_id)]}", True))
        for op in row.get("do", []):
            map_id = str(op.get("on", [""])[0]).partition("[")[0]
            spec = maps.get(map_id)
            if op.get("op") not in EVENT_OPS or spec is None:
                continue
            cue = f'on "{op["cue"]}"'
            if op["op"] == "march":
                army = army_of(op["on"][0])
                to = place_name(spec, op["to"])
                told.append((f"{cue}, the force \"{army_label(spec, army)}\" marches from {armies.get((map_id, army), 'where it stands')} to {to}", False))
                armies[(map_id, army)] = to
            elif op["op"] == "clash":
                told.append((f"{cue}, a battle is fought at {place_name(spec, op['at'])}", False))
            elif op["op"] == "surrender":
                told.append((f"{cue}, {place_name(spec, op['at'])} surrenders", False))
            else:
                to = place_index(spec, op["to"])
                told += journey(cue, place_names(spec), journeys.get(map_id, 0), to)
                journeys[map_id] = to + 1
        events += [MapEvent(f"{row['line']}.{index}", row["line"], text, given) for index, (text, given) in enumerate(told, start=1)]
    return events


def words(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def untrue_answer(answer: dict, events: list[MapEvent], narration: str) -> list[tuple[MapEvent, str]]:
    verdicts = answer.get("events")
    by_id = {verdict.get("id"): verdict for verdict in verdicts if isinstance(verdict, dict)} if isinstance(verdicts, list) else {}
    missing = [event.id for event in events if event.id not in by_id]
    if missing:
        raise FilmError(f'the map check answer needs one entry in "events" for every event id, and it left out {", ".join(missing)}')
    untrue = []
    for event in events:
        verdict = by_id[event.id]
        if not isinstance(verdict.get("told"), bool) or not isinstance(verdict.get("words"), str) or not verdict.get("why"):
            raise FilmError(f'the map check answer for event {event.id} needs "told" as true or false, "words" as text and "why"')
        quoted = words(verdict["words"])
        if verdict["told"] and not event.given and (not quoted or f" {quoted} " not in f" {narration} "):
            raise FilmError(f'the map check answer says event {event.id} is told, so its "words" must copy the narration that tells it exactly')
        if not verdict["told"]:
            untrue.append((event, verdict["why"].strip().rstrip(".")))
    return untrue


async def untrue_map_events(services: Services, rows: list[dict], calls: list[CallStats]) -> list[str]:
    events = map_events(rows)
    if not events:
        return []
    question = prompt(
        "truth",
        narration="\n\n".join(f"Line {row['line']}: {row['say']}" for row in rows[1:]),
        events="\n".join(f"- {event.id} (line {event.line}): {event.text}" for event in events),
    )
    narration = words(" ".join(row["say"] for row in rows[1:]))
    problem = ""
    for _ in range(JUDGE_ATTEMPTS):
        completion = await services.gateway.complete(Job.FILM_FACTCHECK, question, timeout=600.0)
        calls.append(completion.stats)
        try:
            return [
                f"line {event.line}: the map shows that {event.text}, which the narration does not tell ({why}); draw on a map only what the narration says happened, show a place that gives up with 'surrender' rather than a move, and act anything else, such as a plan or a report, on a stage"
                for event, why in untrue_answer(json_in(completion.text), events, narration)
            ]
        except FilmError as error:
            problem = str(error)
    raise RuntimeError(f"the map check gave no usable answer in {JUDGE_ATTEMPTS} tries: {problem}")
