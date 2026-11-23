"""The vocabulary a writer may use, read out of the registries the engine itself runs on.

Library props are built once in a showroom, so their sizes and point names are measured, not written down.
"""

import math

from . import scenery
from .actions import ACTIONS
from .camera import SIZES
from .effects import EFFECTS
from .format import (
    BEAT,
    CAMERA,
    CROWD,
    EVENT,
    PART_MOVES,
    PERSON,
    read_design,
    read_shot,
)
from .paint import COLORS, FINISHES
from .performance import FORMATIONS, POINTS
from .pose import pose_key_names
from .props import HELD, PATTERNS, PIECE_ACTIONS, PIECES, PRIMITIVES, CustomProp
from .spec import Reading, describe_keys
from .staging import stage_shot
from .wardrobe import BUILDS, FACIAL_HAIR, GARMENTS, GLASSES, HAIR, HATS
from .where import SIDES_OF

SHOWROOM_GAP = 70.0


def _entries(registry, *facts):
    """Each entry of a registry: what it is, the options it takes, and the facts a writer needs."""
    described = {}
    for name, entry in registry.entries.items():
        described[name] = {"about": entry.about}
        if entry.options:
            described[name]["options"] = describe_keys(entry.options)
        described[name].update({fact: entry.facts[fact] for fact in facts if entry.facts.get(fact)})
    return described


def _abouts(registry):
    return {name: entry.about for name, entry in registry.entries.items()}


def _showroom():
    """Every library prop built with its defaults, far enough apart that none touches another."""
    kinds = PIECES.names()
    side = math.ceil(math.sqrt(len(kinds)))
    pieces = [{"id": kind, "kind": kind, "position": [(index % side) * SHOWROOM_GAP, (index // side) * SHOWROOM_GAP]} for index, kind in enumerate(kinds)]
    raw_design = {"sets": {"showroom": {"bounds": [-SHOWROOM_GAP, -SHOWROOM_GAP, side * SHOWROOM_GAP, side * SHOWROOM_GAP], "pieces": pieces}}}
    reading = Reading()
    design = read_design(raw_design, reading)
    shot = read_shot({"set": "showroom", "subject": [kinds[0]], "size": "wide"}, raw_design, reading)
    staged = stage_shot(design, shot, [], 1.0, 24, reading) if design and shot else None
    if staged is None:
        raise RuntimeError("the showroom of library props does not stage: " + "; ".join(reading.errors))
    return staged.stage.pieces


def _props():
    described = _entries(PIECES)
    for kind, piece in _showroom().items():
        described[kind]["size"] = [round(length, 2) for length in piece.size]
        if kind in HELD:
            described[kind]["held"] = True
        if piece.point_names():
            described[kind]["points"] = piece.point_names()
        if PIECE_ACTIONS[kind].entries:
            described[kind]["actions"] = _entries(PIECE_ACTIONS[kind])
    return described


def _event_kinds():
    heard = {kind for entry in ACTIONS.entries.values() for _, kind in entry.facts["sounds"]}
    heard.update(name for name, entry in ACTIONS.entries.items() if entry.facts["kind"] == "locomotion")
    heard.update(entry.facts["sound"] or name for actions in PIECE_ACTIONS.values() for name, entry in actions.entries.items())
    return sorted(heard | set(PART_MOVES) | set(EFFECTS.names()) | {"sky"})


def describe():
    """The whole catalog. Call it in a fresh scene: it builds the showroom."""
    return {
        "actions": _entries(ACTIONS, "kind", "overlay", "seconds", "speed", "rides"),
        "gaits": {name: entry.facts["speed"] for name, entry in ACTIONS.entries.items() if entry.facts["kind"] == "locomotion"},
        "joint_angles": pose_key_names(),
        "person_points": list(POINTS),
        "sides": SIDES_OF,
        "formations": _abouts(FORMATIONS),
        "garments": _entries(GARMENTS),
        "hats": _abouts(HATS),
        "hair": _abouts(HAIR),
        "facial_hair": _abouts(FACIAL_HAIR),
        "glasses": GLASSES,
        "builds": _abouts(BUILDS),
        "props": _props(),
        "part_moves": {name: describe_keys({key: entry if isinstance(entry, tuple) else (entry, None) for key, entry in keys.items()}) for name, keys in PART_MOVES.items()},
        "custom_prop": CustomProp().describe(),
        "primitives": _entries(PRIMITIVES, "sizes"),
        "finishes": _abouts(FINISHES),
        "colors": list(COLORS),
        "flag_patterns": _abouts(PATTERNS),
        "ground_features": _entries(scenery.FEATURES),
        "ground_covers": _abouts(scenery.COVERS),
        "waters": _abouts(scenery.WATERS),
        "room": scenery.ROOM.describe(),
        "skies": _abouts(scenery.SKIES),
        "weather": _abouts(scenery.WEATHER),
        "effects": _entries(EFFECTS),
        "shot_sizes": {name: {"about": entry.about, "subject_fills_at_least": entry.facts["least"]} for name, entry in SIZES.entries.items()},
        "beat": BEAT.describe(),
        "event": EVENT.describe(),
        "person": PERSON.describe(),
        "crowd": CROWD.describe(),
        "camera": CAMERA.describe(),
        "event_kinds": _event_kinds(),
    }
