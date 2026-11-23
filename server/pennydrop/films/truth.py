from __future__ import annotations

from typing import Any

from ..services import Services
from ..settings import Job
from ..store import CallStats
from .ask import json_in, prompt
from .document import FilmError

EVENT_OPS = ("go", "march", "clash")
JUDGE_ATTEMPTS = 2


def added_objects(row: dict) -> list[tuple[str, dict]]:
    scene = row.get("scene") if isinstance(row.get("scene"), dict) else {}
    created = [(op["on"][0], op["spec"]) for op in row.get("do", []) if op.get("op") == "create" and op.get("on") and isinstance(op.get("spec"), dict)]
    return [(object_id, spec) for object_id, spec in [*scene.items(), *created] if isinstance(spec, dict)]


def place_name(spec: dict, value: Any) -> str:
    return spec["places"][value]["name"] if isinstance(value, int) else str(value)


def starts_journey(spec: dict, value: Any) -> bool:
    return value == 0 or value == spec["places"][0]["name"]


def army_label(spec: dict, target: str) -> str:
    army = target.partition("[")[2].rstrip("]")
    return spec.get("armies", {}).get(army, {}).get("label", army)


def map_events(rows: list[dict]) -> dict[int, list[str]]:
    maps: dict[str, dict] = {}
    events: dict[int, list[str]] = {}
    for row in rows[1:]:
        told = []
        for object_id, spec in added_objects(row):
            if spec.get("kind") != "map":
                continue
            maps[object_id] = spec
            told += [f"the map {object_id} opens with {army['label']} standing at {army['at']}" for army in spec.get("armies", {}).values()]
        for op in row.get("do", []):
            spec = maps.get(str(op.get("on", [""])[0]).partition("[")[0])
            if op.get("op") not in EVENT_OPS or spec is None:
                continue
            if op["op"] == "march":
                told.append(f'on "{op["cue"]}", {army_label(spec, op["on"][0])} marches to {place_name(spec, op["to"])}')
            elif op["op"] == "clash":
                told.append(f'on "{op["cue"]}", a battle bursts at {place_name(spec, op["at"])}')
            elif starts_journey(spec, op["to"]):
                told.append(f'on "{op["cue"]}", a journey is marked as starting at {place_name(spec, op["to"])}')
            else:
                told.append(f'on "{op["cue"]}", the journey line is drawn on to {place_name(spec, op["to"])}')
        if told:
            events[row["line"]] = told
    return events


def untrue_answer(answer: dict, lines: set[int]) -> list[dict]:
    untrue = answer.get("untrue")
    if not isinstance(untrue, list) or not all(isinstance(entry, dict) and entry.get("line") in lines and entry.get("event") and entry.get("why") for entry in untrue):
        raise FilmError('the map check answer needs "untrue" as a list of {"line", "event", "why"} for lines that draw map events')
    return untrue


async def untrue_map_events(services: Services, rows: list[dict], calls: list[CallStats]) -> list[str]:
    events = map_events(rows)
    if not events:
        return []
    question = prompt(
        "truth",
        narration="\n\n".join(f"Line {row['line']}: {row['say']}" for row in rows[1:]),
        events="\n\n".join(f"Line {line}:\n" + "\n".join(f"- {event}" for event in told) for line, told in events.items()),
    )
    problem = ""
    for _ in range(JUDGE_ATTEMPTS):
        completion = await services.gateway.complete(Job.FILM_FACTCHECK, question, timeout=600.0)
        calls.append(completion.stats)
        try:
            return [
                f"line {entry['line']}: the map shows that {entry['event']}, but {entry['why']}; draw on a map only what the narration says happened, and act a plan, a request or a report on a stage"
                for entry in untrue_answer(json_in(completion.text), set(events))
            ]
        except FilmError as error:
            problem = str(error)
    raise RuntimeError(f"the map check gave no usable answer in {JUDGE_ATTEMPTS} tries: {problem}")
