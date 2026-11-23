"""How a writer says where and toward what: the fields for positions, targets and facings.

A field only reads the form; the stage resolves a reference against the built world at a moment in time.
"""

from .spec import Choice, Identifier, Number, Record, Vector, show

SIDES_OF = ["front", "behind", "left", "right"]


class Reference:
    """A place or thing named in a spec, kept with its JSON path so the stage can report a name it cannot find."""

    def __init__(self, form, value, path):
        self.form, self.value, self.path = form, value, path

    def names(self):
        """The id this reference leans on, when it has one."""
        if self.form == "name":
            return self.value[0]
        if self.form == "beside":
            return self.value["beside"].names()
        return None


def _named(value, path, reading):
    parts = value.split(".")
    if any(Identifier().read(part, path, reading) is None for part in parts):
        return None
    return Reference("name", (parts[0], parts[1:]), path)


class Named:
    """The id of one prop or one person, for an action that touches it."""

    def __init__(self, what):
        self.what = what

    def read(self, value, path, reading):
        name = Identifier().read(value, path, reading)
        return None if name is None else Reference(self.what, name, path)

    def describe(self):
        return f"id of a {self.what}"


class Place:
    """A spot on the ground: [x, y], a name, or beside something."""

    def read(self, value, path, reading):
        if isinstance(value, str):
            return _named(value, path, reading)
        if isinstance(value, list):
            spot = Vector(2).read(value, path, reading)
            return None if spot is None else Reference("ground", spot, path)
        if isinstance(value, dict) and "beside" in value:
            beside = Record(beside=Place(), side=(Choice(SIDES_OF, "side"), "front"), distance=(Number(0, 50), 1.0), along=(Number(-50, 50), 0.0)).read(value, path, reading)
            return None if beside is None else Reference("beside", beside, path)
        return reading.fail(path, f'expected a position, got {show(value)}; write [x, y], a name such as "gate", or {{"beside": "gun1", "side": "left", "distance": 1}}')

    def describe(self):
        return "position"


class Aim:
    """Something to face, look at, reach for or frame: a position, a named point, [x, y, z] or the camera."""

    def read(self, value, path, reading):
        if value == "camera":
            return Reference("camera", None, path)
        if isinstance(value, list) and len(value) == 3:
            point = Vector(3).read(value, path, reading)
            return None if point is None else Reference("space", point, path)
        return Place().read(value, path, reading)

    def describe(self):
        return "target"


class Facing:
    """A target to face, or a compass bearing in degrees."""

    def read(self, value, path, reading):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return Reference("bearing", float(value), path)
        return Aim().read(value, path, reading)

    def describe(self):
        return "target or bearing"
