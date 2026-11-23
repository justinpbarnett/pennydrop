"""Staging checks: watch a whole staged shot and say, in sentences a writer can act on, what would look wrong.

Every check measures the built stage itself, several times a second: the real camera, bodies and walls.
"""

import math

import bpy
from mathutils import Vector

from .camera import SIZES
from .effects import OWNER as EFFECT
from .performance import Person

STEP = 0.2
FRAME_MARGIN = 0.04
BACK_TURNED = 110.0
QUIET_SECONDS = 2.5
CAMERA_CLEARANCE = 0.3
BODY_RADIUS = 0.22
FLOATING = 0.15
# How long something must last before it is worth a sentence.
LASTING = {"hidden": 0.5, "out": 0.5, "small": 1.0, "back": 1.0, "overlap": 0.5, "inside": 0.5}
NEAR_RAYS = [Vector(ray).normalized() for ray in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1), (1, 1, 1), (1, 1, -1), (1, -1, 1), (1, -1, -1), (-1, 1, 1), (-1, 1, -1), (-1, -1, 1), (-1, -1, -1))]


class Findings:
    """What the checks saw, moment by moment, turned into one sentence for each thing that went wrong."""

    def __init__(self):
        self._seen = {}

    def note(self, kind, who, time, sentence):
        """sentence says who and what, with {when} where the time belongs."""
        self._seen.setdefault((kind, who), ([], sentence))[0].append(time)

    def sentences(self):
        found = []
        for (kind, _), (times, sentence) in self._seen.items():
            spans = [[times[0], times[0]]]
            for time in times[1:]:
                if time - spans[-1][1] <= STEP * 1.5:
                    spans[-1][1] = time
                else:
                    spans.append([time, time])
            start, end = max(spans, key=lambda span: span[1] - span[0])
            if end - start + STEP >= LASTING.get(kind, 0.0):
                when = f"at {start:.1f} s" if end == start else f"from {start:.1f} s to {end:.1f} s"
                found.append((start, sentence.replace("{when}", when)))
        return [sentence for _, sentence in sorted(found)]


def _owner(hit):
    return hit.get("owner", hit.name)


def _edge(across, up):
    return "left" if across < FRAME_MARGIN else "right" if across > 1 - FRAME_MARGIN else "bottom" if up < FRAME_MARGIN else "top"


def _spot(point):
    return f"[{point.x:.1f}, {point.y:.1f}]"


class Watch:
    def __init__(self, shot):
        self.shot, self.stage, self.camera = shot, shot.stage, shot.stage.camera
        self.found = Findings()
        self.people = list(self.stage.people.values())
        self.walls = [piece for piece in self.stage.pieces.values() if piece.solids]

    def _cast(self, origin, toward, distance):
        """The owner of the first thing a ray meets, and how far off, or (None, None)."""
        hit, location, _, _, struck, _ = bpy.context.scene.ray_cast(bpy.context.evaluated_depsgraph_get(), origin, toward, distance=distance)
        return (_owner(struck), (location - origin).length) if hit else (None, None)

    def subject(self, thing, time):
        """Checks 1 to 3: the subject is in frame, unhidden, big enough and not acting with their back to us."""
        eye = self.camera.eye(time)
        is_person = isinstance(thing, Person)
        point = thing.point("head" if is_person else "", time)
        across, up, depth = self.camera.project(point, time)
        what = f"The head of '{thing.id}'" if is_person else f"'{thing.id}'"
        if depth <= 0 or not (FRAME_MARGIN < across < 1 - FRAME_MARGIN and FRAME_MARGIN < up < 1 - FRAME_MARGIN):
            where = "behind the camera" if depth <= 0 else f"off its {_edge(across, up)} edge"
            self.found.note("out", thing.id, time, f"{what} is outside the frame ({where}) {{when}}; add '{thing.id}' to the camera key's targets, or change the key's bearing or size so they are in the picture.")
            return
        blocker, _ = self._cast(eye, (point - eye).normalized(), (point - eye).length - 0.3)
        if blocker and blocker != EFFECT and blocker != thing.id and not blocker.startswith(thing.id + "_"):
            self.found.note("hidden", (thing.id, blocker), time, f"{what} is hidden behind '{blocker}' {{when}}, seen from the camera; move one of them aside or change the camera key's bearing.")
        size = self.camera.size(time)
        tall = thing.height if is_person else max(thing.size.z, 0.3)
        share = self.camera.frame_share(tall, depth)
        if share < SIZES[size].facts["least"] and thing is self._largest(time):
            self.found.note("small", thing.id, time, f"'{thing.id}' fills only {share:.0%} of the frame's height {{when}}, too small for a {size} shot (at least {SIZES[size].facts['least']:.0%}); give the camera key a smaller `distance` or fewer targets, or call the size what it is.")
        if is_person and thing.busy(time):
            away = math.degrees(thing.gaze(time).angle(eye - point, 0.0))
            if away > BACK_TURNED:
                self.found.note("back", thing.id, time, f"'{thing.id}' acts with their face turned {away:.0f} degrees away from the camera {{when}}; turn them with a `face` beat or move the camera key's bearing round to their front.")

    def _largest(self, time):
        """The subject that fills most of the frame; a shot's size is judged by it alone."""

        def share(thing):
            tall = thing.height if isinstance(thing, Person) else max(thing.size.z, 0.3)
            return self.camera.frame_share(tall, self.camera.project(thing.point("", time), time)[2])

        return max(self.shot.subjects, key=share)

    def bodies(self, time):
        """Checks 4 and 5: nobody inside another body or a solid thing, in the water, off the set or in the air."""
        ground = self.stage.ground
        standing = [(person, person.point("feet", time)) for person in self.people if not person.rides(time)]
        for index, (person, feet) in enumerate(standing):
            for other, other_feet in standing[index + 1 :]:
                apart = (feet - other_feet).to_2d().length
                if apart < 0.75 * BODY_RADIUS * (person.scale + other.scale) and abs(feet.z - other_feet.z) < 1.0 and other.id not in person.contacts:
                    self.found.note("overlap", (person.id, other.id), time, f"'{person.id}' and '{other.id}' stand in the same place {{when}} ({apart:.1f} m apart at {_spot(feet)}); keep them at least 0.5 m apart, or use a contact action that names the other.")
            hips, chest = person.point("hips", time), person.point("chest", time)
            for piece in self.walls:
                if piece.id in person.contacts:
                    continue
                inverse = piece.matrix(time).inverted()
                if any(solid.holds(inverse @ hips, -0.05) or solid.holds(inverse @ chest, -0.05) for solid in piece.solids):
                    self.found.note("inside", (person.id, piece.id), time, f"'{person.id}' is inside the {piece.kind} '{piece.id}' {{when}} at {_spot(feet)}; stand them clear of it, or lead the walk around it or through a door.")
            if not ground.inside(feet.x, feet.y):
                self.found.note("off", person.id, time, f"'{person.id}' is off the built ground at {_spot(feet)} {{when}}; the set's bounds are {list(ground.bounds)}, so keep positions inside them or widen the bounds.")
            elif ground.in_water(feet.x, feet.y):
                self.found.note("water", person.id, time, f"'{person.id}' stands in the water at {_spot(feet)} {{when}}; keep them on land.")
            lowest = min(person.point(name, time).z for name in ("hips", "hand_left", "hand_right", "head")) - feet.z
            if lowest > FLOATING + 0.95 * person.scale:
                self.found.note("floating", person.id, time, f"'{person.id}' floats {lowest - 0.92 * person.scale:.1f} m above the ground {{when}}; take the `lift` out of their pose.")

    def lens(self, time):
        """Check 7: the camera is in the open air."""
        eye, ground = self.camera.eye(time), self.stage.ground
        if eye.z < ground.height(eye.x, eye.y) + 0.05:
            self.found.note("camera_under", None, time, f"The camera is under the ground at {_spot(eye)} {{when}}; raise the camera key's `height` or move its `eye`.")
            return
        for piece in self.walls:
            if any(solid.holds(piece.matrix(time).inverted() @ eye) for solid in piece.solids):
                self.found.note("camera_inside", piece.id, time, f"The camera is inside the {piece.kind} '{piece.id}' {{when}}; change the camera key's bearing, distance or `eye` so it stands in the open.")
                return
        for ray in NEAR_RAYS:
            near, distance = self._cast(eye, ray, CAMERA_CLEARANCE)
            if near and near != EFFECT:
                self.found.note("camera_near", near, time, f"The camera is {distance:.2f} m from '{near}' {{when}}, closer than {CAMERA_CLEARANCE} m; move the camera key back or to another bearing.")
                return

    def travel(self, time, before):
        """Check 8: nobody outruns their gait or jumps from one place to another."""
        for person in self.people:
            feet = person.point("feet", time)
            leg = person.walking(time)
            if leg and person.speed(time) > 1.25 * leg.gait_speed + 0.1:
                self.found.note("outrun", person.id, time, f"'{person.id}' covers ground at {person.speed(time):.1f} m/s {{when}}, but the gait '{leg.gait}' goes {leg.gait_speed:.1f} m/s; give the walk more `seconds`, shorten it, or use a faster gait.")
            if person.id in before and (feet - before[person.id]).length > 0.35 + 6.0 * STEP:
                self.found.note("jump", person.id, time, f"'{person.id}' jumps {(feet - before[person.id]).length:.1f} m in one instant {{when}}; get them there with a `walk`, or have them carried there.")
            before[person.id] = feet

    def alive(self, time):
        """Whether something acts in view at a time (check 6); breathing and camera drift do not count."""
        for start, end, where in self.stage.activity:
            if not start <= time <= end:
                continue
            point = where(time)
            if point is None:
                return True
            across, up, depth = self.camera.project(point, time)
            if depth > 0 and 0 < across < 1 and 0 < up < 1:
                return True
        return False


def watch(shot):
    """Run every check over the whole shot and return the problems as sentences."""
    watching, stage = Watch(shot), shot.stage
    before, quiet_since, quiet = {}, None, []
    for step in range(int(stage.duration / STEP) + 1):
        time = min(step * STEP, stage.duration)
        stage.show(time)
        for thing in shot.subjects:
            watching.subject(thing, time)
        watching.bodies(time)
        watching.lens(time)
        watching.travel(time, before)
        if watching.alive(time):
            quiet_since = None
        elif quiet_since is None:
            quiet_since = time
            quiet.append([time, time])
        else:
            quiet[-1][1] = time
    still = [f"Nothing moves in view from {start:.1f} s to {end:.1f} s; give someone in frame a beat there, add an event, or move the camera." for start, end in quiet if end - start > QUIET_SECONDS]
    return watching.found.sentences() + still
