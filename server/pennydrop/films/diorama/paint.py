"""Colors and finishes: every surface in a diorama is hand painted wood, cloth or metal."""

import bpy

from .spec import Registry, nearest, show

COLORS = {
    "black": "#1d1b1c", "charcoal": "#34343a", "grey": "#7d7f86", "silver": "#aab0b8", "white": "#ece5d5", "cream": "#e0d2b0",
    "paper": "#efe6cc", "canvas": "#e6dcc0", "buff": "#cdb37a", "tan": "#b79a6d", "sand": "#d9c891", "yellow": "#e3c23f",
    "gold": "#d0a436", "brass": "#c08a2e", "bronze": "#9a7a35", "orange": "#d9772b", "red": "#b4282c", "scarlet": "#c2312b",
    "crimson": "#8e1f2b", "pink": "#dba3a0", "purple": "#5d3a70", "blue": "#1f3f7d", "navy": "#16284f", "sky": "#6f9fd0",
    "teal": "#2f7890", "green": "#3f5c3a", "olive": "#566a38", "leaf": "#4f6e3a", "lime": "#8d9a56", "brown": "#5a3a22",
    "walnut": "#4f3521", "oak": "#8a6238", "pine": "#c9a36a", "wicker": "#a58450", "earth": "#8b6f4a", "stone": "#c9bda0",
    "slate": "#5f6672", "brick": "#a2543c", "terracotta": "#b8583a", "plaster": "#ead9b5", "iron": "#3a3a3f", "steel": "#aab0b8",
    "skin_pale": "#f0cdb0", "skin_fair": "#e6b88f", "skin_tan": "#c99564", "skin_brown": "#8d5a3b", "skin_dark": "#5b3a29",
    "hair_black": "#1d1b1c", "hair_brown": "#3b2617", "hair_chestnut": "#6b4a2a", "hair_blond": "#c9a55c", "hair_red": "#8c4a26",
    "hair_grey": "#b9b3a8", "hair_white": "#e6e2d8",
}  # fmt: skip

FINISHES = Registry("finish")
FINISHES.add("paint", "glossy painted wood, the default", make={"roughness": 0.55, "coat": 0.15})
FINISHES.add("wood", "bare wood with visible grain", make={"roughness": 0.6, "coat": 0.1, "grain": 0.12, "grain_scale": 5.0})
FINISHES.add("matte", "flat paint without shine", make={"roughness": 0.9, "coat": 0.0})
FINISHES.add("cloth", "soft cloth", make={"roughness": 0.88, "coat": 0.0, "grain": 0.04, "bump": 0.0})
FINISHES.add("paper", "paper or parchment", make={"roughness": 0.85, "coat": 0.0, "grain": 0.03, "bump": 0.0})
FINISHES.add("metal", "dull metal", make={"roughness": 0.4, "coat": 0.1, "metallic": 0.5, "grain": 0.0})
FINISHES.add("polished", "bright polished metal", make={"roughness": 0.3, "coat": 0.2, "metallic": 0.75, "grain": 0.0})
FINISHES.add("stone", "rough stone or plaster", make={"roughness": 0.9, "coat": 0.0, "grain": 0.07, "grain_scale": 0.6})
FINISHES.add("earth", "soil, straw or wicker", make={"roughness": 1.0, "coat": 0.0, "grain": 0.14, "grain_scale": 3.0, "bump": 0.4})
FINISHES.add("glow", "shines with its own light", make={"roughness": 0.5, "coat": 0.0, "grain": 0.0, "glow": 8.0})

_materials = {}


def forget_materials():
    """Blender dropped its data; cached materials no longer exist."""
    _materials.clear()


def linear(hex_color, alpha=1.0):
    def channel(start):
        value = int(hex_color[start : start + 2], 16) / 255.0
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    return (channel(1), channel(3), channel(5), alpha)


def color(value):
    """A color name or #rrggbb as linear RGBA. Engine code calls it with names it knows."""
    return linear(COLORS.get(value, value))


class Color:
    """The field for a color the writer chose."""

    def read(self, value, path, reading):
        if isinstance(value, str) and value in COLORS:
            return linear(COLORS[value])
        if isinstance(value, str) and len(value) == 7 and value[0] == "#" and all(digit in "0123456789abcdefABCDEF" for digit in value[1:]):
            return linear(value)
        return reading.fail(path, f"unknown color {show(value)}; write #rrggbb or a color name; {nearest(value, COLORS)}")

    def describe(self):
        return "color"


def mix(first, second, weight):
    return tuple(first[index] + (second[index] - first[index]) * weight for index in range(4))


def material(tint, finish="paint", **changes):
    """The painted material for a color (a name or linear RGBA) in a finish; changes override single finish values."""
    tint = color(tint) if isinstance(tint, str) else tuple(tint)
    recipe = {"roughness": 0.55, "coat": 0.15, "metallic": 0.0, "glow": 0.0, "grain": 0.08, "grain_scale": 7.0, "bump": 0.15, "space": "Object", **FINISHES[finish].make, **changes}
    key = (tuple(round(channel, 4) for channel in tint), tuple(sorted(recipe.items())))
    if key not in _materials:
        _materials[key] = _painted(tint, **recipe)
    return _materials[key]


def _painted(tint, roughness, coat, metallic, glow, grain, grain_scale, bump, space):
    made = bpy.data.materials.new("paint")
    made.use_nodes = True
    tree = made.node_tree
    surface = tree.nodes["Principled BSDF"]
    surface.inputs["Roughness"].default_value = roughness
    surface.inputs["Coat Weight"].default_value = coat
    surface.inputs["Coat Roughness"].default_value = 0.25
    surface.inputs["Metallic"].default_value = metallic
    if glow:
        surface.inputs["Emission Color"].default_value = tint
        surface.inputs["Emission Strength"].default_value = glow
    if grain:
        coordinates = tree.nodes.new("ShaderNodeTexCoord")
        noise = tree.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = grain_scale
        noise.inputs["Detail"].default_value = 3.0
        tree.links.new(coordinates.outputs[space], noise.inputs["Vector"])
        brush = tree.nodes.new("ShaderNodeMix")
        brush.data_type = "RGBA"
        brush.inputs[6].default_value = (*(channel * (1 - grain * 2.2) for channel in tint[:3]), 1)
        brush.inputs[7].default_value = (*(min(1, channel * (1 + grain * 1.6) + grain * 0.02) for channel in tint[:3]), 1)
        tree.links.new(noise.outputs[0], brush.inputs[0])
        tree.links.new(brush.outputs[2], surface.inputs["Base Color"])
        if bump:
            relief = tree.nodes.new("ShaderNodeBump")
            relief.inputs["Strength"].default_value = bump
            relief.inputs["Distance"].default_value = 0.02
            tree.links.new(noise.outputs[0], relief.inputs["Height"])
            tree.links.new(relief.outputs[0], surface.inputs["Normal"])
    else:
        surface.inputs["Base Color"].default_value = tint
    made.diffuse_color = tint
    return made
