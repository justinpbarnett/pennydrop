"""The design and shot documents as fields: what a writer may say, and how each mistake is reported."""

from . import scenery
from .actions import ACTIONS, gaits
from .camera import SIZES
from .effects import EFFECTS
from .paint import Color, color
from .performance import FORMATIONS
from .pose import pose_key_names
from .props import CustomProp, held_field, piece_field
from .spec import (
    Choice,
    Identifier,
    Kinded,
    Many,
    Mapping,
    Number,
    OneOrMany,
    Reading,
    Record,
    Text,
    Vector,
    Whole,
    nearest,
    show,
)
from .wardrobe import BUILDS, FACIAL_HAIR, GARMENTS, GLASSES, HAIR, hat_field
from .where import Aim, Facing, Place

HAND = (Choice(["left", "right"], "hand"), "right")
PART_MOVES = {
    "slide": {"by": Vector(3), "seconds": (Number(0, 60), 0.6)},
    "rotate": {"by": Number(-1440, 1440), "axis": (Choice(["x", "y", "z"], "axis"), "z"), "seconds": (Number(0, 60), 0.6)},
    "show": {},
    "hide": {},
    "glow": {"color": (Color(), color("#ffd070")), "seconds": (Number(0, 60), 0.5)},
}
TIME = {"at": (Number(-30, 600), None), "cue": (Text(160), None), "nth": (Whole(1, 50), 1), "offset": (Number(-30, 30), 0.0)}


def filled(record):
    """A record with every key at its default."""
    return record.read({}, "", Reading())


class Timed:
    """An object with a time and exactly one verb; the verb's value decides which other keys it takes.

    verbs maps a verb to (field, keys), where keys(verb value, whole object) gives the verb's own keys.
    """

    def __init__(self, noun, verbs):
        self.noun, self.verbs = noun, verbs

    def read(self, value, path, reading):
        if not isinstance(value, dict):
            return reading.fail(path, f"expected an object, got {show(value)}")
        found = [verb for verb in self.verbs if verb in value]
        if len(found) != 1:
            return reading.fail(path, f"{self.noun} needs exactly one of: {', '.join(self.verbs)}; this one has {', '.join(found) or 'none'}")
        field, keys = self.verbs[found[0]]
        main = field.read(value[found[0]], f"{path}.{found[0]}", reading)
        if main is None:
            return None
        rest = {key: item for key, item in value.items() if key != found[0]}
        record = Record(**TIME, **keys(main, value)).read(rest, path, reading)
        if record is None:
            return None
        return {**record, "verb": found[0], found[0]: main, "path": path}

    def describe(self):
        return {"time": "at or cue, with nth and offset", "one of": {verb: field.describe() for verb, (field, keys) in self.verbs.items()}}


class Route:
    """A position to walk to, or a list of positions to walk along."""

    def read(self, value, path, reading):
        single = isinstance(value, list) and len(value) == 2 and all(isinstance(item, (int, float)) for item in value)
        return OneOrMany(Place(), least=1).read([value] if single else value, path, reading)

    def describe(self):
        return "position or list of positions"


class Released:
    """A target, or null to let go."""

    def read(self, value, path, reading):
        return False if value is None else Aim().read(value, path, reading)

    def describe(self):
        return "target or null"


class Angles:
    """A custom pose: joint angle names with degrees."""

    def read(self, value, path, reading):
        names = pose_key_names()
        if not isinstance(value, dict) or not value:
            return reading.fail(path, f"expected an object of joint angles such as {{\"elbowR\": 90}}, got {show(value)}")
        angles = {}
        for key, item in value.items():
            if key not in names:
                reading.fail(f"{path}.{key}", f"unknown joint angle; {nearest(key, names)}")
                angles = None
            elif angles is not None:
                angles[key] = Number(-360, 360).read(item, f"{path}.{key}", reading)
        return None if angles is None or None in angles.values() else angles

    def describe(self):
        return "object of joint angle names with degrees"


def _no_keys(main, value):
    return {}


def _action_keys(name, value):
    return ACTIONS[name].options


def _walk_keys(route, value):
    gait = value.get("gait", "walk")
    own = ACTIONS[gait].options if isinstance(gait, str) and gait in gaits() else {}
    return {"gait": (Choice(gaits, "gait"), "walk"), "then": (Kinded(ACTIONS, naming_key="do", bare_name=True), None), "seconds": (Number(0.1, 600), None), **own}


def _prop_keys(prop, value):
    if "part" not in value:
        # What a library prop can do depends on its kind, which only the built set knows; staging reads these options.
        return {key: (Anything(), None) for key in value if key not in TIME and key != "prop"} | {"do": Text(40)}
    move = value.get("do")
    return {"part": Text(60), "do": Choice(list(PART_MOVES), "part move"), **(PART_MOVES[move] if isinstance(move, str) and move in PART_MOVES else {})}


class Anything:
    def read(self, value, path, reading):
        return value

    def describe(self):
        return "depends on the prop's kind"


BEAT = Timed("a beat", {
    "do": (ACTIONS.choice(), _action_keys),
    "walk": (Route(), _walk_keys),
    "face": (Facing(), _no_keys),
    "look": (Released(), _no_keys),
    "pose": (Angles(), _no_keys),
    "reach": (Aim(), lambda main, value: {"arm": HAND, "seconds": (Number(0.3, 60), 1.5)}),
    "hold": (Identifier(), lambda main, value: {"hand": HAND}),
    "give": (Identifier(), lambda main, value: {"to": Identifier()}),
    "drop": (Identifier(), lambda main, value: {"onto": (Aim(), None)}),
    "wear": (Identifier(), lambda main, value: {"from": (Identifier(), None)}),
})  # fmt: skip
EVENT = Timed("an event", {
    "prop": (Identifier(), _prop_keys),
    "effect": (EFFECTS.choice(), lambda name, value: {"position": Aim(), **EFFECTS[name].options}),
    "sky": (scenery.SKY, lambda main, value: {"seconds": (Number(0, 60), 2.0)}),
})  # fmt: skip
STARTING_POSE = (Kinded(ACTIONS, naming_key="do", bare_name=True), {"do": "stand"})
PERSON = Record(
    id=(Identifier(), None), character=(Identifier(), None), look=(Identifier(), None), position=Place(), facing=(Facing(), None),
    pose=STARTING_POSE, beats=(Many(BEAT), []),
)  # fmt: skip
CROWD = Record(
    id=Identifier(), looks=Many(Identifier(), least=1), count=Whole(1, 150), formation=(FORMATIONS.choice(), "scatter"), position=Place(), facing=(Facing(), None),
    spacing=(Number(0.4, 20), 1.2), rows=(Whole(1, 20), 2), stagger=(Number(0, 5), 0.25), pose=STARTING_POSE, beats=(Many(BEAT), []),
)  # fmt: skip
CAMERA_KEY = Record(
    **TIME, targets=Many(Aim(), least=1), bearing=(Number(-360, 360), 20.0), height=(Number(0.2, 120), 1.6), size=(SIZES.choice(), None),
    distance=(Number(0.5, 800), None), eye=(Vector(3), None),
)  # fmt: skip
CAMERA = Record(lens=(Number(12, 200), 40.0), focus=(Aim(), None), keys=Many(CAMERA_KEY, least=1))
CHARACTER = Record(
    name=(Text(60), None), height=(Number(0.9, 2.3), 1.72), build=(BUILDS.choice(), "average"), skin=(Color(), color("skin_fair")),
    hair=(Record(style=(HAIR.choice(), "short"), color=(Color(), color("hair_brown"))), {"style": "short", "color": color("hair_brown")}),
    facial_hair=(Record(style=FACIAL_HAIR.choice(), color=(Color(), color("hair_brown"))), None), glasses=(Choice(GLASSES, "glasses style"), None),
    look=(Identifier(), None),
)  # fmt: skip


def _set(custom_kinds):
    return Record(
        bounds=scenery.REGION, ground=(scenery.GROUND, filled(scenery.GROUND)), water=(Many(scenery.WATER), []), sky=(scenery.SKY, {}),
        rooms=(Many(scenery.ROOM), []), pieces=(Many(piece_field(custom_kinds)), []), marks=(Mapping(scenery.SPOT), {}),
    )  # fmt: skip


def _look():
    """A look: garments by name, each with its own options, and what the hands hold."""
    garments = {name: (Record(**entry.options) if name != "hat" else hat_field(), None) for name, entry in GARMENTS.entries.items()}
    return Record(**garments, hold=(Record(left=(held_field(), None), right=(held_field(), None)), {"left": None, "right": None}))


def design_field(custom_kinds):
    return Record(characters=(Mapping(CHARACTER), {}), looks=(Mapping(_look()), {}),props=(Mapping(CustomProp()), {}), sets=(Mapping(_set(custom_kinds)), {}))


def shot_field(custom_kinds):
    return Record(
        set=Identifier(), sky=(scenery.SKY, {}), subject=Many(Identifier(), least=1), size=SIZES.choice(), props=(Many(piece_field(custom_kinds)), []),
        people=(Many(PERSON), []), crowds=(Many(CROWD), []), events=(Many(EVENT), []), camera=(CAMERA, None),
    )  # fmt: skip


def custom_kinds(design):
    """The custom prop names a raw design declares, so pieces can be read against them."""
    props = design.get("props") if isinstance(design, dict) else None
    return list(props) if isinstance(props, dict) else []


def read_design(value, reading):
    design = design_field(custom_kinds(value)).read(value, "design", reading)
    if design is None:
        return None
    for character_id, character in design["characters"].items():
        if character and character["look"] is not None and character["look"] not in design["looks"]:
            reading.fail(f"design.characters.{character_id}.look", f"unknown look {show(character['look'])}; {nearest(character['look'], design['looks'])}")
    return design


def read_shot(value, design, reading):
    return shot_field(custom_kinds(design)).read(value, "shot", reading)
