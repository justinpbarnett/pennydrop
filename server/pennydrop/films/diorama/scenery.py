"""The set a shot plays on: the ground and its water, rooms, the sky and the weather.

The ground is one grid of heights. The terrain mesh and `Ground.height` read the same grid,
so a foot placed by the engine stands on what the camera sees.
"""

import itertools
import math

import bpy
from mathutils import Vector

from .maths import clamp, lerp, ramp, rotation_z, scatter
from .mesh import MeshBuilder
from .paint import FINISHES, Color, color, material, mix
from .props import PIECES, Piece
from .spec import Choice, Identifier, Kinded, Many, Number, Record, Registry
from .spec import Vector as VectorField

FEATURES = Registry("ground feature")
COVERS = Registry("ground cover")
WATERS = Registry("water kind")
SKIES = Registry("time of day")
WEATHER = Registry("weather")
WALLS = ["north", "south", "east", "west"]
WALL_THICKNESS = 0.15
CURB_HEIGHT = 0.12
FLOOR_LIFT = 0.03
REGION = VectorField(4)
SPOT = VectorField(2)

for _name, _about, _base, _patch in (
    ("grass", "green grass", "#6f8f4a", "#5d7d3f"), ("dry_grass", "sun dried grass and dust", "#b79a6d", "#a08a52"), ("sand", "sand", "#d9c891", "#c9b47e"),
    ("earth", "bare soil", "#8b6f4a", "#7a5f40"), ("rock", "bare rock", "#8f8a80", "#77736b"), ("snow", "snow", "#e8ecf0", "#d5dde6"),
    ("paved", "stone paving", "#9a958c", "#8a857d"),
):  # fmt: skip
    COVERS.add(_name, _about, make=(color(_base), color(_patch)))

WATERS.add("sea", "open sea with a swell", make=("#2f7890", 0.35))
WATERS.add("lake", "a calm lake or pond", make=("#3f7f86", 0.8))
WATERS.add("river", "a river or canal", make=("#4a7f7a", 1.2))


# ---------------------------------------------------------------- ground features
def _feature(about, **options):
    return FEATURES.register(about, options)


def _along(path, x, y):
    """How far a point lies from a path of spots."""
    best = math.inf
    for start, end in itertools.pairwise(path):
        span = Vector(end) - Vector(start)
        share = clamp((Vector((x, y)) - Vector(start)).dot(span) / max(span.length_squared, 1e-9))
        best = min(best, (Vector(start) + span * share - Vector((x, y))).length)
    return best


RADIUS = VectorField(2, 0.5, 1000)
PATH = Many(SPOT, least=2)


@_feature("a rounded hill; radius is [east-west, north-south]", position=SPOT, radius=RADIUS, height=Number(-50, 200))
def hill(x, y, level, tint, position, radius, height):
    away = math.hypot((x - position[0]) / radius[0], (y - position[1]) / radius[1])
    return level + height * (1 - ramp(away, 0, 1)), tint


@_feature("level ground at a set height, blending out at its edge", position=SPOT, radius=RADIUS, height=Number(-50, 200))
def plateau(x, y, level, tint, position, radius, height):
    away = math.hypot((x - position[0]) / radius[0], (y - position[1]) / radius[1])
    return lerp(height, level, ramp(away, 0.7, 1)), tint


@_feature("a long ridge along a path of spots", path=PATH, width=Number(1, 500), height=Number(0, 200))
def ridge(x, y, level, tint, path, width, height):
    return level + height * (1 - ramp(_along(path, x, y), 0, width / 2)), tint


@_feature("a valley or ditch dug along a path of spots", path=PATH, width=Number(0.5, 500), depth=Number(0, 100))
def valley(x, y, height, tint, path, width, depth):
    return height - depth * (1 - ramp(_along(path, x, y), 0, width / 2)), tint


@_feature("ground that falls away: from position it drops by `drop` over `length` toward a bearing", position=SPOT, toward=Number(0, 360), length=Number(1, 2000), drop=Number(-200, 200))
def slope(x, y, height, tint, position, toward, length, drop):
    forward = (x - position[0]) * math.sin(math.radians(toward)) + (y - position[1]) * math.cos(math.radians(toward))
    return height - drop * ramp(forward, 0, length), tint


@_feature("a road or path painted along a path of spots", path=PATH, width=(Number(0.5, 60), 3.0), color=(Color(), color("#c9b08a")))
def road(x, y, height, tint, path, width, color):
    return height, mix(tint, color, 1 - ramp(_along(path, x, y), width * 0.35, width * 0.6))


@_feature("a patch of ground in another color; region is [west, south, east, north]", region=REGION, color=Color())
def field(x, y, height, tint, region, color):
    inside = min(x - region[0], region[2] - x, y - region[1], region[3] - y)
    return height, mix(tint, color, ramp(inside, 0, 1.5))


GROUND = Record(
    height=(Number(-100, 500), 0.0), cover=(COVERS.choice(), "grass"), rough=(Number(0, 5), 0.15), seed=(Number(0, 99), 1.0),
    extent=(REGION, None), features=(Many(Kinded(FEATURES)), []),
)  # fmt: skip
WATER = Record(kind=(WATERS.choice(), "sea"), region=REGION, level=(Number(-100, 500), 0.0), shore=(Number(0.5, 500), 10.0))


class Ground:
    """The terrain, its water and every raised floor, with the questions staging asks of them."""

    def __init__(self, ground, waters, bounds):
        self.bounds, self._ground, self._waters, self._floors, self._waves = bounds, ground, waters, [], []
        self.extent = ground["extent"] or (bounds[0] - 40, bounds[1] - 40, bounds[2] + 40, bounds[3] + 40)
        west, south, east, north = self.extent
        self._step = clamp(max(east - west, north - south) / 200, 0.4, 2.5)
        self._columns, self._rows = int((east - west) / self._step) + 2, int((north - south) / self._step) + 2
        self._cells = [[self._shape(west + column * self._step, south + row * self._step) for column in range(self._columns)] for row in range(self._rows)]
        self._build_terrain()
        for water in waters:
            self._build_water(water)

    def _dug(self, water, x, y):
        """How deep into a body of water a spot lies, 0 on its bank to 1 past the shore."""
        west, south, east, north = water["region"]
        from_each_bank = (x - west, y - south, east - x, north - y)
        # An edge that runs off the built terrain is open water, not a bank.
        banks = [distance for distance, edge, limit in zip(from_each_bank, water["region"], self.extent, strict=True) if abs(edge - limit) > 1]
        return ramp(min(banks, default=math.inf), 0, water["shore"])

    def _shape(self, x, y):
        """Height and color of the terrain at a spot, worked out from the set's parameters."""
        ground = self._ground
        height = ground["height"]
        base, patch = COVERS[ground["cover"]].make
        seed = ground["seed"]
        tint = mix(base, patch, 0.5 + 0.5 * math.sin(x * 0.11 + seed) * math.cos(y * 0.13 + seed * 1.7))
        for water in self._waters:
            height = lerp(height, min(height, water["level"] - 1.5), self._dug(water, x, y))
        for feature in ground["features"]:
            options = {key: value for key, value in feature.items() if key != "kind"}
            height, tint = FEATURES[feature["kind"]].make(x, y, height, tint, **options)
        height += ground["rough"] * (math.sin(x * 0.21 + seed) * math.cos(y * 0.17 + seed * 1.3) + 0.5 * math.sin(x * 0.53 + y * 0.41 + seed * 2))
        for water in self._waters:
            if self._dug(water, x, y) > 0:
                tint = mix(tint, color("sand"), 1 - ramp(height, water["level"] + 0.2, water["level"] + 1.4))
                tint = mix(tint, color("#3c5a5a"), ramp(water["level"] - height, 0.1, 1.2))
        return height, tint

    def _build_terrain(self):
        west, south = self.extent[0], self.extent[1]
        vertices = [(west + column * self._step, south + row * self._step, self._cells[row][column][0]) for row in range(self._rows) for column in range(self._columns)]
        faces = [(row * self._columns + column, row * self._columns + column + 1, (row + 1) * self._columns + column + 1, (row + 1) * self._columns + column) for row in range(self._rows - 1) for column in range(self._columns - 1)]
        data = bpy.data.meshes.new("ground")
        data.from_pydata(vertices, [], faces)
        data.polygons.foreach_set("use_smooth", [True] * len(faces))
        tints = data.color_attributes.new("tint", "FLOAT_COLOR", "POINT")
        tints.data.foreach_set("color", [channel for row in self._cells for cell in row for channel in cell[1]])
        paint = bpy.data.materials.new("terrain")
        paint.use_nodes = True
        tree = paint.node_tree
        surface = tree.nodes["Principled BSDF"]
        surface.inputs["Roughness"].default_value = 0.95
        tint, coordinates, noise, shade, spread = (tree.nodes.new(kind) for kind in ("ShaderNodeAttribute", "ShaderNodeTexCoord", "ShaderNodeTexNoise", "ShaderNodeMix", "ShaderNodeMapRange"))
        tint.attribute_name = "tint"
        noise.inputs["Scale"].default_value, noise.inputs["Detail"].default_value = 0.9, 5
        shade.data_type, shade.blend_type = "RGBA", "MULTIPLY"
        shade.inputs[0].default_value = 1.0
        spread.inputs[3].default_value, spread.inputs[4].default_value = 0.72, 1.22
        relief, fine = tree.nodes.new("ShaderNodeBump"), tree.nodes.new("ShaderNodeTexNoise")
        relief.inputs["Strength"].default_value, fine.inputs["Scale"].default_value = 0.25, 14
        for source, target in ((coordinates.outputs["Object"], noise.inputs["Vector"]), (noise.outputs[0], spread.inputs[0]), (tint.outputs["Color"], shade.inputs[6]), (spread.outputs[0], shade.inputs[7]),
                               (shade.outputs[2], surface.inputs["Base Color"]), (coordinates.outputs["Object"], fine.inputs["Vector"]), (fine.outputs[0], relief.inputs["Height"]), (relief.outputs[0], surface.inputs["Normal"])):  # fmt: skip
            tree.links.new(source, target)
        data.materials.append(paint)
        made = bpy.data.objects.new("ground", data)
        made["owner"] = "ground"
        bpy.context.scene.collection.objects.link(made)

    def _build_water(self, water):
        tint, scale = WATERS[water["kind"]].make
        tint = color(tint)
        paint = bpy.data.materials.new("water")
        paint.use_nodes = True
        tree = paint.node_tree
        surface = tree.nodes["Principled BSDF"]
        surface.inputs["Roughness"].default_value, surface.inputs["Coat Weight"].default_value = 0.16, 0.6
        coordinates, waves, relief, shade = (tree.nodes.new(kind) for kind in ("ShaderNodeTexCoord", "ShaderNodeTexNoise", "ShaderNodeBump", "ShaderNodeMix"))
        waves.noise_dimensions = "4D"
        waves.inputs["Scale"].default_value, waves.inputs["Detail"].default_value = scale, 3
        relief.inputs["Strength"].default_value, relief.inputs["Distance"].default_value = 0.5, 0.6
        shade.data_type = "RGBA"
        shade.inputs[6].default_value = tint
        shade.inputs[7].default_value = (tint[0] * 1.9 + 0.03, tint[1] * 1.5 + 0.03, tint[2] * 1.3 + 0.03, 1)
        for source, target in ((coordinates.outputs["Object"], waves.inputs["Vector"]), (waves.outputs[0], relief.inputs["Height"]), (relief.outputs[0], surface.inputs["Normal"]),
                               (waves.outputs[0], shade.inputs[0]), (shade.outputs[2], surface.inputs["Base Color"])):  # fmt: skip
            tree.links.new(source, target)
        west, south, east, north = water["region"]
        builder = MeshBuilder()
        builder.add([(west, south, water["level"]), (east, south, water["level"]), (east, north, water["level"]), (west, north, water["level"])], [(0, 1, 2, 3)], paint)
        builder.build("water")["owner"] = "water"
        self._waves.append(waves.inputs["W"])

    def flow(self, time):
        for waves in self._waves:
            waves.default_value = time * 0.5

    def add_floor(self, rest, low, high, level):
        """A raised floor people can stand on: a rectangle in a piece's own space, level above the piece's origin."""
        self._floors.append((rest.inverted(), low, high, rest.translation.z + level))

    def height(self, x, y):
        """The height people stand at: the terrain, or the highest floor over this spot."""
        column, row = (x - self.extent[0]) / self._step, (y - self.extent[1]) / self._step
        left, lower = int(clamp(column, 0, self._columns - 2)), int(clamp(row, 0, self._rows - 2))
        across, up = clamp(column - left), clamp(row - lower)
        cells = self._cells
        height = lerp(lerp(cells[lower][left][0], cells[lower][left + 1][0], across), lerp(cells[lower + 1][left][0], cells[lower + 1][left + 1][0], across), up)
        for inverse, low, high, level in self._floors:
            local = inverse @ Vector((x, y, 0))
            if low[0] <= local.x <= high[0] and low[1] <= local.y <= high[1]:
                height = max(height, level)
        return height

    def in_water(self, x, y):
        return any(water["region"][0] < x < water["region"][2] and water["region"][1] < y < water["region"][3] and self.height(x, y) < water["level"] - 0.05 for water in self._waters)

    def water_level(self, x, y):
        """The level of the water over a spot, or None on dry land."""
        return next((water["level"] for water in self._waters if water["region"][0] < x < water["region"][2] and water["region"][1] < y < water["region"][3] and self.height(x, y) < water["level"]), None)

    def inside(self, x, y, margin=0.0):
        return self.bounds[0] - margin <= x <= self.bounds[2] + margin and self.bounds[1] - margin <= y <= self.bounds[3] + margin


# ---------------------------------------------------------------- rooms
OPENING = {"wall": Choice(WALLS, "wall"), "offset": Number(0, 200), "width": (Number(0.3, 20), 1.0), "height": (Number(0.3, 20), 2.1)}
ROOM = Record(
    id=Identifier(), origin=SPOT, size=VectorField(3, 1, 200),
    floor=(Record(color=(Color(), color("oak")), finish=(FINISHES.choice(), "wood")), {"color": color("oak"), "finish": "wood"}),
    walls=(Record(color=(Color(), color("cream")), finish=(FINISHES.choice(), "matte"), **{wall: (Choice(["wall", "cutaway", "none"], "wall form"), "wall") for wall in WALLS}), None),
    windows=(Many(Record(**OPENING, sill=(Number(0, 10), 0.9))), []),
    doors=(Many(Record(**OPENING, id=(Identifier(), None), color=(Color(), color("walnut")))), []),
    light=(Number(0, 10), 1.0),
)  # fmt: skip
WALL_DEFAULTS = {"color": color("cream"), "finish": "matte", **dict.fromkeys(WALLS, "wall")}


def build_room(stage, room):
    """A room as a piece: floor, walls with their openings, door leaves and a soft light from above."""
    width, depth, height = room["size"]
    walls = room["walls"] or WALL_DEFAULTS
    base = stage.ground.height(*room["origin"])
    piece = Piece(stage, room["id"], "room", (*room["origin"], base), 0.0)
    piece.body.box((width / 2, depth / 2, FLOOR_LIFT - 0.1), (width, depth, 0.2), material(room["floor"]["color"], room["floor"]["finish"], grain_scale=1.5))
    stage.ground.add_floor(piece.rest, (0, 0), (width, depth), FLOOR_LIFT)
    paint = material(walls["color"], walls["finish"])
    doors = []
    for wall in WALLS:
        if walls[wall] == "none":
            continue
        length = width if wall in ("north", "south") else depth
        cut = walls[wall] == "cutaway"
        openings = [] if cut else sorted(
            [(window["offset"], window["width"], window["sill"], window["sill"] + window["height"]) for window in room["windows"] if window["wall"] == wall]
            + [(door["offset"], door["width"], 0.0, door["height"]) for door in room["doors"] if door["wall"] == wall]
        )  # fmt: skip

        def span(start, end, bottom, top, solid=True, wall=wall):
            """One upright slab of this wall between two distances along it."""
            if end - start < 0.01 or top - bottom < 0.01:
                return
            middle, across = (start + end) / 2, {"south": 0.0, "north": depth, "west": 0.0, "east": width}[wall]
            center = (middle, across, (bottom + top) / 2) if wall in ("north", "south") else (across, middle, (bottom + top) / 2)
            size = (end - start, WALL_THICKNESS, top - bottom) if wall in ("north", "south") else (WALL_THICKNESS, end - start, top - bottom)
            piece.body.box(center, size, paint)
            if solid:
                piece.block(Vector(center) - Vector(size) / 2, Vector(center) + Vector(size) / 2)

        top = CURB_HEIGHT if cut else height
        reached = -WALL_THICKNESS / 2
        for offset, wide, bottom, opening_top in openings:
            span(reached, offset - wide / 2, 0, top)
            span(offset - wide / 2, offset + wide / 2, 0, bottom)
            span(offset - wide / 2, offset + wide / 2, opening_top, top, solid=False)
            reached = offset + wide / 2
        span(reached, length + WALL_THICKNESS / 2, 0, top)
        doors += [(wall, door) for door in room["doors"] if door["wall"] == wall and door["id"] and not cut]
    piece.finish(bevel=0.01)
    piece.focus = Vector((width / 2, depth / 2, 1.0))
    stage.pieces[piece.id] = piece
    for wall, door in doors:
        across = {"south": 0.0, "north": depth, "west": 0.0, "east": width}[wall]
        spot = (door["offset"], across) if wall in ("north", "south") else (across, door["offset"])
        leaf = Piece(stage, door["id"], "door", piece.rest @ Vector((*spot, FLOOR_LIFT)), 0.0 if wall in ("north", "south") else 90.0)
        PIECES["door"].make(leaf, width=door["width"], height=door["height"], color=door["color"])
        stage.pieces[leaf.id] = leaf
    if room["light"]:
        data = bpy.data.lights.new(room["id"] + "_light", "AREA")
        data.shape, data.size, data.size_y = "RECTANGLE", width, depth
        data.energy, data.color = 55 * width * depth * room["light"], color("#fff0d8")[:3]
        lamp = bpy.data.objects.new(room["id"] + "_light", data)
        lamp.location = piece.rest @ Vector((width / 2, depth / 2, height + 0.6))
        bpy.context.scene.collection.objects.link(lamp)


# ---------------------------------------------------------------- sky and weather
def _sky(name, about, **look):
    SKIES.add(name, about, make={key: color(value) if isinstance(value, str) else value for key, value in look.items()})


_sky("day", "full daylight", sun_energy=3.3, sun_color="#ffe2bd", fill_energy=0.6, fill_color="#a9c4ff", horizon="#f6dfb8", zenith="#6fa3d8", floor="#b79a6d", strength=1.0, stars=0.0)
_sky("dawn", "early light, low and warm", sun_energy=2.5, sun_color="#ffc590", fill_energy=0.5, fill_color="#a9b4ff", horizon="#f7c9a0", zenith="#7f9fd0", floor="#8a7560", strength=0.8, stars=0.0)
_sky("dusk", "evening light, orange and fading", sun_energy=2.2, sun_color="#ff9a5a", fill_energy=0.5, fill_color="#8f9cf0", horizon="#f4a070", zenith="#4f6aa8", floor="#6a5548", strength=0.7, stars=0.15)
_sky("night", "moonlight under stars", sun_energy=3.4, sun_color="#a9c0ff", fill_energy=1.1, fill_color="#7f96e8", horizon="#2c4274", zenith="#070b1c", floor="#0c1020", strength=0.8, stars=1.0)

GREY = color("#aeb3bb")
WEATHER.add("clear", "open sky", make={"sun": 1.0, "grey": 0.0, "rain": 0.0, "snow": 0.0, "fog": 0.0})
WEATHER.add("overcast", "grey cloud, soft light, no hard shadows", make={"sun": 0.35, "grey": 0.75, "rain": 0.0, "snow": 0.0, "fog": 0.0})
WEATHER.add("rain", "steady rain under grey cloud", make={"sun": 0.45, "grey": 0.8, "rain": 1.0, "snow": 0.0, "fog": 0.0})
WEATHER.add("snow", "falling snow under grey cloud", make={"sun": 0.4, "grey": 0.7, "rain": 0.0, "snow": 1.0, "fog": 0.0})
WEATHER.add("fog", "thick mist that hides the distance", make={"sun": 0.4, "grey": 0.85, "rain": 0.0, "snow": 0.0, "fog": 1.0})

SKY_KEYS = {"time": (SKIES.choice(), None), "sun_bearing": (Number(0, 360), None), "sun_height": (Number(2, 90), None), "weather": (WEATHER.choice(), None)}
SKY = Record(**SKY_KEYS)
SKY_DEFAULTS = {"time": "day", "sun_bearing": 215.0, "sun_height": 40.0, "weather": "clear"}
SKY_CHANGE = {"sky": SKY, "seconds": (Number(0, 60), 2.0)}
FAR = 900.0
CLEAR_OF_THE_LENS = 2.0


def merged_sky(*skies):
    """Later skies override the fields they give."""
    merged = dict(SKY_DEFAULTS)
    for sky in skies:
        merged.update({key: value for key, value in (sky or {}).items() if value is not None})
    return merged


def _conditions(sky):
    """Everything the sky and its lights are set to, as numbers and colors that blend."""
    look, weather = SKIES[sky["time"]].make, WEATHER[sky["weather"]].make
    dim = lerp(1.0, 0.55, weather["grey"])
    grey = mix(GREY, color("#20242c"), look["stars"])
    return {
        "sun_energy": look["sun_energy"] * weather["sun"], "sun_color": look["sun_color"], "fill_energy": look["fill_energy"] * (1 + 1.6 * weather["grey"]), "fill_color": look["fill_color"],
        "horizon": mix(look["horizon"], grey, weather["grey"]), "zenith": mix(look["zenith"], grey, weather["grey"] * 0.9), "floor": look["floor"], "strength": look["strength"] * dim,
        "stars": look["stars"] * clamp(1 - 1.4 * weather["grey"]), "rain": weather["rain"], "snow": weather["snow"], "fog": weather["fog"],
        "sun_bearing": sky["sun_bearing"], "sun_height": sky["sun_height"],
    }  # fmt: skip


def _blend(first, second, weight):
    return {key: lerp(value, second[key], weight) if isinstance(value, (int, float)) else mix(value, second[key], weight) for key, value in first.items()}


def _falling(name, count, tall, streak, tint, glow):
    """A box of streaks or flakes, stacked twice so it can fall one box height and start over unseen."""
    builder, paint = MeshBuilder(), material(tint, grain=0.0, glow=glow, roughness=1.0, coat=0.0)
    for index in range(count):
        x, y, z = (scatter(index * 1.1) - 0.5) * 36, (scatter(index * 2.3) - 0.5) * 36, scatter(index * 3.7) * tall
        if x * x + y * y < CLEAR_OF_THE_LENS**2:
            continue
        length = streak * (0.7 + 0.6 * scatter(index * 4.9))
        turn = rotation_z(scatter(index * 5.3) * 180)
        wide = turn @ Vector((0.002 if streak > 0.1 else 0.012, 0, 0))
        for copy in (0, 1):
            low = Vector((x, y, z + copy * tall))
            builder.add([low - wide, low + wide, low + wide + Vector((0.12 * length, 0, length)), low - wide + Vector((0.12 * length, 0, length))], [(0, 1, 2, 3)], paint)
    made = builder.build(name, sharp=180)
    made.visible_shadow = False
    made["owner"] = "effect"
    return made


class Sky:
    """The light of a shot: sun or moon, sky colors, stars and weather, each able to change during the shot."""

    def __init__(self, stage, sky):
        self.stage = stage
        self._changes = [(-math.inf, 0.0, _conditions(sky))]
        self._sky = sky
        self._world = bpy.data.worlds.new("sky")
        bpy.context.scene.world = self._world
        self._world.use_nodes = True
        tree = self._world.node_tree
        self._background = tree.nodes["Background"]
        coordinates, split, spread, self._colors = (tree.nodes.new(kind) for kind in ("ShaderNodeTexCoord", "ShaderNodeSeparateXYZ", "ShaderNodeMapRange", "ShaderNodeValToRGB"))
        spread.inputs[1].default_value, spread.inputs[2].default_value = -0.25, 0.42
        bands = self._colors.color_ramp.elements
        bands[0].position, bands[1].position = 0.18, 1.0
        bands.new(0.27)
        for source, target in ((coordinates.outputs["Generated"], split.inputs[0]), (split.outputs[2], spread.inputs[0]), (spread.outputs[0], self._colors.inputs[0]), (self._colors.outputs[0], self._background.inputs[0])):
            tree.links.new(source, target)
        self._mist = tree.nodes.new("ShaderNodeVolumeScatter")
        self._mist.inputs["Color"].default_value = (0.8, 0.82, 0.86, 1)
        self._mist_link = (self._mist.outputs[0], tree.nodes["World Output"].inputs["Volume"])
        self._sun, self._fill = self._lamp("sun", 7.0, True), self._lamp("fill", 30.0, False)
        self._fill.rotation_euler = Vector((-0.55, 0.65, 0.52)).to_track_quat("Z", "Y").to_euler()
        self._stars = self._build_stars()
        self._moon = MeshBuilder()
        self._moon.ball((0, 0, 0), 22.0, material("#e8ecff", grain=0.0, glow=6.0), segments=16, rings=8)
        self._moon = self._moon.build("moon")
        self._moon.visible_shadow = False
        self._moon["owner"] = "effect"
        self._rain, self._snow = None, None
        stage.animate(self._show)

    def _lamp(self, name, angle, shadow):
        data = bpy.data.lights.new(name, "SUN")
        data.angle, data.use_shadow = math.radians(angle), shadow
        lamp = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(lamp)
        return lamp

    def _build_stars(self):
        builder, paint = MeshBuilder(), material("#dfe6ff", grain=0.0, glow=1.0, roughness=1.0, coat=0.0)
        for star in range(420):
            turn, rise = scatter(star * 1.7) * 2 * math.pi, math.asin(0.04 + 0.96 * scatter(star * 2.9))
            center = Vector((math.cos(turn) * math.cos(rise), math.sin(turn) * math.cos(rise), math.sin(rise))) * FAR
            builder.ball(center, 0.7 + 1.3 * scatter(star * 4.3) ** 3, paint, segments=4, rings=2)
        made = builder.build("stars", sharp=180)
        made.visible_shadow = False
        made["owner"] = "effect"
        self._star_glow = paint.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
        return made

    def change(self, time, seconds, sky):
        """From time on, over seconds, the sky turns into the last sky with these fields changed."""
        self._sky = merged_sky(self._sky, sky)
        self._changes.append((time, seconds, _conditions(self._sky)))
        self.stage.acts(time, time + seconds, lambda now: None)

    def conditions(self, time):
        now = self._changes[0][2]
        for start, seconds, target in self._changes[1:]:
            now = _blend(now, target, ramp(time, start, start + seconds))
        return now

    def _show(self, time):
        now = self.conditions(time)
        bearing, rise = math.radians(now["sun_bearing"]), math.radians(now["sun_height"])
        source = Vector((math.sin(bearing) * math.cos(rise), math.cos(bearing) * math.cos(rise), math.sin(rise)))
        self._sun.rotation_euler = source.to_track_quat("Z", "Y").to_euler()
        self._sun.data.energy, self._sun.data.color = now["sun_energy"], now["sun_color"][:3]
        self._fill.data.energy, self._fill.data.color = now["fill_energy"], now["fill_color"][:3]
        bands = self._colors.color_ramp.elements
        bands[0].color, bands[1].color, bands[2].color = now["floor"], now["horizon"], now["zenith"]
        self._background.inputs[1].default_value = now["strength"]
        self._star_glow.default_value = 14.0 * now["stars"]
        eye = self.stage.camera.eye(time) if self.stage.camera else Vector()
        self._stars.location = eye
        self._stars.scale = (1, 1, 1) if now["stars"] > 0.02 else (0, 0, 0)
        self._moon.location = eye + source * (FAR - 40)
        self._moon.scale = (1, 1, 1) if now["stars"] > 0.3 else (0, 0, 0)
        links, (mist, volume) = self._world.node_tree.links, self._mist_link
        if now["fog"] > 0.01:
            self._mist.inputs["Density"].default_value = 0.035 * now["fog"]
            if not volume.is_linked:
                links.new(mist, volume)
        elif volume.is_linked:
            links.remove(volume.links[0])
        for kind, amount in (("rain", now["rain"]), ("snow", now["snow"])):
            falling = getattr(self, "_" + kind)
            if falling is None and amount > 0.01:
                falling = _falling("rain", 5200, 14.0, 0.5, "#9fb0cc", 0.22) if kind == "rain" else _falling("snow", 1800, 12.0, 0.03, "#ffffff", 0.6)
                setattr(self, "_" + kind, falling)
            if falling is not None:
                tall, speed = (14.0, 17.0) if kind == "rain" else (12.0, 1.6)
                ahead = eye + Vector((0, 0, -4.0))
                falling.location = (ahead.x, ahead.y, ahead.z - (time * speed) % tall)
                falling.scale = (1, 1, 1) if amount > 0.5 else (0, 0, 0)
        self.stage.ground.flow(time)
