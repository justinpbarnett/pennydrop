"""Pieces: every thing on a set that is not a person, from a cannon to a custom cabinet of drawers.

A piece is a painted body plus parts that can slide, turn, show, hide and glow.
It knows its named points, its seats, and the solid boxes people may not walk through.
Where it is at a moment is a function of shot time: its place, whoever carries it, and its own motions.
"""

import math

import bpy
from mathutils import Matrix, Vector

from . import effects
from .maths import lerp, placement, ramp, rotation_x, rotation_y, rotation_z, scatter
from .mesh import MeshBuilder, new_empty
from .paint import FINISHES, Color, color, material
from .spec import (
    Choice,
    Flag,
    Identifier,
    Kinded,
    Many,
    Mapping,
    Number,
    Record,
    Registry,
    Text,
    Whole,
    show,
)
from .spec import Vector as VectorField
from .wardrobe import HAT_LINE, HAT_OPTIONS, HATS, hat_mesh
from .where import Facing, Place

PIECES = Registry("prop kind")
HELD = Registry("held item")
PIECE_ACTIONS = {}
PATTERNS = Registry("flag pattern")
PRIMITIVES = Registry("primitive")
FLAG_COLORS = {"blue": "#2148a0", "white": "#f1ecdf", "red": "#c22a2c", "navy": "#1c2c66"}
DARK = "#4a3b34"


# ---------------------------------------------------------------- the piece itself
class Solid:
    """An upright box in a piece's own space that people and cameras may not enter."""

    def __init__(self, low, high):
        self.low, self.high = Vector(low), Vector(high)

    def holds(self, local_point, margin=0.0):
        return all(self.low[axis] - margin < local_point[axis] < self.high[axis] + margin for axis in range(3))

    def crossed(self, start, end):
        """How far along the way from start to end (0 to 1) the box is entered, or None when the way misses it."""
        enters, leaves = 0.0, 1.0
        for axis in range(3):
            travel = end[axis] - start[axis]
            if abs(travel) < 1e-9:
                if not self.low[axis] < start[axis] < self.high[axis]:
                    return None
                continue
            near, far = sorted(((self.low[axis] - start[axis]) / travel, (self.high[axis] - start[axis]) / travel))
            enters, leaves = max(enters, near), min(leaves, far)
        return enters if enters < leaves else None


class Part:
    """A movable part of a piece: its own object, placed relative to its parent part or to the piece."""

    def __init__(self, piece, made, position, rotation=None, pivot=(0, 0, 0), points=None, parent=None, shown=True):
        self.piece, self.made, self.parent = piece, made, parent
        self.position, self.rotation, self.pivot = Vector(position), (rotation or Matrix.Identity(3)).to_4x4(), Vector(pivot)
        self.points = {name: Vector(point) for name, point in (points or {}).items()}
        self._slides, self._turns, self._shows, self._glows = [], [], [(-math.inf, shown)], []
        made.parent = parent.made if parent else piece.root
        made["owner"] = piece.id

    def slide(self, time, seconds, by):
        self._slides.append((time, seconds, Vector(by)))

    def turn(self, time, seconds, axis, degrees):
        self._turns.append((time, seconds, axis.upper(), degrees))

    def show(self, time, shown):
        self._shows.append((time, shown))
        self._shows.sort(key=lambda change: change[0])

    def glow(self, time, seconds, tint):
        """Light the part up in a color; it needs paint of its own, or every part sharing its paint would glow."""
        if not self._glows:
            self._lit = [slot.material.copy() for slot in self.made.material_slots]
            for slot, copy in zip(self.made.material_slots, self._lit):
                slot.material = copy
        self._glows.append((time, seconds, tint))

    def local(self, time):
        offset = sum((by * ramp(time, start, start + seconds) for start, seconds, by in self._slides), Vector())
        turned = Matrix.Identity(4)
        for start, seconds, axis, degrees in self._turns:
            turned = turned @ Matrix.Rotation(math.radians(degrees * ramp(time, start, start + seconds)), 4, axis)
        return Matrix.Translation(self.position + offset) @ self.rotation @ Matrix.Translation(self.pivot) @ turned @ Matrix.Translation(-self.pivot)

    def matrix(self, time):
        outer = self.parent.matrix(time) if self.parent else self.piece.matrix(time)
        return outer @ self.local(time)

    def pose(self, time):
        self.made.matrix_basis = self.local(time)
        shown = [state for start, state in self._shows if start <= time][-1]
        self.made.hide_render = self.made.hide_viewport = not shown
        for start, seconds, tint in self._glows:
            for lit in self._lit:
                surface = lit.node_tree.nodes["Principled BSDF"]
                surface.inputs["Emission Color"].default_value = tint
                surface.inputs["Emission Strength"].default_value = 6.0 * ramp(time, start, start + seconds)


class Piece:
    def __init__(self, stage, piece_id, kind, location, heading):
        self.stage, self.id, self.kind = stage, piece_id, kind
        self.rest = placement(location, rotation_z(heading))
        self.root = new_empty(piece_id)
        self.body = MeshBuilder()
        self.parts, self.points, self.seats, self.solids = {}, {}, [], []
        self.focus = Vector((0, 0, 0.5))
        self.front = 0.0
        self.reach = 0.0
        self.motions, self.follows, self._routes = [], [], []
        stage.animate(self._pose)

    # ---- what makers call
    def drop(self, x, y):
        """How far the ground lies below (negative) or above the piece's origin at a point of its own space."""
        point = self.rest @ Vector((x, y, 0))
        return self.stage.ground.height(point.x, point.y) - self.rest.translation.z

    def block(self, low=None, high=None):
        """People may not pass through this box, or through everything drawn so far when no box is given."""
        if low is None:
            low, high = self._bounds()
        self.solids.append(Solid(low, high))

    def seat(self, position, heading=0.0):
        self.seats.append((Vector(position), heading))

    def part(self, part_id, made, position, **placing):
        if isinstance(made, MeshBuilder):
            made = made.build(f"{self.id}_{part_id}", bevel=0.006)
        self.parts[part_id] = Part(self, made, position, **placing)
        return self.parts[part_id]

    def light(self, position, energy, tint="#ffb060", radius=0.3):
        data = bpy.data.lights.new(self.id + "_light", "POINT")
        data.energy, data.color, data.shadow_soft_size = energy, color(tint)[:3], radius
        lamp = bpy.data.objects.new(self.id + "_light", data)
        lamp.location = position
        lamp.parent = self.root
        bpy.context.scene.collection.objects.link(lamp)

    def travel(self, time, seconds, to):
        """Slide over the ground or the water to a spot."""
        self._routes.append((time, seconds, Vector((to[0], to[1], self.rest.translation.z))))

    # ---- what the stage asks
    def _bounds(self):
        if self.body.is_empty():
            return Vector((-0.1, -0.1, 0)), Vector((0.1, 0.1, 0.2))
        return (Vector(min(vertex[axis] for vertex in self.body.vertices) for axis in range(3)), Vector(max(vertex[axis] for vertex in self.body.vertices) for axis in range(3)))

    def finish(self, sharp=38.0, bevel=0.0):
        low, high = self._bounds()
        self.size = high - low
        if not self.body.is_empty():
            self.focus = (low + high) / 2
            made = self.body.build(self.id, sharp=sharp, bevel=bevel)
            made.parent = self.root
            made["owner"] = self.id
        return self

    def matrix(self, time):
        base = self.rest
        for start, seconds, to in self._routes:
            base = Matrix.Translation((to - base.translation) * ramp(time, start, start + seconds)) @ base
        for start, follow in self.follows:
            if time >= start:
                base = follow(time)
        for motion in self.motions:
            base = base @ motion(time)
        return base

    def _pose(self, time):
        self.root.matrix_world = self.matrix(time)
        for part in self.parts.values():
            part.pose(time)

    def point_names(self):
        names = list(self.points) + [f"seat_{number + 1}" for number in range(len(self.seats))]
        for part_id, part in self.parts.items():
            names += [part_id] + [f"{part_id}.{name}" for name in part.points]
        return names

    def point(self, name, time):
        """A named point in the world: one of the piece, a seat, a part or a point of a part. No name gives the middle."""
        if not name:
            return self.matrix(time) @ self.focus
        if name in self.points:
            return self.matrix(time) @ self.points[name]
        if name.startswith("seat_"):
            return self.matrix(time) @ self.seats[int(name[5:]) - 1][0]
        part_id, _, part_point = name.partition(".")
        part = self.parts[part_id]
        return part.matrix(time) @ (part.points[part_point] if part_point else Vector())

    def heading(self, time):
        forward = self.matrix(time).to_3x3() @ Vector((0, 1, 0))
        return math.degrees(math.atan2(-forward.x, forward.y)) + self.front


def piece(about, **options):
    """Register a kind of piece. Its maker draws into a fresh Piece; its actions are registered with `acts`."""

    def decorate(maker):
        actions = Registry(f"action of a {maker.__name__}")
        PIECE_ACTIONS[maker.__name__] = actions
        PIECES.add(maker.__name__, about, options, maker, actions=actions.describe)
        return maker

    return decorate


def held(about, **options):
    """A piece small enough for a hand: drawn with its grip at the origin and its length along +y."""

    def decorate(maker):
        piece(about, **options)(maker)
        HELD.entries[maker.__name__] = PIECES[maker.__name__]
        return maker

    return decorate


def acts(kind, about, sound=None, **options):
    """Register something a kind of piece can do at a time; the function returns how many seconds it lasts."""

    def decorate(function):
        PIECE_ACTIONS[kind].add(function.__name__, about, options, function, sound=sound)
        return function

    return decorate


def held_field():
    return Kinded(HELD, bare_name=True)


def piece_field(custom_kinds):
    """A placed piece: a library kind with its options, or one of the design's custom props."""
    return Placed(custom_kinds)


class Placed:
    """The field for a piece placed on a set."""

    def __init__(self, custom_kinds):
        self.custom_kinds = list(custom_kinds)

    def read(self, value, path, reading):
        shared = {"id": Identifier(), "position": Place(), "facing": (Facing(), None), "lift": (Number(-10, 200), 0.0)}
        kind = value.get("kind") if isinstance(value, dict) else None
        if isinstance(kind, str) and kind in self.custom_kinds:
            return Record(kind=Text(), **shared).read(value, path, reading)
        if isinstance(kind, str) and kind not in PIECES:
            return Choice([*PIECES.names(), *self.custom_kinds], "prop kind").read(kind, f"{path}.kind", reading)
        return Kinded(PIECES, **shared).read(value, path, reading)

    def describe(self):
        return {"id (required)": "id", "position (required)": "position", "facing": "target or bearing", "lift": "meters above the ground, for a thing on a table or a wall",
                "kind (required)": "a prop kind from the catalog or a custom prop of the design, with that kind's own options"}  # fmt: skip


# ---------------------------------------------------------------- flags
@PATTERNS.register("the French tricolor: blue, white, red")
def french(across, down):
    return "blue" if across < 1 / 3 else "white" if across < 2 / 3 else "red"


@PATTERNS.register("the British union flag")
def union(across, down):
    if abs(across - 0.5) < 0.07 or abs(down - 0.5) < 0.11:
        return "red"
    if abs(across - 0.5) < 0.13 or abs(down - 0.5) < 0.2 or abs(abs(across - 0.5) * 1.5 - abs(down - 0.5)) < 0.07:
        return "white"
    return "navy"


@PATTERNS.register("a British red ensign: red with the union flag in the corner")
def red_ensign(across, down):
    return union(across * 2, down * 2) if across < 0.5 and down < 0.5 else "red"


@PATTERNS.register("plain white")
def white(across, down):
    return "white"


@PATTERNS.register("plain red")
def red(across, down):
    return "red"


def _cloth(builder, pattern, corner, across, down, columns, rows, transform=None):
    """A flag as a grid of painted cells, hanging from its top corner at the pole."""
    corner, across, down = Vector(corner), Vector(across), Vector(down)
    for column in range(columns):
        for row in range(rows):
            tint = FLAG_COLORS[PATTERNS[pattern].make((column + 0.5) / columns, (row + 0.5) / rows)]
            paint = material(tint, "cloth", grain=0.04, bump=0.0)
            cell = [corner + across * (column / columns) + down * ((row + 1) / rows), corner + across * ((column + 1) / columns) + down * ((row + 1) / rows),
                    corner + across * ((column + 1) / columns) + down * (row / rows), corner + across * (column / columns) + down * (row / rows)]  # fmt: skip
            builder.add(cell, [(0, 1, 2, 3)], paint, transform=transform)


def _flying_cloth(name, pattern, width, phase):
    builder = MeshBuilder()
    _cloth(builder, pattern, (0, 0, 0), (width, 0, 0), (0, 0, -width * 0.65), 16, 9)
    cloth = builder.build(name, sharp=180, weld=True)
    weights = cloth.vertex_groups.new(name="free")
    for vertex in cloth.data.vertices:
        weights.add([vertex.index], min(1.0, (vertex.co.x / width) ** 0.8), "REPLACE")
    for wave_length, height, speed in ((1.1, 0.13, 0.085), (0.55, 0.05, 0.12)):
        wave = cloth.modifiers.new("wave", "WAVE")
        wave.use_x, wave.use_y, wave.use_cyclic, wave.use_normal = True, False, True, True
        scale = width / 1.7
        wave.height, wave.width, wave.narrowness, wave.speed = height * scale, wave_length * scale, 1.6 / (wave_length * scale), speed * scale
        wave.time_offset = -300 - phase * 40
        wave.vertex_group = "free"
    return cloth


@piece("a flag flying on a pole", pattern=(PATTERNS.choice(), "white"), height=(Number(1, 40), 4.0), width=(Number(0.3, 10), 1.7))
def flag(piece, pattern, height, width):
    piece.body.capsule((0, 0, 0), (0, 0, height + 0.08), 0.04, 0.03, material("walnut"), segments=8, rings=2)
    piece.body.ball((0, 0, height + 0.12), 0.07, material("gold", "polished"), segments=8, rings=4)
    piece.points["top"] = Vector((0, 0, height))
    piece.flying = piece.part(pattern, _flying_cloth(piece.id + "_cloth", pattern, width, scatter(len(piece.id))), (0, 0, height))
    piece.hoist, piece.width = height - 1.4, width
    piece.finish()


@acts("flag", "the flag comes down the pole", seconds=(Number(0.2, 20), 1.5))
def lower(piece, time, seconds):
    piece.flying.slide(time, seconds, (0, 0, -piece.hoist))
    piece.flying.show(time + seconds, False)
    return seconds


@acts("flag", "a flag goes up the pole; pattern picks a new flag", seconds=(Number(0.2, 20), 1.5), pattern=(PATTERNS.choice(), None))
def hoist(piece, time, seconds, pattern):
    height = piece.points["top"].z
    piece.flying = piece.part(f"{pattern}_{len(piece.parts)}", _flying_cloth(piece.id + "_cloth", pattern or "white", piece.width, 0.5), (0, 0, height - piece.hoist), shown=False)
    piece.flying.show(time, True)
    piece.flying.slide(time, seconds, (0, 0, piece.hoist))
    return seconds


# ---------------------------------------------------------------- guns and siege works
@piece("a field gun on a two wheeled carriage, muzzle to the front", elevation=(Number(-5, 30), 5.0))
def cannon(piece, elevation):
    body, olive, iron = piece.body, material("olive", grain_scale=2.5), material("iron", "metal", grain_scale=2.5)
    bronze = material("bronze", "polished", grain=0.04)
    axle = 0.62
    for side in (1, -1):
        hub = placement((side * 0.66, 0, axle))
        wheel = hub @ rotation_y(90).to_4x4()
        body.revolve([(0.52, -0.05), (0.62, -0.05), (0.62, 0.05), (0.52, 0.05)], olive, transform=wheel, segments=20, capped=False)
        body.revolve([(0.6, -0.055), (0.635, -0.055), (0.635, 0.055), (0.6, 0.055)], iron, transform=wheel, segments=20, capped=False)
        body.cylinder((side * 0.58, 0, axle), (side * 0.76, 0, axle), 0.11, 0.09, olive, segments=10)
        for spoke in range(8):
            body.box((0, 0, 0.3), (0.06, 0.06, 0.48), olive, transform=hub @ rotation_x(spoke * 45).to_4x4())
        body.box((side * 0.2, -1.0, 0.39), (0.11, 2.15, 0.2), olive, rotation=rotation_x(16))
    body.cylinder((-0.66, 0, axle), (0.66, 0, axle), 0.06, 0.06, olive, segments=8)
    body.box((0, -0.95, 0.40), (0.4, 0.5, 0.08), olive, rotation=rotation_x(16))
    barrel = placement((0, 0.05, axle + 0.22), rotation_x(elevation) @ rotation_x(-90))
    profile = [(0, -0.74), (0.06, -0.72), (0.075, -0.66), (0.045, -0.61), (0.16, -0.58), (0.165, -0.45), (0.15, -0.4), (0.12, 1.0), (0.145, 1.04), (0.145, 1.13), (0.08, 1.13), (0.07, 0.95), (0, 0.95)]
    body.revolve(profile, bronze, transform=barrel, segments=14)
    piece.points.update(muzzle=barrel @ Vector((0, 0, 1.2)), vent=barrel @ Vector((0, -0.2, -0.45)), breech=barrel @ Vector((0, 0, -0.8)))
    piece.block((-0.8, -2.0, 0), (0.8, 1.2, 1.25))
    piece.finish(bevel=0.012)


@acts("cannon", "the gun fires: flash, a cloud of smoke, and the carriage kicks back", sound="cannon", smoke=(Number(0.2, 3), 1.0))
def fire(piece, time, smoke):
    def kick(now):
        age = now - time
        return Matrix.Translation((0, -0.5 * ramp(age, -0.04, 0.1) * (1 - 0.16 * ramp(age, 0.1, 0.5)) * (1 - ramp(age, 0.5, 2.2)), 0))

    piece.motions.append(kick)
    muzzle, forward = piece.point("muzzle", time), piece.rest.to_3x3() @ Vector((0, 1, 0.1))
    effects.flare(piece.stage, muzzle + forward * 0.3, time, size=0.9, energy=4000)
    effects.burst(piece.stage, muzzle + forward * 0.8, time, velocity=forward * 5.5, size=0.8 * smoke, life=3.6, count=6, spread=0.35, seed=time)
    effects.burst(piece.stage, piece.point("vent", time), time, velocity=(0, 0, 1.2), size=0.25, life=1.6, count=2, spread=0.1, seed=time + 3)
    return 1.5


@piece("a pyramid of cannonballs", layers=(Whole(1, 5), 3))
def cannonballs(piece, layers):
    radius, iron = 0.095, material("iron", "metal")
    for layer in range(layers):
        across = layers - layer
        for column in range(across):
            for row in range(across):
                piece.body.ball(((column - (across - 1) / 2) * 2 * radius, (row - (across - 1) / 2) * 2 * radius, radius + layer * radius * 1.5), radius, iron, segments=8, rings=4)
    piece.finish()


@piece("a breastwork of earth filled wicker baskets in a line, left to right", length=(Number(1, 60), 6.0), height=(Number(0.4, 2), 0.95))
def parapet(piece, length, height):
    count = int(length / 0.9) + 1
    wicker, soil = material("wicker", "earth", grain=0.2, grain_scale=14, bump=0.5), material("earth", "earth")
    for basket in range(count):
        x = lerp(-length / 2, length / 2, basket / max(count - 1, 1))
        tall = height * (0.92 + 0.16 * scatter(basket + length))
        base = piece.drop(x, 0) - 0.05
        piece.body.revolve([(0.39, 0), (0.42, tall * 0.5), (0.39, tall)], wicker, transform=placement((x, 0, base)), segments=10)
        piece.body.dome((x, 0, base + tall - 0.02), 0.38, soil, scale=(1, 1, 0.3), segments=10, rings=3)
    piece.block((-length / 2 - 0.4, -0.42, -1), (length / 2 + 0.4, 0.42, height))
    piece.finish()


@piece("a long heap of earth, left to right", length=(Number(1, 80), 6.0), radius=(Number(0.3, 8), 1.0), color=(Color(), color("earth")))
def mound(piece, length, radius, color):
    count = max(2, int(length / (radius * 0.8)))
    soil = material(color, "earth", grain_scale=1.2)
    for heap in range(count + 1):
        x = lerp(-length / 2, length / 2, heap / count)
        piece.body.ball((x, 0, piece.drop(x, 0) - radius * 0.15), radius * (1 + 0.25 * (scatter(heap * 1.7 + length) - 0.5)), soil, scale=(1, 1, 0.6), segments=10, rings=5)
    piece.finish(sharp=180)


@piece("a camp fire of logs, burning")
def campfire(piece):
    for log in range(5):
        angle = log * 1.26
        piece.body.capsule((math.cos(angle) * 0.35, math.sin(angle) * 0.35, 0.06), (-math.cos(angle) * 0.2, -math.sin(angle) * 0.2, 0.2), 0.07, 0.06, material("walnut"), segments=6, rings=2)
    piece.block((-0.4, -0.4, 0), (0.4, 0.4, 0.5))
    piece.finish()
    effects.flames(piece.stage, piece.rest.translation, -1.0, piece.stage.duration + 1.0, seed=scatter(len(piece.id)))


@piece("a round army tent, door to the front")
def tent(piece):
    canvas = material("canvas", "cloth", grain_scale=1.5)
    piece.body.revolve([(1.9, 0), (1.85, 0.9), (0, 3.0)], canvas, segments=10)
    piece.body.capsule((0, 0, 2.9), (0, 0, 3.4), 0.04, 0.03, material("walnut"), segments=6, rings=2)
    piece.body.add([(-0.45, 1.86, 0), (0.45, 1.86, 0), (0, 1.5, 1.55)], [(0, 1, 2)], material("#4b3a2c", grain=0.0))
    piece.block((-1.5, -1.5, 0), (1.5, 1.5, 2.0))
    piece.finish(sharp=25)


@piece("a few crates and a barrel", count=(Whole(1, 8), 3), seed=(Number(0, 99), 0.0))
def crates(piece, count, seed):
    for crate in range(count):
        side = 0.5 + 0.25 * scatter(seed + crate)
        piece.body.box(((scatter(seed + crate * 2) - 0.5) * 1.4, (scatter(seed + crate * 3) - 0.5) * 1.0, side / 2), (side * 1.2, side, side), material("oak", "wood", grain=0.12), rotation=rotation_z(scatter(seed + crate * 5) * 60))
    piece.body.revolve([(0.26, 0), (0.33, 0.4), (0.26, 0.8)], material("walnut", "wood"), transform=placement((1.2, 0.3, 0)), segments=10)
    piece.block()
    piece.finish(bevel=0.015)


@piece("a litter of canvas between two poles, carried by two people")
def stretcher(piece):
    for side in (1, -1):
        piece.body.capsule((side * 0.3, -1.25, 0), (side * 0.3, 1.25, 0), 0.025, 0.025, material("walnut"), segments=6, rings=2)
    piece.body.box((0, 0, -0.005), (0.6, 1.9, 0.03), material("canvas", "cloth"))
    for end, along in (("front", 1.2), ("rear", -1.2)):
        piece.points.update({f"handle_{end}_left": Vector((-0.3, along, 0)), f"handle_{end}_right": Vector((0.3, along, 0))})
    piece.finish()


# ---------------------------------------------------------------- ships
@piece("a three masted sailing warship, bow to the front, afloat", length=(Number(3, 80), 12.0), ensign=(PATTERNS.choice(), "white"), sails=(Flag(), True), seed=(Number(0, 99), 0.0))
def ship(piece, length, ensign, sails, seed):
    scale = placement(scale=length)
    body, hull, deck = MeshBuilder(), material("#4a3222", "wood"), material("oak", "wood")
    canvas = material("#efe7d2", "cloth", grain_scale=5)
    body.ball((0, 0, 0.02), 1, hull, scale=(0.15, 0.5, 0.15), segments=14, rings=8)
    body.ball((0, 0, 0.075), 1, material("#c9973f", "wood"), scale=(0.156, 0.49, 0.03), segments=14, rings=4)
    body.ball((0, 0, 0.12), 1, deck, scale=(0.125, 0.46, 0.02), segments=14, rings=4)
    body.box((0, -0.36, 0.15), (0.2, 0.2, 0.1), hull, taper=(0.9, 0.9))
    body.cylinder((0, 0.44, 0.13), (0, 0.72, 0.24), 0.012, 0.008, deck, segments=6)
    for along, tall in ((0.26, 0.72), (-0.02, 0.86), (-0.3, 0.62)):
        body.cylinder((0, along, 0.1), (0, along, 0.1 + tall), 0.013, 0.008, deck, segments=6)
        if sails:
            for low, high, wide in ((0.2, 0.2 + tall * 0.42, 0.3), (0.22 + tall * 0.42, 0.1 + tall * 0.78, 0.23), (0.12 + tall * 0.78, 0.08 + tall * 0.97, 0.15)):
                body.sheet((wide / 2, along + 0.02, low), (-wide, 0, 0), (0, 0, high - low), canvas, columns=5, rows=5, bulge=0.05 * wide / 0.3)
    body.cylinder((0, -0.46, 0.12), (0, -0.46, 0.4), 0.006, 0.006, deck, segments=5)
    _cloth(body, ensign, (0, -0.462, 0.4), (0, -0.16, -0.012), (0, 0, -0.1), 12, 8)
    piece.body.merge(body, scale)
    piece.points.update(deck=Vector((0, 0, 0.14 * length)), bow=Vector((0, 0.5 * length, 0.1 * length)), stern=Vector((0, -0.46 * length, 0.2 * length)))
    piece.block((-0.15 * length, -0.5 * length, -1), (0.15 * length, 0.5 * length, 0.2 * length))
    piece.finish(sharp=60)
    piece.motions.append(lambda time: placement((0, 0, 0.012 * length * math.sin(time * 1.7 + seed * 3)), rotation_x(1.6 * math.sin(time * 1.45 + seed)) @ rotation_y(3.5 * math.sin(time * 1.13 + seed * 2))))


@acts("ship", "the ship sails to a position", to=Place(), seconds=(Number(1, 600), 20.0))
def sail(piece, time, seconds, to):
    piece.travel(time, seconds, to)
    return seconds


# ---------------------------------------------------------------- buildings
WALL_TINTS = ("plaster", "#e3c48f", "#dfb9a0")


def _house(body, transform, width, depth, height, wall_tint, roof_tint):
    body.box((0, 0, height / 2), (width, depth, height), material(wall_tint, "stone", grain=0.05), transform=transform)
    body.roof((0, 0, height), (width + 0.5, depth + 0.5, depth * 0.32), material(roof_tint, "stone", grain=0.1, grain_scale=0.8), transform=transform)
    windows = max(1, int(width / 1.8))
    for side in (1, -1):
        for window in range(windows):
            for level in [height * 0.32, height * 0.7] if height > 3.5 else [height * 0.55]:
                body.box(((window - (windows - 1) / 2) * width / windows, side * depth / 2, level), (0.5, 0.08, 0.75), material(DARK, grain=0.0), transform=transform)


def _tower(body, transform, width, height, wall_tint, roof_tint):
    body.box((0, 0, height / 2), (width, width, height), material(wall_tint, "stone", grain=0.05), transform=transform)
    body.revolve([(width * 0.78, 0), (0, width * 1.1)], material(roof_tint, "stone", grain_scale=0.8), transform=transform @ placement((0, 0, height), rotation_z(45)), segments=4)
    body.box((0, width / 2, height * 0.8), (0.7, 0.1, 1.3), material(DARK, grain=0.0), transform=transform)


@piece("a house with a tiled roof", size=(VectorField(3, 1, 60), (5.0, 4.0, 4.0)), color=(Color(), color("plaster")), roof=(Color(), color("terracotta")))
def house(piece, size, color, roof):
    _house(piece.body, Matrix.Identity(4), *size, color, roof)
    piece.block()
    piece.finish(bevel=0.04)


@piece("a square tower with a pointed roof", width=(Number(1, 30), 3.0), height=(Number(2, 80), 12.0), color=(Color(), color("#e3c48f")), roof=(Color(), color("terracotta")))
def tower(piece, width, height, color, roof):
    _tower(piece.body, Matrix.Identity(4), width, height, color, roof)
    piece.block()
    piece.finish(bevel=0.04)


@piece("a town of houses seen from outside; too dense to walk through", houses=(Whole(2, 120), 24), spread=(VectorField(2, 2, 300), (22.0, 10.0)), towers=(Whole(0, 6), 1), seed=(Number(0, 99), 1.0))
def town(piece, houses, spread, towers, seed):
    for index in range(houses):
        x, y = (scatter(seed + index * 1.3) - 0.5) * 2 * spread[0], (scatter(seed + index * 2.9) - 0.5) * 2 * spread[1]
        turned = placement((x, y, piece.drop(x, y) - 0.3), rotation_z((scatter(seed + index * 7.7) - 0.5) * 30))
        _house(piece.body, turned, 3.5 + 3 * scatter(seed + index * 4.1), 3 + 2 * scatter(seed + index * 5.3), 3 + 3.5 * scatter(seed + index * 6.7), WALL_TINTS[index % 3], "terracotta")
    for index in range(towers):
        x, y = (scatter(seed + 90 + index) - 0.5) * spread[0], (scatter(seed + 95 + index) - 0.2) * spread[1] * 0.6
        _tower(piece.body, placement((x, y, piece.drop(x, y) - 0.3)), 3.2, 13.0, WALL_TINTS[1], "terracotta")
    piece.block((-spread[0] - 3, -spread[1] - 3, -5), (spread[0] + 3, spread[1] + 3, 12))
    piece.finish(bevel=0.04)


@piece(
    "a stone city wall with battlements, left to right, with round bastions at its ends; gate cuts a towered gateway in the middle",
    length=(Number(4, 400), 40.0), height=(Number(1.5, 30), 5.0), thickness=(Number(0.4, 8), 1.6), gate=(Number(0, 20), 0.0), bastions=(Flag(), True),
)  # fmt: skip
def city_wall(piece, length, height, thickness, gate, bastions):
    body, stone = piece.body, material("stone", "stone", grain_scale=0.5)
    spans = [(-length / 2, -gate / 2), (gate / 2, length / 2)] if gate else [(-length / 2, length / 2)]
    for start, end in spans:
        sections = max(1, round((end - start) / 10))
        for section in range(sections):
            west, east = lerp(start, end, section / sections), lerp(start, end, (section + 1) / sections)
            middle, base = (west + east) / 2, piece.drop((west + east) / 2, 0)
            body.box((middle, 0, base + height / 2 - 0.5), (east - west, thickness, height + 1.0), stone, taper=(1, 0.75))
            merlons = max(1, int((east - west) / 1.6))
            for merlon in range(merlons):
                body.box((west + (merlon + 0.5) / merlons * (east - west), 0, base + height + 0.25), (0.8, thickness * 0.78, 0.5), stone)
            piece.block((west, -thickness / 2, base - 2), (east, thickness / 2, base + height + 0.5))
    if gate:
        body.box((0, 0, height - 0.6), (gate + 1.2, thickness * 1.1, 1.6), stone)
        for side in (1, -1):
            body.box((side * (gate / 2 + 0.9), 0, (height + 1.4) / 2), (1.8, thickness * 1.5, height + 1.4), stone, taper=(0.9, 0.9))
            body.revolve([(1.3, 0), (0, 1.1)], material("terracotta", "stone"), transform=placement((side * (gate / 2 + 0.9), 0, height + 1.4), rotation_z(45)), segments=4)
    if bastions:
        for end in (-length / 2, length / 2):
            profile = [(thickness * 1.5, -0.5), (thickness * 1.3, height + 0.8), (thickness * 1.45, height + 0.8), (thickness * 1.45, height + 1.3), (0, height + 1.3)]
            body.revolve(profile, stone, transform=placement((end, 0, piece.drop(end, 0))), segments=10)
    piece.points["gate"] = Vector((0, 0, 0))
    piece.finish(bevel=0.03)


@piece("a square fort of stone walls with corner towers and a gate at the front", width=(Number(6, 120), 20.0), depth=(Number(6, 120), 14.0), height=(Number(1.5, 20), 4.0))
def fort(piece, width, depth, height):
    body, stone = piece.body, material("stone", "stone", grain_scale=0.5)
    for center, size in (((0, -depth / 2, 0), (width, 1.2)), ((-width / 2, 0, 0), (1.2, depth)), ((width / 2, 0, 0), (1.2, depth)), ((-width / 4 - 0.7, depth / 2, 0), (width / 2 - 1.4, 1.2)), ((width / 4 + 0.7, depth / 2, 0), (width / 2 - 1.4, 1.2))):
        body.box((center[0], center[1], height / 2 - 0.5), (size[0], size[1], height + 1.0), stone, taper=(0.94, 0.94))
    for corner_x in (-width / 2, width / 2):
        for corner_y in (-depth / 2, depth / 2):
            body.revolve([(1.9, -0.5), (1.7, height + 0.8), (1.85, height + 0.8), (1.85, height + 1.3), (0, height + 1.3)], stone, transform=placement((corner_x, corner_y, 0)), segments=10)
    body.box((0, 0, 0.15), (width, depth, 0.3), material("earth", "earth"))
    piece.points.update(gate=Vector((0, depth / 2, 0)), top=Vector((0, 0, height + 1.3)))
    piece.block((-width / 2 - 1.5, -depth / 2 - 1.5, -2), (width / 2 + 1.5, depth / 2 + 1.5, height + 1))
    piece.finish(bevel=0.03)


@piece("a stone column", height=(Number(1, 30), 4.0), radius=(Number(0.1, 3), 0.3), color=(Color(), color("stone")))
def column(piece, height, radius, color):
    stone = material(color, "stone")
    piece.body.revolve([(radius * 1.4, 0), (radius * 1.4, 0.2), (radius, 0.3), (radius * 0.9, height - 0.3), (radius * 1.35, height - 0.15), (radius * 1.35, height)], stone, segments=14)
    piece.block()
    piece.finish()


# ---------------------------------------------------------------- nature
def _tree(body, kind, x, y, base, size):
    trunk = material("#5b4330", "wood")
    if kind == "cypress":
        body.cylinder((x, y, base), (x, y, base + 0.8 * size), 0.12 * size, 0.1 * size, trunk, segments=6)
        body.revolve([(0, 0.5 * size), (0.55 * size, 1.2 * size), (0.5 * size, 2.6 * size), (0, 5.2 * size)], material("#34503a", "earth", grain=0.12, grain_scale=3), transform=placement((x, y, base)), segments=9)
    elif kind == "pine":
        body.cylinder((x, y, base), (x + 0.2 * size, y, base + 2.6 * size), 0.16 * size, 0.1 * size, trunk, segments=6)
        body.ball((x + 0.2 * size, y, base + 3.0 * size), 1, material("leaf", "earth", grain=0.14, grain_scale=3), scale=(1.5 * size, 1.5 * size, 0.7 * size), segments=10, rings=5)
    else:
        body.cylinder((x, y, base), (x, y, base + 1.2 * size), 0.14 * size, 0.1 * size, trunk, segments=6)
        body.ball((x, y, base + 1.8 * size), 1, material("#7d8f5c" if kind == "olive" else "leaf", "earth", grain=0.14, grain_scale=3), scale=(1.1 * size, 1.1 * size, 0.9 * size), segments=9, rings=5)


TREE_KINDS = ["pine", "cypress", "olive", "broadleaf"]


@piece(
    "trees: one, or a grove scattered over a spread",
    tree=(Choice([*TREE_KINDS, "mixed"], "tree kind"), "mixed"), count=(Whole(1, 200), 1), spread=(VectorField(2, 0, 300), (6.0, 6.0)), size=(Number(0.3, 6), 1.0), seed=(Number(0, 99), 0.0),
)  # fmt: skip
def trees(piece, tree, count, spread, size, seed):
    for index in range(count):
        x, y = ((scatter(seed + index * 1.9) - 0.5) * 2 * spread[0], (scatter(seed + index * 2.7) - 0.5) * 2 * spread[1]) if count > 1 else (0.0, 0.0)
        chosen = TREE_KINDS[int(scatter(seed + index * 3.3) * 3)] if tree == "mixed" else tree
        _tree(piece.body, chosen, x, y, piece.drop(x, y) - 0.1, size * (0.8 + 0.5 * scatter(seed + index * 1.9)))
        piece.block((x - 0.2 * size, y - 0.2 * size, -1), (x + 0.2 * size, y + 0.2 * size, 2 * size))
    piece.finish(sharp=60)


# ---------------------------------------------------------------- furniture
def _table(body, length, width, height, paint):
    body.box((0, 0, height - 0.035), (length, width, 0.07), paint)
    for side_x in (1, -1):
        for side_y in (1, -1):
            body.box((side_x * (length / 2 - 0.13), side_y * (width / 2 - 0.12), (height - 0.07) / 2), (0.09, 0.09, height - 0.07), paint)


@piece("a table", length=(Number(0.4, 12), 1.6), width=(Number(0.3, 6), 0.9), height=(Number(0.3, 1.5), 0.78), color=(Color(), color("oak")))
def table(piece, length, width, height, color):
    _table(piece.body, length, width, height, material(color, "wood"))
    piece.points["top"] = Vector((0, 0, height))
    piece.block()
    piece.finish(bevel=0.008)


@piece("a campaign table with a map of a harbor, forts and ships spread on it")
def map_table(piece):
    body = piece.body
    _table(body, 1.9, 1.15, 0.935, material("oak", "wood", grain_scale=4))
    body.box((0, 0, 0.94), (1.6, 0.95, 0.012), material("paper", "cloth", grain_scale=3))
    sea, land = material("#5f9bc0", coat=0.0), material("#9fb072", coat=0.0)
    body.ball((0.1, 0.08, 0.945), 1, sea, scale=(0.42, 0.22, 0.008), segments=12, rings=3)
    body.ball((-0.25, 0.22, 0.946), 1, land, scale=(0.16, 0.1, 0.012), segments=10, rings=3)
    body.ball((0.45, 0.3, 0.945), 1, land, scale=(0.2, 0.08, 0.008), segments=10, rings=3)
    for fort_x, fort_y in ((-0.26, 0.22), (-0.33, 0.14)):
        body.revolve([(0.035, 0), (0, 0.07)], material("red"), transform=placement((fort_x, fort_y, 0.955)), segments=6)
    for ship_x, ship_y in ((0.05, 0.1), (0.2, 0.02), (0.25, 0.14)):
        body.box((ship_x, ship_y, 0.958), (0.035, 0.08, 0.02), material("#4a3222"))
    piece.points.update(map=Vector((0, 0, 0.95)), forts=Vector((-0.29, 0.18, 0.96)), harbor=Vector((0.1, 0.08, 0.95)))
    piece.block((-0.95, -0.58, 0), (0.95, 0.58, 0.94))
    piece.finish(bevel=0.008)


@piece("a writing desk with a seat behind it; the sitter faces the front", color=(Color(), color("walnut")))
def desk(piece, color):
    paint = material(color, "wood")
    _table(piece.body, 1.3, 0.7, 0.78, paint)
    piece.body.box((0, 0.3, 0.45), (1.2, 0.04, 0.5), paint)
    piece.body.box((0, -0.75, 0.42), (0.45, 0.42, 0.05), paint)
    for side_x in (1, -1):
        piece.body.box((side_x * 0.19, -0.75, 0.2), (0.05, 0.36, 0.4), paint)
    piece.points["top"] = Vector((0, 0, 0.78))
    piece.seat((0, -0.75, 0))
    piece.block((-0.65, -0.35, 0), (0.65, 0.35, 0.78))
    piece.finish(bevel=0.008)


@piece("a chair; the sitter faces the front", color=(Color(), color("oak")))
def chair(piece, color):
    paint = material(color, "wood")
    piece.body.box((0, 0, 0.42), (0.45, 0.42, 0.05), paint)
    piece.body.box((0, -0.2, 0.72), (0.45, 0.04, 0.55), paint)
    for side_x in (1, -1):
        for side_y in (1, -1):
            piece.body.box((side_x * 0.19, side_y * 0.17, 0.2), (0.045, 0.045, 0.4), paint)
    piece.seat((0, 0, 0))
    piece.block((-0.22, -0.22, 0), (0.22, 0.22, 0.45))
    piece.finish(bevel=0.006)


@piece(
    "rows of benches, each row behind and above the one in front like an assembly or a lecture hall; the sitters face the front",
    rows=(Whole(1, 12), 3), seats=(Whole(1, 30), 6), rise=(Number(0, 0.6), 0.25), color=(Color(), color("walnut")), curve=(Number(0, 60), 0.0),
)  # fmt: skip
def benches(piece, rows, seats, rise, color, curve):
    paint, place_width, row_depth = material(color, "wood"), 0.62, 1.0
    length = seats * place_width
    for row in range(rows):
        level, back = row * rise, -row * row_depth
        if row:
            piece.body.box((0, back, level / 2), (length + 0.4, row_depth, level), paint)
            piece.stage.ground.add_floor(piece.rest, (-length / 2 - 0.2, back - row_depth / 2), (length / 2 + 0.2, back + row_depth / 2), level)
        piece.body.box((0, back - 0.05, level + 0.4), (length, 0.36, 0.06), paint)
        piece.body.box((0, back - 0.25, level + 0.62), (length, 0.05, 0.5), paint)
        for support in range(seats + 1):
            piece.body.box((-length / 2 + support * place_width, back - 0.05, level + 0.19), (0.05, 0.34, 0.38), paint)
        for place in range(seats):
            x = -length / 2 + (place + 0.5) * place_width
            piece.seat((x, back, level), curve * (0.5 - (place + 0.5) / seats) * -1)
        piece.block((-length / 2, back - 0.3, level), (length / 2, back + 0.15, level + 0.45))
    piece.finish(bevel=0.006)


@piece("a speaker's tribune: a raised platform with a lectern at the front and steps at the back", height=(Number(0.3, 2.5), 0.9), width=(Number(1.2, 8), 2.4), color=(Color(), color("walnut")))
def tribune(piece, height, width, color):
    paint, body = material(color, "wood"), piece.body
    body.box((0, 0, height / 2), (width, 1.8, height), paint)
    body.box((0, 0.8, height + 0.55), (1.0, 0.2, 1.1), paint)
    body.box((0, 0.74, height + 1.12), (1.1, 0.4, 0.05), paint, rotation=rotation_x(-14))
    for step in range(3):
        tread = height * (3 - step) / 4
        body.box((0, -0.9 - 0.3 * (step + 0.5), tread / 2), (1.2, 0.3, tread), paint)
        piece.stage.ground.add_floor(piece.rest, (-0.6, -0.9 - 0.3 * (step + 1)), (0.6, -0.9 - 0.3 * step), tread)
    piece.stage.ground.add_floor(piece.rest, (-width / 2, -0.9), (width / 2, 0.9), height)
    piece.points.update(stand=Vector((0, 0.3, height)), lectern=Vector((0, 0.74, height + 1.15)), steps=Vector((0, -2.2, 0)))
    piece.block((-0.5, 0.65, height), (0.5, 0.95, height + 1.1))
    piece.block((-width / 2, -0.9, -1), (width / 2, 0.9, height - 0.05))
    piece.finish(bevel=0.01)


@piece("a door leaf in its frame, hinged at its left edge seen from the front", width=(Number(0.5, 4), 1.0), height=(Number(1.5, 5), 2.1), color=(Color(), color("walnut")))
def door(piece, width, height, color):
    paint, leaf = material(color, "wood"), MeshBuilder()
    leaf.box((0, 0, height / 2), (width - 0.04, 0.05, height - 0.02), paint)
    for panel in (0.3, 0.72):
        leaf.box((0, 0, height * panel), (width * 0.62, 0.065, height * 0.3), paint)
    leaf.ball((width * 0.38, 0.05, height * 0.48), 0.035, material("brass", "polished"), segments=8, rings=4)
    leaf.ball((width * 0.38, -0.05, height * 0.48), 0.035, material("brass", "polished"), segments=8, rings=4)
    piece.leaf = piece.part("leaf", leaf, (0, 0, 0), pivot=(-width / 2, 0, 0), points={"handle": (width * 0.38, 0, height * 0.48)})
    piece.focus = Vector((0, 0, height / 2))
    piece.points.update(front=Vector((0, 0.8, 0)), behind=Vector((0, -0.8, 0)))
    piece.swing = 0.0
    piece.finish()


def _swing(piece, time, seconds, degrees):
    piece.leaf.turn(time, seconds, "Z", degrees - piece.swing)
    piece.swing = degrees
    return seconds


@acts("door", "the door swings open", sound="door", angle=(Number(-170, 170), -100.0), seconds=(Number(0.1, 10), 0.8))
def open(piece, time, angle, seconds):
    return _swing(piece, time, seconds, angle)


@acts("door", "the door swings shut", sound="door", seconds=(Number(0.1, 10), 0.6))
def close(piece, time, seconds):
    return _swing(piece, time, seconds, 0.0)


@piece("a lamp that lights a room: on a stand, or hanging when given a height", color=(Color(), color("#ffcf8a")), strength=(Number(0.1, 20), 1.0))
def lamp(piece, color, strength):
    hanging = piece.rest.translation.z - piece.stage.ground.height(*piece.rest.translation[:2]) > 0.5
    brass = material("brass", "polished")
    if hanging:
        piece.body.cylinder((0, 0, 0.1), (0, 0, 1.2), 0.012, 0.012, brass, segments=6)
    else:
        piece.body.revolve([(0.16, 0), (0.03, 0.06), (0.025, 1.45), (0.07, 1.5)], brass, segments=10)
    top = 0.0 if hanging else 1.6
    piece.body.ball((0, 0, top), 0.11, material(color, grain=0.0, glow=9.0), segments=10, rings=6)
    piece.light((0, 0, top), 320 * strength, "#ffcf8a")
    piece.finish()


@piece("a candle on a holder, burning")
def candle(piece):
    piece.body.revolve([(0.07, 0), (0.02, 0.03), (0.02, 0.06)], material("brass", "polished"), segments=8)
    piece.body.cylinder((0, 0, 0.05), (0, 0, 0.22), 0.016, 0.014, material("cream", grain=0.0), segments=8)
    piece.body.revolve([(0, 0.22), (0.014, 0.245), (0, 0.29)], material("#ffb040", grain=0.0, glow=20.0), segments=6)
    piece.light((0, 0, 0.3), 30, "#ffb060", 0.05)
    piece.finish()


# ---------------------------------------------------------------- things for a hand
@held("a musket; bayonet fixes a blade", bayonet=(Flag(), False))
def musket(piece, bayonet):
    body = piece.body
    body.capsule((0, -0.38, -0.04), (0, 0.1, 0), 0.032, 0.026, material("walnut", "wood"), squash=(0.7, 1.0), segments=8, rings=2)
    body.cylinder((0, 0.05, 0.005), (0, 1.05, 0.005), 0.014, 0.012, material("iron", "metal"), segments=8)
    body.box((0, 0.02, 0.03), (0.02, 0.1, 0.03), material("brass", "polished"))
    piece.reach = 1.05
    if bayonet:
        body.capsule((0.016, 1.0, 0.005), (0.016, 1.42, 0.005), 0.008, 0.003, material("steel", "polished"), segments=6, rings=2)
        piece.reach = 1.42
    piece.finish()


@held("a sword")
def sword(piece):
    piece.body.capsule((0, -0.08, 0), (0, 0.05, 0), 0.016, 0.016, material("black"), segments=6, rings=2)
    piece.body.box((0, 0.06, 0), (0.12, 0.02, 0.03), material("gold", "polished"))
    piece.body.capsule((0, 0.07, 0), (0, 0.92, 0), 0.014, 0.004, material("steel", "polished"), squash=(1.0, 0.3), segments=6, rings=2)
    piece.reach = 0.92
    piece.finish()


@held("a brass spyglass")
def spyglass(piece):
    piece.body.cylinder((0, -0.12, 0), (0, 0.14, 0), 0.022, 0.026, material("brass", "polished"), segments=10)
    piece.body.cylinder((0, 0.14, 0), (0, 0.36, 0), 0.028, 0.034, material("walnut", "wood"), segments=10)
    piece.finish()


@held("a gunner's linstock: a staff with a glowing slow match")
def linstock(piece):
    piece.body.capsule((0, -0.3, 0), (0, 0.72, 0), 0.014, 0.012, material("walnut", "wood"), segments=6, rings=2)
    piece.body.ball((0, 0.75, 0), 0.026, material("#ff7a1a", grain=0.0, glow=12.0), segments=6, rings=3)
    piece.reach = 0.75
    piece.finish()


@held("a ramrod or sponge staff for a gun")
def ramrod(piece):
    piece.body.capsule((0, -0.5, 0), (0, 1.25, 0), 0.016, 0.016, material("oak", "wood"), segments=6, rings=2)
    piece.body.cylinder((0, 1.2, 0), (0, 1.42, 0), 0.055, 0.055, material("cream", "cloth"), segments=8)
    piece.reach = 1.42
    piece.finish()


@held("a walking staff, pike or pole", length=(Number(0.5, 4), 1.8), color=(Color(), color("oak")))
def staff(piece, length, color):
    piece.body.capsule((0, -length * 0.45, 0), (0, length * 0.55, 0), 0.017, 0.014, material(color, "wood"), segments=6, rings=2)
    piece.reach = length * 0.55
    piece.finish()


@held("a sheet of paper, a letter or a document", color=(Color(), color("paper")))
def paper(piece, color):
    piece.body.box((0, 0.1, 0.0), (0.21, 0.28, 0.004), material(color, "cloth", grain=0.02), rotation=rotation_y(90))
    piece.finish()


@held("a small card, ticket or note; text is written on it", color=(Color(), color("paper")), text=(Text(12), ""))
def card(piece, color, text):
    piece.body.box((0, 0.06, 0), (0.004, 0.16, 0.11), material(color, "cloth", grain=0.02))
    piece.finish()
    if text:
        lettering = _lettering(piece.id + "_text", text, 0.14, 0.09, color_of_ink(color))
        lettering.parent, lettering.matrix_basis = piece.root, placement((0.003, 0.06, 0), rotation_z(90) @ rotation_x(90))
        lettering["owner"] = piece.id


@held("a book", color=(Color(), color("crimson")))
def book(piece, color):
    piece.body.box((0, 0.08, 0), (0.05, 0.24, 0.17), material(color))
    piece.body.box((0.002, 0.08, 0), (0.04, 0.225, 0.176), material("paper", grain=0.0))
    piece.finish(bevel=0.004)


@held("a lantern, lit")
def lantern(piece):
    piece.body.revolve([(0.05, -0.3), (0.06, -0.28), (0.06, -0.1), (0.02, -0.06), (0.01, 0.0)], material("iron", "metal"), segments=8, capped=False)
    piece.body.ball((0, 0, -0.19), 0.045, material("#ffcf8a", grain=0.0, glow=14.0), segments=8, rings=4)
    piece.light((0, 0, -0.19), 60, "#ffb060", 0.08)
    piece.finish()


@held("a banner on a staff", pattern=(PATTERNS.choice(), "white"))
def banner(piece, pattern):
    piece.body.capsule((0, -0.6, 0), (0, 1.7, 0), 0.018, 0.014, material("walnut", "wood"), segments=6, rings=2)
    _cloth(piece.body, pattern, (0, 1.65, 0), (0, 0, -1.0), (0, -0.66, 0), 12, 8)
    piece.reach = 1.7
    piece.finish()


@held("a hat carried in the hand", style=(HATS.choice(), "bicorne"), **HAT_OPTIONS)
def hat(piece, style, **options):
    piece.body.merge(hat_mesh({"kind": style, **options}), placement(rotation=rotation_x(-90)) @ placement((0, 0, -HAT_LINE + 0.02)))
    piece.finish()


# ---------------------------------------------------------------- custom props from primitives
def _lettering(name, text, width, height, tint):
    """Painted text standing upright in the x-z plane, read from -y, centered on the origin."""
    curve = bpy.data.curves.new(name, "FONT")
    curve.body, curve.align_x, curve.align_y = text, "CENTER", "CENTER"
    curve.size = min(height * 0.8, width * 1.5 / max(len(text), 1))
    made = bpy.data.objects.new(name, curve)
    made.data.materials.append(material(tint, grain=0.0, roughness=0.8))
    made.matrix_basis = rotation_x(90).to_4x4()
    bpy.context.scene.collection.objects.link(made)
    return made


def color_of_ink(paper_tint):
    """Ink that reads on a paper color: dark on light, light on dark."""
    return color("black") if sum(paper_tint[:3]) > 0.6 else color("white")


def primitive(about, sizes):
    return PRIMITIVES.register(about, sizes=sizes)


@primitive("a box", "[x, y, z]")
def box(builder, size, paint, part):
    builder.box((0, 0, 0), size, paint)


@primitive("a thin board, lying flat", "[length, width, thickness]")
def plank(builder, size, paint, part):
    builder.box((0, 0, 0), size, paint)


@primitive("an upright cylinder", "[diameter, height]")
def cylinder(builder, size, paint, part):
    builder.cylinder((0, 0, -size[1] / 2), (0, 0, size[1] / 2), size[0] / 2, size[0] / 2, paint, segments=20)


@primitive("an upright cone", "[diameter, height]")
def cone(builder, size, paint, part):
    builder.revolve([(size[0] / 2, -size[1] / 2), (0, size[1] / 2)], paint, segments=20)


@primitive("a ball or an egg", "[diameter] or [x, y, z]")
def sphere(builder, size, paint, part):
    builder.ball((0, 0, 0), 0.5, paint, scale=tuple(size) if len(size) == 3 else size[0], segments=18, rings=9)


@primitive("a turned shape: `profile` is a list of [radius, height] from bottom to top, spun about the upright axis", "none; give `profile`")
def lathe(builder, size, paint, part):
    builder.revolve(part["profile"], paint, segments=20)


@primitive("a flat upright plaque that carries `text`, read from the front", "[width, height]")
def plaque(builder, size, paint, part):
    builder.box((0, 0, 0), (size[0], 0.012, size[1]), paint)


SIZE_COUNTS = {"box": (3,), "plank": (3,), "cylinder": (2,), "cone": (2,), "sphere": (1, 3), "lathe": (0,), "plaque": (2,)}


class CustomProp:
    """The field for a prop a design composes from primitive parts."""

    PART = Record(
        id=Text(40), shape=PRIMITIVES.choice(), size=(Many(Number(0.001, 100), most=3), []), profile=(Many(VectorField(2, -100, 100), least=2), None),
        position=(VectorField(3), (0.0, 0.0, 0.0)), rotation=(VectorField(3), None), color=(Color(), color("oak")), finish=(FINISHES.choice(), "paint"),
        parent=(Text(40), None), pivot=(VectorField(3), (0.0, 0.0, 0.0)), points=(Mapping(VectorField(3)), {}), text=(Text(24), None), text_color=(Color(), None),
        repeat=(Record(count=VectorField(2, 1, 40), step=VectorField(2), first=(Whole(0, 9999), 0)), None), solid=(Flag(), True),
    )  # fmt: skip
    FIELD = Record(about=(Text(200), ""), parts=Many(PART, least=1), points=(Mapping(VectorField(3)), {}))

    def read(self, value, path, reading):
        prop = self.FIELD.read(value, path, reading)
        if prop is None:
            return None
        known, sound = [], True
        for index, part in enumerate(prop["parts"]):
            part_path = f"{path}.parts[{index}]"
            if part["id"] in known:
                sound = reading.fail(f"{part_path}.id", f"the id {show(part['id'])} is used twice in this prop; give every part its own id")
            if part["parent"] is not None and part["parent"] not in known:
                sound = reading.fail(f"{part_path}.parent", f"unknown part {show(part['parent'])}; a parent must be an earlier part of this prop: {', '.join(known) or 'none yet'}")
            if len(part["size"]) not in SIZE_COUNTS[part["shape"]]:
                sound = reading.fail(f"{part_path}.size", f"a {part['shape']} takes size {PRIMITIVES[part['shape']].facts['sizes']}, got {show(part['size'])}")
            if part["shape"] == "lathe" and not part["profile"]:
                sound = reading.fail(part_path, "a lathe needs a `profile`: a list of [radius, height] from bottom to top")
            if part["shape"] == "plaque" and part["text"] is None:
                sound = reading.fail(part_path, "a plaque needs a `text`")
            known.append(part["id"])
        return prop if sound is not None else None

    def describe(self):
        return self.FIELD.describe()


def build_custom(piece, prop):
    """Draw a custom prop: every part its own object, so a shot can move it."""
    piece.front = 180.0
    children = {}
    for part in prop["parts"]:
        children.setdefault(part["parent"], []).append(part)
    low, high = Vector((math.inf,) * 3), Vector((-math.inf,) * 3)

    def build(part, parent, suffix, number, origin):
        nonlocal low, high
        builder = MeshBuilder()
        PRIMITIVES[part["shape"]].make(builder, part["size"], material(part["color"], part["finish"]), part)
        part_id = part["id"] + suffix
        rotation = None if part["rotation"] is None else rotation_z(part["rotation"][2]) @ rotation_y(part["rotation"][1]) @ rotation_x(part["rotation"][0])
        made = piece.part(part_id, builder, origin, rotation=rotation, pivot=part["pivot"], points=part["points"], parent=parent)
        if part["text"] is not None:
            tint = part["text_color"] or color_of_ink(part["color"])
            text = _lettering(f"{piece.id}_{part_id}_text", part["text"].replace("{n}", str(number)), part["size"][0], part["size"][1], tint)
            text.parent, text.location = made.made, (0, -0.008, 0)
            text["owner"] = piece.id
        corners = [made.matrix(0.0) @ Vector(vertex) for vertex in builder.vertices]
        part_low, part_high = Vector(min(corner[axis] for corner in corners) for axis in range(3)), Vector(max(corner[axis] for corner in corners) for axis in range(3))
        in_piece = piece.rest.inverted()
        part_low, part_high = in_piece @ part_low, in_piece @ part_high
        part_low, part_high = Vector(map(min, part_low, part_high)), Vector(map(max, part_low, part_high))
        low, high = Vector(map(min, low, part_low)), Vector(map(max, high, part_high))
        if part["solid"] and parent is None:
            piece.block(part_low, part_high)
        for child in children.get(part["id"], []):
            place(child, made, suffix, number)

    def place(part, parent, suffix="", number=0):
        repeat = part["repeat"]
        if repeat is None:
            build(part, parent, suffix, number, Vector(part["position"]))
            return
        columns, rows = int(repeat["count"][0]), int(repeat["count"][1])
        for copy in range(columns * rows):
            shift = Vector((repeat["step"][0] * (copy % columns), 0, -abs(repeat["step"][1]) * (copy // columns)))
            build(part, parent, f"{suffix}_{repeat['first'] + copy}", repeat["first"] + copy, Vector(part["position"]) + shift)

    for part in children.get(None, []):
        place(part, None)
    piece.points.update({name: Vector(point) for name, point in prop["points"].items()})
    piece.focus, piece.size = (low + high) / 2, high - low
