"""Easing, seeded noise, rotations and directions shared by every module.

A heading is degrees counterclockwise from +y, the way Blender turns about z.
The JSON's compass bearing is its negative, and only the plan converts.
"""

import math

from mathutils import Matrix, Vector


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def lerp(start, end, weight):
    return start + (end - start) * weight


def smooth(value):
    value = clamp(value)
    return value * value * (3 - 2 * value)


def ramp(t, start, end):
    """0 before start, 1 after end, eased in between."""
    if end <= start:
        return 1.0 if t >= start else 0.0
    return smooth((t - start) / (end - start))


def pulse(t, start, peak, end):
    return ramp(t, start, peak) * (1 - ramp(t, peak, end))


def wobble(t, seed=0.0, rate=1.0):
    """A smooth wander in about -1 to 1 that never repeats visibly."""
    shift = seed * 12.9898
    return (math.sin(t * rate * 2.1 + shift) + 0.6 * math.sin(t * rate * 3.7 + shift * 1.7 + 1.3) + 0.4 * math.sin(t * rate * 5.9 + shift * 2.3 + 4.1)) / 2.0


def scatter(seed):
    """A fixed pseudo random number in 0 to 1 for a seed."""
    value = math.sin(seed * 127.1 + 311.7) * 43758.5453
    return value - math.floor(value)


def name_seed(name):
    return (sum(ord(letter) * (index + 1) for index, letter in enumerate(name)) % 997) / 7.0


def rotation_x(degrees):
    return Matrix.Rotation(math.radians(degrees), 3, "X")


def rotation_y(degrees):
    return Matrix.Rotation(math.radians(degrees), 3, "Y")


def rotation_z(degrees):
    return Matrix.Rotation(math.radians(degrees), 3, "Z")


def placement(location=(0, 0, 0), rotation=None, scale=1.0):
    matrix = Matrix.Translation(Vector(location))
    if rotation is not None:
        matrix = matrix @ rotation.to_4x4()
    if scale != 1.0:
        sizes = (scale, scale, scale) if isinstance(scale, (int, float)) else tuple(scale)
        matrix = matrix @ Matrix.Diagonal((*sizes, 1))
    return matrix


def frame_toward(origin, target):
    """A frame at origin whose z axis points at target, with x kept near world x."""
    origin, target = Vector(origin), Vector(target)
    z_axis = (target - origin).normalized()
    x_axis = Vector((1, 0, 0))
    if abs(z_axis.dot(x_axis)) > 0.95:
        x_axis = Vector((0, 1, 0))
    x_axis = (x_axis - z_axis * x_axis.dot(z_axis)).normalized()
    matrix = Matrix((x_axis, z_axis.cross(x_axis), z_axis)).transposed().to_4x4()
    matrix.translation = origin
    return matrix


def heading_vector(heading):
    angle = math.radians(heading)
    return Vector((-math.sin(angle), math.cos(angle), 0.0))


def heading_toward(from_xy, to_xy):
    return math.degrees(math.atan2(-(to_xy[0] - from_xy[0]), to_xy[1] - from_xy[1]))


def angle_difference(target, current):
    """The shortest signed turn from current to target, in degrees."""
    return (target - current + 180) % 360 - 180


def hermite(keys, t):
    """A smooth path through [(time, vector)] that does not overshoot or stop between keys."""
    if t <= keys[0][0]:
        return Vector(keys[0][1])
    if t >= keys[-1][0]:
        return Vector(keys[-1][1])
    last = len(keys) - 1

    def tangent(index):
        if index in (0, last):
            before, after = max(index - 1, 0), min(index + 1, last)
            return (Vector(keys[after][1]) - Vector(keys[before][1])) / (keys[after][0] - keys[before][0])
        arriving = (Vector(keys[index][1]) - Vector(keys[index - 1][1])) / (keys[index][0] - keys[index - 1][0])
        leaving = (Vector(keys[index + 1][1]) - Vector(keys[index][1])) / (keys[index + 1][0] - keys[index][0])
        return Vector([0.0 if a * b <= 0 else 2 * a * b / (a + b) for a, b in zip(arriving, leaving)])

    for index in range(last):
        start, end = keys[index][0], keys[index + 1][0]
        if t <= end:
            span = end - start
            u = (t - start) / span
            return (
                (2 * u**3 - 3 * u**2 + 1) * Vector(keys[index][1])
                + (u**3 - 2 * u**2 + u) * span * tangent(index)
                + (-2 * u**3 + 3 * u**2) * Vector(keys[index + 1][1])
                + (u**3 - u**2) * span * tangent(index + 1)
            )
