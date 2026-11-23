"""What a person looks like: body builds, faces, hair, garments and hats, painted onto the skeleton.

The registries here are the garment vocabulary of the catalog.
"""

from mathutils import Vector

from .maths import placement, rotation_x, rotation_y, rotation_z, scatter
from .mesh import MeshBuilder
from .paint import Color, color, material
from .pose import HIP_X, REST_POSITION, SIDE_X
from .spec import Choice, Flag, Kinded, Many, Registry

HEAD_CENTER = Vector((0, 0, 1.64))
HAT_LINE = 1.735

BUILDS = Registry("build")
BUILDS.add("slight", "narrow and light", make=(0.9, 0.9))
BUILDS.add("average", "ordinary", make=(1.0, 1.0))
BUILDS.add("sturdy", "broad shouldered", make=(1.1, 1.06))
BUILDS.add("heavy", "stout, with a belly", make=(1.18, 1.32))

HAIR = Registry("hair style")
FACIAL_HAIR = Registry("facial hair style")
GLASSES = ["round", "square"]
HATS = Registry("hat")
GARMENTS = Registry("garment")

EXTRA_SKINS = ["skin_pale", "skin_fair", "skin_fair", "skin_tan", "skin_brown", "skin_dark"]
EXTRA_HAIR = ["hair_black", "hair_brown", "hair_brown", "hair_chestnut", "hair_blond", "hair_red", "hair_grey"]
EXTRA_STYLES = ["short", "short", "cropped", "queue", "receding"]


def extra_identity(seed):
    """The face, hair and height of someone without a character, varied by seed."""
    return {
        "name": None,
        "height": 1.66 + 0.16 * scatter(seed),
        "build": ["average", "average", "slight", "sturdy"][int(scatter(seed + 1) * 4)],
        "skin": color(EXTRA_SKINS[int(scatter(seed + 2) * len(EXTRA_SKINS))]),
        "hair": {"style": EXTRA_STYLES[int(scatter(seed + 3) * len(EXTRA_STYLES))], "color": color(EXTRA_HAIR[int(scatter(seed + 4) * len(EXTRA_HAIR))])},
        "facial_hair": {"style": "moustache", "color": color("hair_brown")} if scatter(seed + 5) > 0.8 else None,
        "glasses": None,
    }


class Body:
    """The mesh being painted for one person in one look."""

    def __init__(self, identity, look):
        self.builder = MeshBuilder()
        self.identity, self.look = identity, look
        self.width, self.depth = BUILDS[identity["build"]].make
        self.skin = material(identity["skin"], roughness=0.5)

    def worn(self, garment):
        return self.look.get(garment)

    def paint(self, garment, key="color", **changes):
        return material(self.look[garment][key], **changes)


# ---------------------------------------------------------------- hair
def _hair_cap(body, paint, tilt, reach, radius=0.19):
    body.builder.dome((0, -0.012, 1.65), radius, paint, "head", rotation=rotation_x(tilt), scale=(1, 1, 1.03), segments=16, rings=6, reach=reach)


def _hair_band(body, paint, bottom=1.58):
    """Hair that shows below a hat: around the back of the head as far as the ears, never over the face."""
    body.builder.revolve([(0.15, bottom), (0.18, bottom + 0.03), (0.18, HAT_LINE), (0.15, HAT_LINE)], paint, "head", placement(rotation=rotation_z(180)), segments=12, capped=False, sweep=150)


@HAIR.register("no hair")
def bald(body, paint, covered):
    pass


@HAIR.register("short hair, clear of the face")
def short(body, paint, covered):
    if covered:
        _hair_band(body, paint)
    else:
        _hair_cap(body, paint, 42, 96)


@HAIR.register("very short hair")
def cropped(body, paint, covered):
    if covered:
        _hair_band(body, paint, 1.6)
    else:
        _hair_cap(body, paint, 38, 88, 0.184)


@HAIR.register("bald on top, hair around the back")
def receding(body, paint, covered):
    _hair_band(body, paint, 1.55)


@HAIR.register("short hair with a tail tied at the neck")
def queue(body, paint, covered):
    short(body, paint, covered)
    body.builder.capsule((0, -0.17, 1.55), (0, -0.215, 1.40), 0.04, 0.024, paint, "head", segments=8, rings=3)


@HAIR.register("hair to the shoulders")
def long(body, paint, covered):
    short(body, paint, covered)
    body.builder.revolve([(0.12, 1.36), (0.2, 1.42), (0.2, 1.66), (0.15, 1.7)], paint, "head", placement(rotation=rotation_z(180)), squash=(1, 0.95), segments=12, capped=False, sweep=190)


@HAIR.register("hair to the chin")
def bob(body, paint, covered):
    short(body, paint, covered)
    body.builder.revolve([(0.16, 1.5), (0.205, 1.53), (0.2, 1.7), (0.15, 1.72)], paint, "head", placement(rotation=rotation_z(180)), segments=12, capped=False, sweep=230)


@HAIR.register("short hair with a bun at the back")
def bun(body, paint, covered):
    short(body, paint, covered)
    body.builder.ball((0, -0.17, 1.6 if covered else 1.74), 0.07, paint, "head", segments=10, rings=5)


@HAIR.register("a round mass of curls")
def curly(body, paint, covered):
    short(body, paint, covered)
    for index in range(9):
        turn = rotation_z(180 + (index - 4) * 32)
        height = 1.66 if covered else 1.7 + 0.05 * (index % 2)
        body.builder.ball(turn @ Vector((0, 0.165, 0)) + Vector((0, -0.01, height - (0.06 if covered else 0))), 0.062, paint, "head", segments=8, rings=4)
    if not covered:
        body.builder.ball((0, -0.02, 1.8), 0.09, paint, "head", scale=(1.3, 1.2, 0.7), segments=10, rings=5)


@FACIAL_HAIR.register("a moustache")
def moustache(body, paint):
    for side in (1, -1):
        body.builder.capsule((side * 0.008, 0.172, 1.588), (side * 0.06, 0.155, 1.578), 0.014, 0.008, paint, "head", segments=6, rings=2)


@FACIAL_HAIR.register("a full beard")
def beard(body, paint):
    moustache(body, paint)
    body.builder.ball((0, 0.045, 1.545), 0.152, paint, "head", scale=(1, 1, 0.75), segments=12, rings=6)


@FACIAL_HAIR.register("a small beard on the chin")
def goatee(body, paint):
    moustache(body, paint)
    body.builder.ball((0, 0.135, 1.5), 0.045, paint, "head", scale=(1, 0.8, 1.2), segments=8, rings=4)


@FACIAL_HAIR.register("whiskers down the cheeks")
def sideburns(body, paint):
    for side in (1, -1):
        body.builder.ball((side * 0.15, 0.06, 1.59), 0.05, paint, "head", scale=(0.5, 0.9, 1.5), segments=8, rings=4)


def _head(body):
    builder, identity = body.builder, body.identity
    dark = material("black", roughness=0.3, grain=0.0)
    hair_paint = material(identity["hair"]["color"], roughness=0.8)
    builder.capsule((0, 0, 1.42), (0, 0, 1.52), 0.062, 0.062, body.skin, "chest", segments=10)
    builder.ball(HEAD_CENTER, 0.177, body.skin, "head", scale=(1, 1, 1.05), segments=16, rings=8)
    builder.ball((0, 0.174, 1.615), 0.027, body.skin, "head", segments=8, rings=4)
    builder.ball((0, 0.166, 1.562), 0.02, material("#8a3b33", roughness=0.6, grain=0.0), "head", scale=(1.5, 0.5, 0.35), segments=8, rings=3)
    for side in (1, -1):
        builder.ball((side * 0.066, 0.158, 1.66), 0.021, dark, "head", segments=8, rings=4)
        builder.ball((side * 0.176, 0, 1.63), 0.034, body.skin, "head", scale=(0.45, 0.8, 1.2), segments=8, rings=4)
        if identity["hair"]["style"] != "bald":
            builder.capsule((side * 0.04, 0.164, 1.698), (side * 0.092, 0.148, 1.702), 0.008, 0.006, hair_paint, "head", segments=6, rings=2)
    hat = body.worn("hat")
    covered = bool(hat) and HATS[hat["kind"]].facts["covers_hair"]
    HAIR[identity["hair"]["style"]].make(body, hair_paint, covered)
    if identity["facial_hair"]:
        FACIAL_HAIR[identity["facial_hair"]["style"]].make(body, material(identity["facial_hair"]["color"], roughness=0.8))
    if identity["glasses"]:
        _glasses(body, identity["glasses"])
    if hat:
        builder.merge(hat_mesh(hat), bone="head")


def _glasses(body, style):
    wire = material("charcoal", "metal")
    segments = 4 if style == "square" else 12
    for side in (1, -1):
        rim = placement((side * 0.066, 0.172, 1.66), rotation_x(-90) @ rotation_z(45 if style == "square" else 0))
        body.builder.revolve([(0.034, -0.004), (0.041, -0.004), (0.041, 0.004), (0.034, 0.004)], wire, "head", rim, segments=segments, capped=False)
        body.builder.capsule((side * 0.105, 0.165, 1.662), (side * 0.172, 0.02, 1.665), 0.004, 0.004, wire, "head", segments=4, rings=1)
    body.builder.capsule((-0.028, 0.178, 1.665), (0.028, 0.178, 1.665), 0.004, 0.004, wire, "head", segments=4, rings=1)


# ---------------------------------------------------------------- hats
HAT_OPTIONS = {
    "color": (Color(), color("black")),
    "trim": (Color(), None),
    "band": (Color(), None),
    "plume": (Many(Color(), most=3), []),
    "cockade": (Flag(), False),
}


def hat_field():
    return Kinded(HATS, **HAT_OPTIONS)


def hat_mesh(hat):
    """A hat in head space, standing where a head would wear it."""
    builder = MeshBuilder()
    felt = material(hat["color"], roughness=0.75, coat=0.05)
    trim = material(hat["trim"], "polished") if hat["trim"] else None
    top = HATS[hat["kind"]].make(builder, felt, trim)
    if hat["band"] and top:
        builder.revolve([(0.158, HAT_LINE + 0.012), (0.17, HAT_LINE + 0.012), (0.168, HAT_LINE + 0.05), (0.156, HAT_LINE + 0.05)], material(hat["band"], "cloth"), segments=14, capped=False)
    if hat["cockade"]:
        builder.ball((0.08, 0.15, HAT_LINE + 0.07), 0.04, material("red"), scale=(1, 0.3, 1), segments=8, rings=4)
        builder.ball((0.08, 0.158, HAT_LINE + 0.07), 0.022, material("white"), scale=(1, 0.3, 1), segments=8, rings=4)
    count = len(hat["plume"])
    for index, feather in enumerate(hat["plume"]):
        offset = (index - (count - 1) / 2) * 0.075
        builder.capsule((offset * 0.6, 0.02, top - 0.04), (offset * 1.5, -0.02, top + 0.2), 0.035, 0.05, material(feather, roughness=0.9, coat=0.0), segments=8, rings=3)
    return builder


def _hat(about, covers_hair=True):
    return HATS.register(about, covers_hair=covers_hair)


@_hat("a wide two cornered military hat, worn across")
def bicorne(builder, felt, trim):
    if trim:
        builder.dome((0, 0, HAT_LINE), 1, trim, scale=(0.365, 0.055, 0.25), segments=16, rings=6)
    builder.dome((0, 0, HAT_LINE), 1, felt, scale=(0.35, 0.095, 0.24), segments=16, rings=6)
    builder.dome((0, 0, HAT_LINE), 1, felt, scale=(0.19, 0.19, 0.1), segments=12, rings=3)
    return HAT_LINE + 0.2


@_hat("a three cornered hat")
def tricorne(builder, felt, trim):
    builder.revolve([(0.17, HAT_LINE), (0.33, HAT_LINE + 0.02), (0.3, HAT_LINE + 0.1), (0.17, HAT_LINE + 0.03)], trim or felt, None, placement(rotation=rotation_z(30)), segments=3)
    builder.dome((0, 0, HAT_LINE), 1, felt, scale=(0.18, 0.18, 0.11), segments=12, rings=3)
    return HAT_LINE + 0.1


@_hat("a round hat with a brim and a medium crown")
def round(builder, felt, trim):
    builder.revolve([(0.24, HAT_LINE), (0.25, HAT_LINE + 0.012), (0.24, HAT_LINE + 0.024), (0.165, HAT_LINE + 0.024), (0.152, HAT_LINE + 0.17), (0, HAT_LINE + 0.18)], felt, segments=14)
    return HAT_LINE + 0.17


@_hat("a tall top hat")
def top(builder, felt, trim):
    builder.revolve([(0.225, HAT_LINE), (0.235, HAT_LINE + 0.012), (0.225, HAT_LINE + 0.024), (0.16, HAT_LINE + 0.024), (0.168, HAT_LINE + 0.26), (0, HAT_LINE + 0.265)], felt, segments=14)
    return HAT_LINE + 0.26


@_hat("a tall stiff military cap with a peak")
def shako(builder, felt, trim):
    builder.revolve([(0.17, HAT_LINE - 0.01), (0.165, HAT_LINE + 0.22), (0, HAT_LINE + 0.225)], felt, segments=14)
    builder.box((0, 0.2, HAT_LINE), (0.22, 0.12, 0.02), felt)
    if trim:
        builder.ball((0, 0.17, HAT_LINE + 0.1), 0.04, trim, scale=(1, 0.3, 1.3), segments=8, rings=4)
    return HAT_LINE + 0.21


@_hat("a modern peaked uniform cap")
def cap(builder, felt, trim):
    builder.revolve([(0.168, HAT_LINE - 0.01), (0.172, HAT_LINE + 0.05), (0.2, HAT_LINE + 0.09), (0.19, HAT_LINE + 0.115), (0, HAT_LINE + 0.12)], felt, segments=14)
    builder.box((0, 0.2, HAT_LINE), (0.2, 0.11, 0.016), material("black", roughness=0.3), rotation=rotation_x(-12))
    if trim:
        builder.ball((0, 0.172, HAT_LINE + 0.05), 0.028, trim, scale=(1, 0.3, 1), segments=8, rings=4)
    return HAT_LINE + 0.11


@_hat("a soft flat cap")
def flat_cap(builder, felt, trim):
    builder.dome((0, 0.02, HAT_LINE - 0.005), 1, felt, scale=(0.2, 0.225, 0.1), segments=14, rings=4)
    builder.box((0, 0.21, HAT_LINE), (0.18, 0.09, 0.016), felt, rotation=rotation_x(-10))
    return HAT_LINE + 0.09


@_hat("a knitted cap that hugs the head")
def beanie(builder, felt, trim):
    builder.dome((0, -0.005, HAT_LINE - 0.03), 0.186, felt, scale=(1, 1, 0.75), segments=14, rings=5)
    return HAT_LINE + 0.1


@_hat("a wide brimmed straw or sun hat")
def straw(builder, felt, trim):
    builder.revolve([(0.33, HAT_LINE - 0.015), (0.335, HAT_LINE), (0.165, HAT_LINE + 0.03), (0.155, HAT_LINE + 0.11), (0, HAT_LINE + 0.125)], felt, segments=16)
    return HAT_LINE + 0.12


@_hat("a metal helmet; trim adds a crest")
def helmet(builder, felt, trim):
    builder.dome((0, -0.005, HAT_LINE - 0.04), 0.195, felt, scale=(1, 1.04, 0.92), segments=14, rings=5)
    builder.revolve([(0.19, HAT_LINE - 0.04), (0.235, HAT_LINE - 0.06), (0.19, HAT_LINE - 0.02)], felt, segments=14, capped=False)
    if trim:
        builder.dome((0, -0.02, HAT_LINE + 0.02), 1, trim, scale=(0.03, 0.2, 0.2), segments=10, rings=4)
    return HAT_LINE + 0.15


@_hat("a modern safety helmet")
def hardhat(builder, felt, trim):
    builder.dome((0, 0, HAT_LINE - 0.02), 0.195, felt, scale=(1, 1.05, 0.8), segments=14, rings=5)
    builder.box((0, 0.2, HAT_LINE - 0.012), (0.24, 0.1, 0.016), felt)
    builder.dome((0, 0, HAT_LINE + 0.02), 1, felt, scale=(0.035, 0.19, 0.125), segments=10, rings=4)
    return HAT_LINE + 0.14


@_hat("a hood over the head and shoulders, open at the face", covers_hair=False)
def hood(builder, felt, trim):
    builder.dome((0, -0.015, 1.655), 0.205, felt, rotation=rotation_x(35), segments=14, rings=6, reach=105)
    builder.revolve([(0.15, 1.42), (0.215, 1.48), (0.21, 1.68)], felt, None, placement(rotation=rotation_z(180)), segments=12, capped=False, sweep=235)
    return 0.0


@_hat("a crown")
def crown(builder, felt, trim):
    gold = trim or material("gold", "polished")
    builder.revolve([(0.165, HAT_LINE), (0.172, HAT_LINE + 0.07), (0.158, HAT_LINE + 0.07), (0.152, HAT_LINE)], gold, segments=14, capped=False)
    for index in range(7):
        builder.capsule(rotation_z(index * 360 / 7) @ Vector((0, 0.166, HAT_LINE + 0.06)), rotation_z(index * 360 / 7) @ Vector((0, 0.17, HAT_LINE + 0.13)), 0.022, 0.006, gold, segments=6, rings=2)
    builder.dome((0, 0, HAT_LINE), 1, felt, scale=(0.15, 0.15, 0.1), segments=12, rings=3)
    return HAT_LINE + 0.1


@_hat("a powdered wig with side curls and a tail", covers_hair=False)
def wig(builder, felt, trim):
    builder.dome((0, -0.015, 1.655), 0.2, felt, rotation=rotation_x(38), scale=(1, 1, 1.04), segments=16, rings=6, reach=98)
    for side in (1, -1):
        for row in range(2):
            builder.capsule((side * 0.185, -0.07, 1.6 + row * 0.07), (side * 0.185, 0.05, 1.6 + row * 0.07), 0.036, 0.036, felt, segments=8, rings=3)
    builder.capsule((0, -0.18, 1.56), (0, -0.225, 1.38), 0.042, 0.024, felt, segments=8, rings=3)
    return 0.0


@_hat("a wound cloth turban")
def turban(builder, felt, trim):
    for index, (height, size) in enumerate(((0.0, 0.215), (0.05, 0.205), (0.1, 0.17))):
        builder.ball((0, -0.005, HAT_LINE + height), size, felt, scale=(1, 1, 0.42), rotation=rotation_x(8 - index * 8), segments=14, rings=5)
    return HAT_LINE + 0.13


# ---------------------------------------------------------------- garments
def _garment(about, **options):
    return GARMENTS.register(about, options)


def _skirt_panel(body, paint, bone, top, bottom, length, start=1.0):
    """Half of a skirt, hinged at the hips so it swings with the legs."""
    turn = placement(rotation=rotation_z(180 if bone == "tails" else 0))
    body.builder.revolve([(top, start), (bottom, start - length)], paint, bone, turn, squash=(body.width, 0.78 * body.depth), segments=12, capped=False, sweep=196)


def _torso(body, paint, grow=1.0):
    profile = [(0, 0.965), (0.11, 0.97), (0.165, 1.005), (0.18, 1.10), (0.2, 1.24), (0.208, 1.33), (0.18, 1.41), (0.1, 1.455), (0, 1.465)]
    belly = 1.25 if body.identity["build"] == "heavy" else 1.0
    profile = [(radius * grow * (belly if 1.0 < height < 1.2 else 1.0), height) for radius, height in profile]
    body.builder.revolve(profile, paint, "chest", squash=(body.width, 0.68 * body.depth), segments=16)


def _front_panel(body, paint, center_height, half_width, half_height):
    body.builder.ball((0, 0.106 * body.depth, center_height), 1, paint, "chest", scale=(half_width, 0.04, half_height), segments=10, rings=6)


@_garment("a shirt, blouse or T-shirt", color=(Color(), color("white")), sleeves=(Choice(["long", "short", "rolled", "none"]), "long"), tie=(Color(), None))
def shirt(body, options):
    paint = material(options["color"], "cloth")
    if body.worn("coat") or body.worn("robe"):
        _front_panel(body, paint, 1.385, 0.06, 0.07)
    else:
        _torso(body, paint)
        body.builder.revolve([(0.066, 1.43), (0.084, 1.43), (0.088, 1.475), (0.07, 1.475)], paint, "chest", segments=12, capped=False)
    if options["tie"]:
        body.builder.capsule((0, 0.128 * body.depth, 1.42), (0, 0.142 * body.depth, 1.18), 0.022, 0.03, material(options["tie"], "cloth"), "chest", squash=(1, 0.4), segments=6, rings=2)


@_garment("a sleeveless waistcoat or vest", color=(Color(), color("grey")), buttons=(Color(), None))
def waistcoat(body, options):
    paint = material(options["color"])
    if body.worn("coat") or body.worn("robe"):
        _front_panel(body, paint, 1.2, 0.09, 0.16)
    else:
        body.builder.revolve([(0.17, 0.99), (0.186, 1.10), (0.206, 1.24), (0.214, 1.33), (0.19, 1.4)], paint, "chest", squash=(body.width, 0.7 * body.depth), segments=16, capped=False)
    if options["buttons"]:
        _buttons(body, options["buttons"])


def _buttons(body, tint):
    for height in (1.08, 1.16, 1.24, 1.32):
        body.builder.ball((0, (0.146 - (1.32 - height) * 0.03) * body.depth, height), 0.016, material(tint, "polished"), "chest", segments=6, rings=3)


@_garment(
    "a coat, jacket or uniform coat with sleeves",
    color=(Color(), color("navy")),
    length=(Choice(["jacket", "hip", "tails", "knee", "long"]), "hip"),
    facings=(Color(), None),
    collar=(Color(), None),
    cuffs=(Color(), None),
    buttons=(Color(), None),
    epaulettes=(Color(), None),
)
def coat(body, options):
    builder, paint = body.builder, material(options["color"])
    _torso(body, paint, 1.02)
    length = options["length"]
    if length == "hip":
        builder.revolve([(0.19, 1.02), (0.2, 0.84)], paint, "hips", squash=(body.width, 0.74 * body.depth), segments=14, capped=False)
    elif length == "tails":
        builder.capsule((0, -0.118, 1.0), (0, -0.135, 0.55), 0.165, 0.125, paint, "tails", squash=(1, 0.22), segments=12)
    elif length in ("knee", "long"):
        drop = 0.5 if length == "knee" else 0.78
        _skirt_panel(body, paint, "tails", 0.19, 0.25, drop)
        _skirt_panel(body, paint, "front", 0.19, 0.25, drop)
    if options["facings"]:
        _front_panel(body, material(options["facings"]), 1.235, 0.095, 0.165)
    if options["collar"]:
        builder.revolve([(0.066, 1.43), (0.09, 1.43), (0.095, 1.495), (0.07, 1.495)], material(options["collar"]), "chest", segments=12, capped=False)
    if options["buttons"]:
        _buttons(body, options["buttons"])
    if options["epaulettes"]:
        for side in (1, -1):
            builder.ball((side * 0.24 * body.width, 0, 1.45), 1, material(options["epaulettes"], metallic=0.3), "chest", scale=(0.09, 0.078, 0.032), segments=10, rings=4)


@_garment("a garment to the floor: robe, gown, dress, toga or cassock", color=(Color(), color("cream")), cut=(Choice(["robe", "dress"]), "robe"), trim=(Color(), None))
def robe(body, options):
    paint = material(options["color"], roughness=0.7)
    _torso(body, paint, 1.01)
    hem = 0.36 if options["cut"] == "dress" else 0.29
    for bone in ("tails", "front"):
        _skirt_panel(body, paint, bone, 0.19, hem, 0.93)
        if options["trim"]:
            _skirt_panel(body, material(options["trim"]), bone, hem + 0.004, hem + 0.008, 0.07, start=0.14)
    if options["trim"]:
        body.builder.revolve([(0.066, 1.43), (0.092, 1.43), (0.1, 1.47), (0.07, 1.47)], material(options["trim"]), "chest", segments=12, capped=False)


@_garment("work overalls with a bib, over the shirt", color=(Color(), color("blue")))
def overalls(body, options):
    paint = material(options["color"], "cloth")
    _front_panel(body, paint, 1.2, 0.12, 0.17)
    for side in (1, -1):
        body.builder.capsule((side * 0.1, 0.12 * body.depth, 1.33), (side * 0.13, -0.02, 1.47), 0.022, 0.022, paint, "chest", squash=(1, 0.5), segments=6, rings=2)


@_garment("an apron over the front", color=(Color(), color("white")))
def apron(body, options):
    paint = material(options["color"], "cloth")
    _front_panel(body, paint, 1.2, 0.13, 0.17)
    body.builder.revolve([(0.2, 1.0), (0.24, 0.5)], paint, "front", squash=(body.width, 0.8 * body.depth), segments=10, capped=False, sweep=120)


@_garment("what covers the legs", kind=(Choice(["breeches", "trousers", "shorts", "skirt"]), "trousers"), color=(Color(), color("charcoal")), stockings=(Color(), color("white")))
def legs(body, options):
    if options["kind"] == "skirt":
        paint = material(options["color"])
        _skirt_panel(body, paint, "tails", 0.19, 0.26, 0.52)
        _skirt_panel(body, paint, "front", 0.19, 0.26, 0.52)


@_garment("boots", color=(Color(), color("black")), height=(Choice(["ankle", "calf", "knee"]), "calf"))
def boots(body, options):
    paint = material(options["color"], roughness=0.4)
    rise = {"ankle": 0.1, "calf": 0.26, "knee": 0.42}[options["height"]]
    for side, side_x in SIDE_X.items():
        ankle = Vector((side_x * HIP_X, 0, 0.085))
        body.builder.capsule(ankle, ankle + Vector((0, 0, rise)), 0.076, 0.076 + rise * 0.05, paint, "shin" + side, segments=10, rings=3)


@_garment("shoes", color=(Color(), color("black")), buckles=(Color(), None))
def shoes(body, options):
    if options["buckles"]:
        for side, side_x in SIDE_X.items():
            body.builder.box((side_x * HIP_X, 0.1, 0.092), (0.06, 0.05, 0.02), material(options["buckles"], "polished"), "foot" + side)


@_garment("gloves", color=(Color(), color("white")))
def gloves(body, options):
    pass


@_garment("a sash: around the waist, or over one shoulder", colors=(Many(Color(), least=1, most=3), [color("red")]), drape=(Choice(["waist", "shoulder"]), "waist"))
def sash(body, options):
    builder, stripes = body.builder, options["colors"]
    if options["drape"] == "shoulder":
        ring = placement((0, 0, 1.235), rotation_y(37), (0.256 * body.width, 0.156 * body.depth, 1))
        builder.revolve([(0.96, -0.045), (1, -0.045), (1, 0.045), (0.96, 0.045)], material(stripes[0], "cloth"), "chest", ring, segments=20, capped=False)
        return
    stripe = 0.09 / len(stripes)
    for index, tint in enumerate(stripes):
        base = 1.01 + (len(stripes) - 1 - index) * stripe
        builder.revolve([(0.16, base), (0.197, base), (0.199, base + stripe), (0.16, base + stripe)], material(tint, "cloth"), "hips", squash=(body.width, 0.78 * body.depth), segments=16, capped=False)
    builder.capsule((-0.19 * body.width, 0.02, 1.02), (-0.225 * body.width, 0.02, 0.78), 0.04, 0.03, material(stripes[-1], "cloth"), "tails", squash=(1, 0.5), segments=8)


@_garment("leather belts: crossed over the chest, or one at the waist", color=(Color(), color("white")), kind=(Choice(["cross", "waist"]), "waist"))
def belts(body, options):
    paint = material(options["color"], roughness=0.7)
    if options["kind"] == "waist":
        body.builder.revolve([(0.17, 0.99), (0.2, 0.99), (0.2, 1.035), (0.17, 1.035)], paint, "hips", squash=(body.width, 0.76 * body.depth), segments=16, capped=False)
        return
    for side in (1, -1):
        ring = placement((0, 0, 1.235), rotation_y(side * 37), (0.254 * body.width, 0.154 * body.depth, 1))
        body.builder.revolve([(0.96, -0.022), (1, -0.022), (1, 0.022), (0.96, 0.022)], paint, "chest", ring, segments=20, capped=False)


@_garment("a cloak or cape down the back, which swings as its wearer moves", color=(Color(), color("crimson")), length=(Choice(["waist", "knee", "ankle"]), "knee"))
def cloak(body, options):
    paint = material(options["color"], "cloth")
    bottom = {"waist": 1.0, "knee": 0.52, "ankle": 0.14}[options["length"]]
    body.builder.revolve([(0.2, 1.47), (0.25, 1.3), (0.32, bottom)], paint, "cloak", placement(rotation=rotation_z(180)), squash=(body.width, 0.8), segments=12, capped=False, sweep=170)
    body.builder.revolve([(0.07, 1.44), (0.21, 1.44), (0.23, 1.4)], paint, "chest", squash=(body.width, 0.75), segments=12, capped=False)


@_garment("a hat or other headgear; kind picks it")
def hat(body, options):
    pass


def _limbs(body):
    builder = body.builder
    coat_worn, robe_worn, shirt_worn, legs_worn = body.worn("coat"), body.worn("robe"), body.worn("shirt"), body.worn("legs")
    sleeve = body.paint("coat") if coat_worn else body.paint("robe", roughness=0.7) if robe_worn else None
    upper = fore = sleeve or body.skin
    half_sleeve = None
    if not sleeve and shirt_worn:
        cloth = material(shirt_worn["color"], "cloth")
        upper = cloth if shirt_worn["sleeves"] in ("long", "rolled") else body.skin
        fore = cloth if shirt_worn["sleeves"] == "long" else body.skin
        half_sleeve = cloth if shirt_worn["sleeves"] == "short" else None
    hand_paint = body.paint("gloves", roughness=0.7) if body.worn("gloves") else body.skin
    under_robe = body.paint("robe", roughness=0.7) if robe_worn else body.skin
    thigh = shin = under_robe
    if legs_worn:
        cloth = material(legs_worn["color"])
        thigh = body.skin if legs_worn["kind"] == "skirt" else cloth
        shin = {"breeches": material(legs_worn["stockings"]), "trousers": cloth}.get(legs_worn["kind"], body.skin)
    elif body.worn("overalls"):
        thigh = shin = body.paint("overalls", finish="cloth")
    footwear = body.worn("boots") or body.worn("shoes")
    foot_paint = material(footwear["color"], roughness=0.4) if footwear else body.skin
    limb = (body.width + 1) / 2
    builder.ball((0, 0, 0.945), 1, thigh, "hips", scale=(0.185 * body.width, 0.135 * body.depth, 0.15))
    for side, side_x in SIDE_X.items():
        shoulder, elbow, wrist = (REST_POSITION[joint + side] for joint in ("arm", "fore", "hand"))
        builder.capsule(shoulder, elbow, 0.076 * limb, 0.062 * limb, upper, "arm" + side)
        builder.capsule(elbow, wrist, 0.062 * limb, 0.052 * limb, fore, "fore" + side)
        if half_sleeve:
            builder.capsule(shoulder, shoulder.lerp(elbow, 0.55), 0.082 * limb, 0.074 * limb, half_sleeve, "arm" + side)
        if body.worn("coat") and body.worn("coat")["cuffs"]:
            builder.revolve([(0.045, 0.0), (0.066, 0.0), (0.07, 0.09), (0.045, 0.09)], body.paint("coat", "cuffs"), "fore" + side, placement(wrist), segments=10, capped=False)
        _hand(builder, side, wrist, hand_paint)
        hip, knee, ankle = (REST_POSITION[joint + side] for joint in ("leg", "shin", "foot"))
        builder.capsule(hip, knee, 0.102 * limb, 0.082 * limb, thigh, "leg" + side)
        builder.capsule(knee, ankle, 0.09 * limb, 0.066 * limb, shin, "shin" + side)
        builder.ball((side_x * HIP_X, 0.05, 0.05), 1, foot_paint, "foot" + side, scale=(0.072, 0.135, 0.05), segments=10, rings=5)


def _hand(builder, side, wrist, paint):
    inward = -SIDE_X[side]
    builder.ball(wrist + Vector((0, 0, -0.035)), 1, paint, "hand" + side, scale=(0.026, 0.045, 0.045), segments=10, rings=5)
    for finger, across in enumerate((-0.031, -0.0105, 0.0105, 0.031)):
        length = (0.034, 0.04, 0.042, 0.038)[finger]
        knuckle = wrist + Vector((0, across, -0.065))
        middle = knuckle + Vector((0, 0, -0.033))
        builder.capsule(knuckle, middle, 0.0125, 0.0115, paint, "fingers" + side, segments=6, rings=2)
        builder.capsule(middle, middle + Vector((0, 0, -length + 0.008)), 0.0115, 0.0105, paint, "tips" + side, segments=6, rings=2)
    base = wrist + Vector((inward * 0.012, 0.036, -0.03))
    builder.capsule(base, base + Vector((inward * 0.012, 0.022, -0.04)), 0.0145, 0.0125, paint, "thumb" + side, segments=6, rings=2)


def dress(identity, look):
    """The whole painted body of a person in a look, as a mesh builder with every part on its bone."""
    body = Body(identity, look)
    if not (look.get("coat") or look.get("robe") or look.get("shirt")):
        _torso(body, body.skin)
    _limbs(body)
    for name, entry in GARMENTS.entries.items():
        if look.get(name):
            entry.make(body, look[name])
    _head(body)
    return body.builder
