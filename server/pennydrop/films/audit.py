from __future__ import annotations

CUE_TOLERANCE_SECONDS = 0.033
EDGE_MARGIN = 40
SMALLEST_READABLE_TEXT = 26
LONGEST_UNFILLED_WAIT = 4


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
            problems.append(f"{where}: its smallest text is {shot['smallestText']:.0f} px high on screen, too small to read; fly closer or split the card")
        if shot["peeking"]:
            problems.append(f"{where}: {', '.join(shot['peeking'])} peek into the frame at its edge; place the object farther from them along the route, or place the older pieces behind the route")
        if shot["wait"] is not None and shot["wait"] > LONGEST_UNFILLED_WAIT:
            problems.append(f"{where}: the camera arrives {shot['wait']:.0f} s before the first operation on {shot['object']}, so the viewer watches an unfilled piece; cue the camera move on a word nearer that operation, so the piece fills as the camera lands")
    return problems


def cue_problems(manifest: dict) -> list[str]:
    return [
        f"line {cue['line']}: the {cue['kind']} {cue['op']!r} cued on {cue['cue']!r} starts {abs(cue['opStart'] - cue['wordStart']) * 1000:.0f} ms from its word"
        for cue in manifest["cues"]
        if cue["cue"] and cue["wordStart"] is not None and abs(cue["opStart"] - cue["wordStart"]) > CUE_TOLERANCE_SECONDS
    ]
