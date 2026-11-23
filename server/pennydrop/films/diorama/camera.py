"""The camera: where it stands and what it frames at every moment of a shot.

A key says who to frame, from which side and how big. The camera works out its own distance,
follows its targets, eases from key to key, drifts a little, and steps in front of a wall that would hide them.
"""

import itertools
import math

import bpy
from mathutils import Vector

from .maths import clamp, heading_vector, lerp, smooth, wobble
from .spec import Registry

SENSOR_WIDTH, SENSOR_HEIGHT = 36.0, 20.25
LOWEST_ABOVE_GROUND = 0.35
CLEAR_OF_WALL = 0.45

SIZES = Registry("shot size")
SIZES.add("wide", "the place, with people small in it", fills=0.28, least=0.12, aperture=2.0)
SIZES.add("full", "whole figures, head to foot", fills=0.62, least=0.4, aperture=1.6)
SIZES.add("medium", "from the waist up", fills=1.25, least=0.8, aperture=1.2)
SIZES.add("close", "head and shoulders", fills=2.6, least=1.6, aperture=1.0)


class Framed:
    """One thing a camera key frames: where its middle is, how tall it is, and which way it faces."""

    def __init__(self, owner, middle, height, heading, base):
        self.owner, self.middle, self.height, self.heading, self.base = owner, middle, height, heading, base


class Key:
    def __init__(self, time, framed, bearing, height, size, distance, eye):
        self.time, self.framed, self.bearing, self.height, self.size, self.distance, self.fixed_eye = time, framed, bearing, height, size, distance, eye
        # The camera keeps the side it was given even when its first target turns around during the shot.
        self._heading = framed[0].heading(time)

    def placed(self, lens, time):
        """Where this key alone would put the eye and the aim at a time."""
        middles = [framed.middle(time) for framed in self.framed]
        aim = sum(middles, Vector()) / len(middles)
        if self.fixed_eye is not None:
            return Vector(self.fixed_eye), aim
        tallest = max(framed.height for framed in self.framed)
        spread = max((first - second).length for first in middles for second in middles)
        fitting_height = tallest * lens / (SENSOR_HEIGHT * SIZES[self.size].facts["fills"])
        fitting_width = (spread + 0.6 * tallest) * lens / (SENSOR_WIDTH * 0.72)
        distance = self.distance or max(fitting_height, fitting_width)
        base = self.framed[0].base(time)
        rise = base.z + self.height - aim.z
        level = math.sqrt(max(distance * distance - rise * rise, (0.4 * distance) ** 2))
        eye = Vector((aim.x, aim.y, 0)) + heading_vector(self._heading - self.bearing) * level
        eye.z = base.z + self.height
        return eye, aim


class Camera:
    def __init__(self, stage, lens, keys, focus):
        """keys are in time order; focus(time) is the point kept sharp."""
        self.stage, self.lens, self.keys, self.focus = stage, lens, keys, focus
        data = bpy.data.cameras.new("camera")
        data.lens, data.sensor_width, data.sensor_fit = lens, SENSOR_WIDTH, "HORIZONTAL"
        data.clip_start, data.clip_end = 0.1, 3000
        data.dof.use_dof = True
        self.made = bpy.data.objects.new("camera", data)
        bpy.context.scene.collection.objects.link(self.made)
        bpy.context.scene.camera = self.made
        self._seen = (None, (Vector(keys[0].fixed_eye or (0, 0, 0)), Vector()))
        self._placing = False
        stage.camera = self
        stage.animate(self._show)
        for first, second in itertools.pairwise(keys):
            if (first.placed(lens, first.time)[0] - second.placed(lens, second.time)[0]).length > 0.2:
                stage.acts(first.time, second.time, lambda time: None)

    def _blended(self, time):
        """The keys either side of a time, and how far the camera has eased from the first to the second."""
        later = [key for key in self.keys if key.time > time]
        earlier = [key for key in self.keys if key.time <= time]
        if not earlier:
            return later[0], later[0], 0.0
        if not later:
            return earlier[-1], earlier[-1], 0.0
        return earlier[-1], later[0], smooth((time - earlier[-1].time) / (later[0].time - earlier[-1].time))

    def _view(self, time):
        # A person who looks at the camera while it frames them asks for the view it is still working out; they get the one before.
        if self._seen[0] != time and not self._placing:
            self._placing = True
            first, second, weight = self._blended(time)
            eye, aim = first.placed(self.lens, time)
            if weight:
                next_eye, next_aim = second.placed(self.lens, time)
                eye, aim = eye.lerp(next_eye, weight), aim.lerp(next_aim, weight)
            reach = (eye - aim).length
            eye += Vector((wobble(time, 1.0, 0.11), wobble(time, 2.0, 0.09), wobble(time, 3.0, 0.13))) * 0.012 * reach
            aim += Vector((wobble(time, 4.0, 0.1), wobble(time, 5.0, 0.1), wobble(time, 6.0, 0.12))) * 0.006 * reach
            owners = {framed.owner for key in (first, second) for framed in key.framed}
            # An eye the writer placed stays put; the checks say when it is a bad place.
            if first.fixed_eye is None or second.fixed_eye is None:
                eye = self._clear(eye, aim, time, owners)
            eye.z = max(eye.z, self.stage.ground.height(eye.x, eye.y) + LOWEST_ABOVE_GROUND)
            self._seen = (time, (eye, aim))
            self._placing = False
        return self._seen[1]

    def _clear(self, eye, aim, time, owners):
        """Step the eye toward the aim until no wall, building or hillside stands between them."""
        nearest = 1.0
        for piece in self.stage.pieces.values():
            if piece.id in owners or not piece.solids:
                continue
            inverse = piece.matrix(time).inverted()
            local_aim, local_eye = inverse @ aim, inverse @ eye
            for solid in piece.solids:
                entered = solid.crossed(local_aim, local_eye)
                if entered is not None and not solid.holds(local_aim):
                    nearest = min(nearest, entered)
        ground = self.stage.ground
        for step in range(1, 25):
            point = aim.lerp(eye, step / 24)
            if point.z < ground.height(point.x, point.y) + LOWEST_ABOVE_GROUND * 0.5 and step / 24 < nearest:
                nearest = (step - 1) / 24
                break
        if nearest < 1.0:
            span = (eye - aim).length
            eye = aim.lerp(eye, clamp(nearest - CLEAR_OF_WALL / max(span, 0.01), 0.15, 1.0))
        return eye

    def eye(self, time):
        return self._view(time)[0].copy()

    def aim(self, time):
        return self._view(time)[1].copy()

    def size(self, time):
        first, second, weight = self._blended(time)
        return (second if weight > 0.5 else first).size

    def _show(self, time):
        eye, aim = self._view(time)
        self.made.matrix_world = (aim - eye).to_track_quat("-Z", "Y").to_matrix().to_4x4()
        self.made.location = eye
        first, second, weight = self._blended(time)
        self.made.data.dof.focus_distance = max((self.focus(time) - eye).length, 0.3)
        self.made.data.dof.aperture_fstop = lerp(SIZES[first.size].facts["aperture"], SIZES[second.size].facts["aperture"], weight)

    def project(self, point, time):
        """Where a world point falls in the frame: (across, up) from 0 to 1 inside it, and its distance in front of the lens."""
        eye, aim = self._view(time)
        forward = (aim - eye).normalized()
        right = forward.cross(Vector((0, 0, 1))).normalized()
        up = right.cross(forward)
        offset = Vector(point) - eye
        depth = offset.dot(forward)
        if depth <= 0.01:
            return -1.0, -1.0, depth
        return 0.5 + offset.dot(right) * self.lens / (depth * SENSOR_WIDTH), 0.5 + offset.dot(up) * self.lens / (depth * SENSOR_HEIGHT), depth

    def frame_share(self, height, depth):
        """How much of the frame's height something of a height fills at a distance."""
        return height * self.lens / (max(depth, 0.01) * SENSOR_HEIGHT)
