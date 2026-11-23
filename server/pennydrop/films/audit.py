from __future__ import annotations

from collections import Counter
from collections.abc import Iterator

CUE_TOLERANCE_SECONDS = 0.033
EDGE_MARGIN = 40
SMALLEST_READABLE_TEXT = 26
LONGEST_UNFILLED_WAIT = 4
LINES_PER_CARD = 4
CARD_KINDS = {"keyword", "quote", "counter", "compare", "tracker", "timeline", "text"}
ACTING_KINDS = {"stage", "map"}


def tight_edges(shot: dict) -> list[str]:
    return [edge for edge in ("top", "bottom", "left", "right") if shot[edge] is not None and shot[edge] < EDGE_MARGIN]


def text_too_small(shot: dict) -> bool:
    return shot["smallestText"] is not None and shot["smallestText"] < SMALLEST_READABLE_TEXT


def audit_problems(audit: list[dict]) -> list[str]:
    problems = []
    for shot in audit:
        where = f"camera shot {shot['shot']} at {shot['at']:.0f} s on {shot['object']}"
        if tight := tight_edges(shot):
            problems.append(f"{where}: the card ends with under {EDGE_MARGIN} px of room at its {', '.join(tight)}, so it is cut off or touches the frame edge; use a smaller view or reshape the card")
        if text_too_small(shot):
            problems.append(f"{where}: its smallest text is {shot['smallestText']:.1f} px high on screen, under the {SMALLEST_READABLE_TEXT} px that reads; fly closer or split the card")
        if shot["peeking"]:
            problems.append(f"{where}: {', '.join(shot['peeking'])} peek into the frame at its edge; place the object farther from them along the route, or place the older pieces behind the route")
        if shot["wait"] is not None and shot["wait"] > LONGEST_UNFILLED_WAIT:
            problems.append(f"{where}: the camera arrives {shot['wait']:.0f} s before the first operation on {shot['object']}, so the viewer watches an unfilled piece; cue the camera move on a word nearer that operation, so the piece fills as the camera lands")
    return problems


def cue_problems(manifest: dict) -> list[str]:
    return [cue_problem(cue) for cue in manifest["cues"] if cue["cue"] and cue["wordStart"] is not None and abs(cue["opStart"] - cue["wordStart"]) > CUE_TOLERANCE_SECONDS]


def cue_problem(cue: dict) -> str:
    where = f"line {cue['line']}: the {cue['kind']} {cue['op']!r} cued on {cue['cue']!r}"
    late = cue["opStart"] - cue["wordStart"]
    if late > 0:
        return (
            f"{where} starts {late:.1f} s after its word, because it waits for an earlier op to end: an op that runs in real time holds later ops on the same people until it ends, such as a walk on a stage,"
            " and one on a Lab holds every later op. Cue this op on a later word, or make the earlier op shorter"
        )
    return f"{where} starts {-late * 1000:.0f} ms before its word"


def staging_problems(rows: list[dict]) -> list[str]:
    lines = rows[1:]
    specs: dict[str, dict] = {}
    carded: list[int] = []
    problems: list[str] = []
    for row in lines:
        added = dict(added_objects(row))
        specs.update(added)
        if any(spec.get("kind") in CARD_KINDS for spec in added.values()):
            carded.append(row["line"])
        targets = [(entry, target) for entry in row.get("do", []) if isinstance(entry, dict) for target in entry.get("on", []) if isinstance(target, str)]
        if row is not lines[-1] and not any(acts(specs.get(owner(target), {})) for _, target in targets):
            problems.append(f"line {row['line']}: nothing happens on screen; give it an op on a stage, a map or a Lab that acts out what the narration says")
        doubled = Counter((entry.get("cue"), target) for entry, target in targets if specs.get(owner(target), {}).get("kind") == "stage")
        problems += [
            f"line {row['line']}: {target} has {count} ops on the cue {cue!r}; a person does one thing on a word, so give a walk its \"pose\" instead of a second op, or cue the second op on a later word"
            for (cue, target), count in doubled.items()
            if count > 1
        ]
    allowed = len(lines) // LINES_PER_CARD
    if len(carded) > allowed:
        problems.append(
            f"lines {', '.join(map(str, carded))} add cards, {len(carded)} in all, and a Film of {len(lines)} lines may add at most {allowed}; act the rest out on a stage, a map or a Lab"
        )
    return problems


def added_objects(row: dict) -> Iterator[tuple[str, dict]]:
    scene = row.get("scene")
    if isinstance(scene, dict):
        yield from ((object_id, spec) for object_id, spec in scene.items() if isinstance(spec, dict))
    for entry in row.get("do", []):
        if isinstance(entry, dict) and entry.get("op") == "create" and isinstance(entry.get("spec"), dict) and entry.get("on"):
            yield owner(entry["on"][0]), entry["spec"]


def owner(target: str) -> str:
    return target.split("[", 1)[0]


def acts(spec: dict) -> bool:
    return "lab" in spec or spec.get("kind") in ACTING_KINDS
