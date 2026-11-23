"""Effects: smoke, flashes, fire, dust, water and sparks, each a function of shot time.

An effect is made of a few small objects that an animator swells, moves and shrinks to nothing.
"""

import math

import bpy
from mathutils import Vector

from .maths import clamp, lerp, ramp, scatter
from .mesh import MeshBuilder, collection
from .paint import Color, color, material
from .spec import Number, Registry

EFFECTS = Registry("effect")
OWNER = "effect"
GRAVITY = Vector((0, 0, -9.8))
SIZE = (Number(0.05, 20), 1.0)
_shapes = {}


def effect(about, **options):
    return EFFECTS.register(about, options)


def forget_shapes():
    """Blender dropped its data; cached meshes no longer exist."""
    _shapes.clear()


def _shape(key, build):
    if key not in _shapes:
        made = build().build("effect_shape", sharp=180)
        _shapes[key] = made.data
        bpy.data.objects.remove(made)
    return _shapes[key]


def _cloud(tint):
    def build():
        builder = MeshBuilder()
        paint = material(tint, roughness=1.0, coat=0.0, grain=0.05, glow=0.12, bump=0.0)
        for lobe in range(5):
            angle = lobe * 2.4
            away = 0.45 if lobe else 0.0
            builder.ball((math.cos(angle) * away, math.sin(angle) * away, (scatter(lobe) - 0.4) * 0.5), 0.62 + 0.2 * scatter(lobe + 9), paint, segments=10, rings=6)
        return builder

    return _shape(("cloud", tuple(tint)), build)


def _bit(tint, glow):
    def build():
        builder = MeshBuilder()
        builder.ball((0, 0, 0), 1.0, material(tint, roughness=0.4, grain=0.0, glow=glow), segments=6, rings=3)
        return builder

    return _shape(("bit", tuple(tint), glow), build)


def _particles(stage, shape, count, state):
    """count copies of a shape; state(index, time) gives each its (location, size), or None while it is gone."""
    made = []
    for index in range(count):
        particle = bpy.data.objects.new("effect", shape)
        collection("effects").objects.link(particle)
        particle["owner"] = OWNER
        particle.visible_shadow = False
        particle.rotation_euler = (scatter(index + 0.3) * 6, scatter(index + 1.7) * 6, scatter(index + 2.9) * 6)
        particle.scale = (0, 0, 0)
        made.append(particle)

    def animate(time):
        for index, particle in enumerate(made):
            placed = state(index, time)
            if placed is None:
                particle.scale = (0, 0, 0)
            else:
                particle.location, size = placed
                particle.scale = (size, size, size)

    stage.animate(animate)


def _light(stage, location, tint, energy):
    """A point light whose strength is energy(time)."""
    data = bpy.data.lights.new("effect_light", "POINT")
    data.color, data.shadow_soft_size, data.use_shadow = tint[:3], 0.5, False
    lamp = bpy.data.objects.new("effect_light", data)
    lamp.location = location
    collection("effects").objects.link(lamp)

    def animate(time):
        data.energy = energy(time)

    stage.animate(animate)


def burst(stage, origin, time, velocity=(0, 0, 0.6), size=0.6, life=3.0, count=4, spread=0.4, tint=None, seed=0.0):
    """Cotton wool smoke that swells, drifts along velocity and shrinks away."""
    origin, velocity = Vector(origin), Vector(velocity)

    def varied(index, salt):
        return scatter(seed * 7.3 + index * 3.1 + salt)

    def state(index, now):
        age = now - time - index * 0.05
        span = life * (0.75 + 0.5 * varied(index, 1))
        if not 0 <= age < span:
            return None
        start = origin + Vector((varied(index, 4) - 0.5, varied(index, 5) - 0.5, varied(index, 6) - 0.5)) * spread
        drift = velocity * (0.5 + varied(index, 2)) + Vector((varied(index, 7) - 0.5, varied(index, 8) - 0.5, 0)) * 0.3
        travelled = (1 - math.exp(-age * 2.2)) / 2.2
        location = start + drift * travelled * 1.6 + Vector((0, 0, 0.35 * age))
        swell = lerp(0.55, 1.0, ramp(age, 0.1, span * 0.45)) * ramp(age, 0, 0.12) * (1 - ramp(age, span * 0.45, span))
        return location, size * (0.7 + 0.6 * varied(index, 3)) * swell

    _particles(stage, _cloud(tint or color("white")), count, state)
    stage.acts(time, time + min(life, 1.5), lambda now: origin)


def stream(stage, origin, start, end, size=0.45, velocity=(0.25, 0, 0.9), life=3.5, every=0.45, tint=None, seed=0.0):
    """Smoke that keeps rising from start to end, already in the air when it starts."""
    count = int((end - start + life) / every) + 1
    for index in range(count):
        burst(stage, origin, start - life + index * every, velocity, size, life, 1, 0.12, tint, seed + index)


def flare(stage, origin, time, size=0.8, energy=3000.0, tint=None, seconds=0.14):
    """A flash of fire with the light it throws."""
    tint = tint or color("#ffb040")
    origin = Vector(origin)

    def build():
        builder = MeshBuilder()
        paint = material(tint, grain=0.0, glow=25.0)
        for ray in range(6):
            angle = ray * math.pi / 3
            builder.capsule((0, 0, 0), (math.cos(angle) * 0.9, math.sin(angle) * 0.72, math.sin(angle * 2) * 0.5), 0.22, 0.02, paint, segments=6, rings=2)
        builder.ball((0, 0, 0), 0.45, paint, segments=8, rings=4)
        return builder

    def strength(now):
        age = now - time
        return ramp(age, -0.03, 0.0) * (1 - ramp(age, 0.02, seconds)) if -0.03 <= age <= seconds else 0.0

    _particles(stage, _shape(("flare", tuple(tint)), build), 1, lambda index, now: (origin, size * strength(now)) if strength(now) > 0 else None)
    _light(stage, origin, tint, lambda now: energy * ramp(now - time, -0.03, 0.0) * (1 - ramp(now - time, 0.02, seconds + 0.25)))
    stage.acts(time, time + seconds + 0.3, lambda now: origin)


def flames(stage, origin, start, end, size=1.0, seed=0.0):
    """Flames that lick and flicker from start to end, with their light and smoke."""
    origin = Vector(origin)

    def build():
        builder = MeshBuilder()
        builder.revolve([(0, 0), (0.16, 0.12), (0.1, 0.4), (0, 0.75)], material("#ff7a1a", grain=0.0, glow=14.0), segments=7)
        return builder

    shape = _shape("flame", build)
    tongues = []
    for index in range(3):
        tongue = bpy.data.objects.new("flame", shape)
        collection("effects").objects.link(tongue)
        tongue["owner"] = OWNER
        tongue.location = origin + Vector(((scatter(index + seed) - 0.5) * 0.25, (scatter(index + 5 + seed) - 0.5) * 0.25, 0.1)) * size
        tongues.append(tongue)

    def animate(time):
        alight = size * ramp(time, start - 0.01, start + 0.4) * (1 - ramp(time, end, end + 0.6))
        for index, tongue in enumerate(tongues):
            lick = 0.5 + 0.5 * math.sin(time * (11 + index * 3.1) + index * 2.0 + seed)
            sway = math.sin(time * (7.3 + index) + index)
            tongue.scale = (alight * (1 + 0.2 * sway), alight * (1 - 0.2 * sway), alight * (0.7 + 0.8 * lick))

    stage.animate(animate)
    _light(stage, origin + Vector((0, 0, 0.7 * size)), color("#ff8a30"), lambda now: size * (260 + 160 * math.sin(now * 13 + seed) * math.sin(now * 5.1)) * ramp(now, start - 0.01, start + 0.4) * (1 - ramp(now, end, end + 0.6)))
    stream(stage, origin + Vector((0, 0, size)), start, end, size=0.3 * size, velocity=(0.3, 0.1, 1.0), life=3.2, every=0.5, seed=seed)
    stage.acts(start, end, lambda now: origin)


def _spray(stage, origin, time, count, speed, lift, size, life, tint, glow, seed):
    """Small bits thrown up and out that fall back under gravity."""
    origin = Vector(origin)

    def state(index, now):
        age = now - time
        if not 0 <= age < life:
            return None
        angle = scatter(seed + index * 1.3) * 2 * math.pi
        out = speed * (0.3 + 0.7 * scatter(seed + index * 2.1))
        launch = Vector((math.cos(angle) * out, math.sin(angle) * out, lift * (0.5 + 0.5 * scatter(seed + index * 3.7))))
        location = origin + launch * age + GRAVITY * (0.5 * age * age)
        return location, size * (0.6 + 0.8 * scatter(seed + index * 4.3)) * (1 - ramp(age, life * 0.6, life))

    _particles(stage, _bit(tint, glow), count, state)
    stage.acts(time, time + life, lambda now: origin)


# ---------------------------------------------------------------- what a shot can ask for
@effect("one burst of smoke that swells, drifts up and thins", size=SIZE, color=(Color(), color("white")))
def puff(stage, origin, time, size, color):
    burst(stage, origin, time, size=0.6 * size, count=5, spread=0.35 * size, tint=color, seed=time)


@effect("smoke that keeps rising for a while, such as from a chimney or a burning building", size=SIZE, color=(Color(), color("white")), seconds=(Number(0.5, 600), 600.0))
def smoke(stage, origin, time, size, color, seconds):
    stream(stage, origin, time, min(time + seconds, stage.duration + 1), size=0.45 * size, tint=color, seed=time)


@effect("a bright flash that lights what is near", size=SIZE, color=(Color(), color("#ffb040")))
def flash(stage, origin, time, size, color):
    flare(stage, origin, time, size=0.8 * size, energy=3000 * size * size, tint=color)


@effect("a fire that burns, flickers and smokes", size=SIZE, seconds=(Number(0.5, 600), 600.0))
def fire(stage, origin, time, size, seconds):
    flames(stage, origin, time, min(time + seconds, stage.duration + 1), size, seed=time)


@effect("a low cloud of dust kicked up from the ground", size=SIZE, color=(Color(), color("tan")))
def dust(stage, origin, time, size, color):
    burst(stage, origin, time, velocity=(0, 0, 0.15), size=0.5 * size, life=2.4, count=6, spread=0.9 * size, tint=color, seed=time)


@effect("water thrown up that falls back", size=SIZE)
def splash(stage, origin, time, size):
    _spray(stage, origin, time, 16, 1.6 * size, 4.2 * math.sqrt(size), 0.07 * size, 1.0, color("#dfeef5"), 0.3, time)


@effect("a shower of glowing sparks", size=SIZE, color=(Color(), color("#ffc24a")))
def sparks(stage, origin, time, size, color):
    _spray(stage, origin, time, 14, 2.0 * size, 3.0 * math.sqrt(size), 0.03 * clamp(size, 0.5, 3), 0.8, color, 20.0, time)
    flare(stage, origin, time, size=0.25 * size, energy=400 * size, tint=color, seconds=0.1)
