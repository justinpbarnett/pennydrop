"""A person through a shot: where they stand, which way they face and what their body does at every moment.

Staging tells a person what happens when, in time order. Nothing is baked: the person works out
their place and pose for any time asked, so a frame, a still and a check all see the same performance.
"""

import math
from itertools import pairwise

from mathutils import Matrix, Vector

from .actions import ACTIONS
from .figure import Figure
from .maths import (
    angle_difference,
    clamp,
    heading_toward,
    lerp,
    placement,
    ramp,
    rotation_z,
    scatter,
    smooth,
    wobble,
)
from .pose import SIDES, blend, make_pose, solve
from .pose import reach as reach_arm
from .spec import Number, Registry, Whole

EASE_INTO_WALK = 0.4
TURN_SECONDS = 0.6
BODY_BLEND = 0.35
OVERLAY_BLEND = 0.3
SETTLE_SECONDS = 1.2
BEFORE_THE_SHOT = -10.0
ON_THE_LITTER = Vector((0, -0.1, 0.03))
CARRY_HEIGHT = 0.76
POINTS = {
    "head": ("head", (0, 0, 0.18)), "chest": ("chest", (0, 0, 0.2)), "hips": ("hips", (0, 0, 0)), "hand_left": ("handL", (0, 0, -0.06)), "hand_right": ("handR", (0, 0, -0.06)),
    "shoulder_left": ("armL", (0, 0, 0.04)), "shoulder_right": ("armR", (0, 0, 0.04)),
    "thigh_left": ("legL", (0, 0, -0.2)), "thigh_right": ("legR", (0, 0, -0.2)), "feet": None,
}  # fmt: skip

FORMATIONS = Registry("formation")


def formation(about, name=None):
    return FORMATIONS.register(about, {"spacing": (Number(0.4, 20), 1.2), "rows": (Whole(1, 20), 2)}, name)


@formation("side by side in one row")
def line(count, spacing, rows):
    return [((index - (count - 1) / 2) * spacing, 0.0) for index in range(count)]


@formation("one behind another")
def column(count, spacing, rows):
    return [(0.0, -index * spacing) for index in range(count)]


@formation("a marching block, `rows` people wide")
def block(count, spacing, rows):
    return [((index % rows - (rows - 1) / 2) * spacing, -(index // rows) * spacing) for index in range(count)]


@formation("`rows` rows facing front, each row standing in the gaps of the one before")
def ranks(count, spacing, rows):
    wide = math.ceil(count / rows)
    return [((index % wide - (wide - 1) / 2 + 0.5 * (index // wide % 2)) * spacing, -(index // wide) * spacing * 0.9) for index in range(count)]


@formation("a loose knot of people", name="scatter")
def scatter_about(count, spacing, rows):
    spots = []
    for index in range(count):
        angle, radius = index * 2.39996, spacing * 0.62 * math.sqrt(index + 0.5)
        spots.append((radius * math.cos(angle) + 0.25 * spacing * (scatter(index) - 0.5), radius * math.sin(angle) + 0.25 * spacing * (scatter(index + 50) - 0.5)))
    return spots


FORMATIONS.add("seated", "on the seats of the piece named as the position, spread over all of them", seated=True)


class Leg:
    """One walk: a path over the ground and how far along it the walker is at a time."""

    def __init__(self, start, points, gait, seconds):
        self.start, self.points, self.gait = start, [Vector(point) for point in points], gait
        self.stopped = math.inf
        self.lengths = [0.0]
        for first, second in pairwise(self.points):
            self.lengths.append(self.lengths[-1] + (second - first).length)
        self.total = self.lengths[-1]
        self.gait_speed = ACTIONS[gait].facts["speed"]
        self.seconds = seconds or self.total / self.gait_speed + EASE_INTO_WALK
        self.end = start + self.seconds
        self._ease = min(EASE_INTO_WALK, self.seconds / 2)

    def distance(self, time):
        """How far along the path the walker is: up to speed, steady, and slowing to a stop."""
        into = clamp(min(time, self.stopped) - self.start, 0.0, self.seconds)
        cruise = self.total / (self.seconds - self._ease)
        if into < self._ease:
            return cruise * into * into / (2 * self._ease)
        if into < self.seconds - self._ease:
            return cruise * (into - self._ease / 2)
        return self.total - cruise * (self.seconds - into) ** 2 / (2 * self._ease)

    def at(self, distance):
        distance = clamp(distance, 0.0, self.total)
        for index in range(1, len(self.points)):
            if distance <= self.lengths[index] or index == len(self.points) - 1:
                span = self.lengths[index] - self.lengths[index - 1]
                return self.points[index - 1].lerp(self.points[index], (distance - self.lengths[index - 1]) / span if span else 0.0)
        return self.points[0]

    def heading(self, time):
        """The way the path runs where the walker is, rounded off at corners."""
        distance = self.distance(time)
        return heading_toward(self.at(distance - 0.3), self.at(distance + 0.3)) if self.total > 0.01 else None


class Act:
    """Something the body does from a start to an end: an action with its options, or a custom pose."""

    def __init__(self, start, name, options, angles=None):
        self.start, self.end, self.name, self.options, self.angles = start, math.inf, name, options, angles
        self.facts = ACTIONS[name].facts

    def moves(self):
        """The span over which this visibly moves, rather than holds still."""
        if self.facts["kind"] == "loop":
            return self.start, self.end
        return self.start, self.start + self.facts.get("seconds", SETTLE_SECONDS)


class Moment:
    """What an action may know about its person at one time."""

    def __init__(self, person, time, since):
        self.person, self.time, self.since = person, time, since
        self.seed = person.seed
        self.walked, self.speed = person.walked(time), person.speed(time)

    def local(self, world_point):
        """A point of the world in the person's own figure space."""
        return self.person.root(self.time).inverted() @ Vector(world_point)

    def reach(self, side):
        """How far the thing held in a hand reaches past the grip."""
        held = self.person.holding(side, self.time)
        return held.reach if held else 0.0


class Person:
    def __init__(self, stage, person_id, identity, looks, look_id, spot, heading):
        """looks maps look ids to looks; look_id is worn first. spot is (x, y) and heading is in degrees left of +y."""
        self.stage, self.id, self.identity, self.looks = stage, person_id, identity, looks
        self.seed = scatter(len(stage.people) * 7.3 + len(person_id)) * 20
        self.scale = identity["height"] / 1.75
        self.height = identity["height"]
        self.contacts = set()
        self._spot = Vector(spot)
        self._legs, self._turns = [], [(-math.inf, lambda time: heading)]
        self._bodies, self._overlays, self._gestures = [Act(BEFORE_THE_SHOT, "stand", {})], [], []
        self._gazes, self._reaches, self._wears = [], [], [(-math.inf, look_id)]
        self._holds = {"L": [], "R": []}
        self._moves = []
        self._solved, self._solving = (None, None), False

    # ---- what staging tells a person, in time order
    def do(self, time, name, options):
        """Start an action. Options arrive resolved: partner a Person, prop a Piece, target a function of time giving a world point."""
        act, facts = Act(time, name, options), ACTIONS[name].facts
        if options.get("partner") is not None:
            self.contacts.add(options["partner"].id)
            options["partner"].contacts.add(self.id)
        if options.get("prop") is not None:
            self.contacts.add(options["prop"].id)
        for delay, kind in facts["sounds"]:
            self.stage.sound(time + delay, kind, self.id)
        if facts["kind"] == "gesture":
            self._gestures.append(act)
        elif facts["overlay"]:
            self._end_overlay(time)
            self._overlays.append(act)
        else:
            self._end_overlay(time)
            self._bodies[-1].end = time
            self._bodies.append(act)
        return act

    def pose(self, time, angles):
        """Hold a pose given as joint angles."""
        self._end_overlay(time)
        self._bodies[-1].end = time
        self._bodies.append(Act(time, "stand", {}, make_pose(**angles)))

    def walk(self, time, spots, gait, options, then, seconds):
        """Walk through spots; then is (action name, options) to take up on arriving. Returns the arrival time."""
        if self._legs:
            self._legs[-1].stopped = min(self._legs[-1].stopped, time)
        leg = Leg(time, [self.spot(time), *spots], gait, seconds)
        self._legs.append(leg)
        self.do(time, gait, options)
        self._turns.append((time, leg.heading))
        self._moves.append((time, leg.end))
        self.stage.sound(time, gait, self.id)
        prop = options.get("prop")
        if prop is not None and "end" not in options:
            prop.follows.append((time, lambda now: self.root(now) @ Matrix.Translation((0, 0.3, 1.0)) @ Matrix.Translation(-prop.focus)))
        if then:
            self.do(leg.end, *then)
        return leg.end

    def face(self, time, heading_at):
        """Turn to the heading heading_at(time) gives, and keep following it."""
        self._turns.append((time, heading_at))
        self._moves.append((time, time + TURN_SECONDS))

    def look(self, time, target):
        """Turn the head to follow target(time), or back to where the pose puts it when target is None."""
        self._gazes.append((time, target))
        self._moves.append((time, time + 0.4))

    def reach(self, time, seconds, arm, target):
        self._reaches.append((time, seconds, SIDES[arm], target))
        self._moves.append((time, time + seconds))

    def wear(self, time, look_id):
        self._wears.append((time, look_id))
        self._moves.append((time, time + 0.3))

    def hold(self, time, piece, arm):
        side = SIDES[arm]
        self._holds[side].append((time, piece))
        self.contacts.add(piece.id)

        def in_hand(now):
            solved = self.solved(now)
            return self.root(now) @ Matrix.Translation(solved.grip(side)) @ solved.world["hand" + side].to_4x4()

        piece.follows.append((time, in_hand))
        return in_hand

    def side_holding(self, piece, time):
        return next((side for side in "LR" if self.holding(side, time) is piece), None)

    def give(self, time, piece, receiver):
        self._holds[self.side_holding(piece, time)].append((time, None))
        receiver.hold(time, piece, "right")
        self.contacts.add(receiver.id)
        receiver.contacts.add(self.id)
        self.reach(time - 0.7, 1.3, "right", lambda now: receiver.point("hand_right", now))

    def put_on(self, time, piece, wearer):
        """Reach a held thing to the wearer's head, where it becomes part of what they wear and leaves the hand."""
        side = self.side_holding(piece, time)
        arm = next(name for name, letter in SIDES.items() if letter == side)
        self._holds[side].append((time, None))
        self.contacts.add(wearer.id)
        wearer.contacts.add(self.id)
        self.reach(time - 0.8, 1.4, arm, lambda now: wearer.point("head", now) + Vector((0, 0, 0.12)))
        piece.follows.append((time, lambda now: Matrix.Translation(wearer.point("head", now)) @ Matrix.Scale(0, 4)))

    def drop(self, time, piece, onto):
        """Let a held thing go; it comes to rest at the world point onto, or on the ground under the hand."""
        side = self.side_holding(piece, time)
        in_hand = next(follow for start, follow in reversed(piece.follows) if start <= time)
        self._holds[side].append((time, None))
        self._moves.append((time, time + 0.4))
        released = {}

        def falling(now):
            if not released:
                released["from"] = in_hand(time)
                below = released["from"].translation
                released["to"] = Vector(onto) if onto is not None else Vector((below.x, below.y, self.stage.ground.height(below.x, below.y) + 0.03))
            weight = ramp(now, time, time + 0.35)
            turned = released["from"].to_quaternion().slerp(rotation_z(self.heading(time)).to_quaternion(), weight)
            return Matrix.Translation(released["from"].translation.lerp(released["to"], weight)) @ turned.to_matrix().to_4x4()

        piece.follows.append((time, falling))

    def build(self):
        """Make the body, once everything the person does is known."""
        self.figure = Figure(self.id, self.identity, self.looks)
        self.stage.animate(self._show)
        for act in [*self._bodies[1:], *self._overlays, *self._gestures]:
            start, end = act.moves()
            self._moves.append((start, min(end, act.end)))
        for start, end in self._moves:
            self.stage.acts(start, min(end, self.stage.duration + 1), lambda time: self.point("chest", time))

    # ---- where the person is
    def spot(self, time):
        """The spot on the ground the person's own walking has brought them to."""
        started = [leg for leg in self._legs if leg.start <= time]
        return started[-1].at(started[-1].distance(time)) if started else self._spot.copy()

    def walked(self, time):
        return sum(leg.distance(time) for leg in self._legs if leg.start <= time)

    def speed(self, time):
        return (self.walked(time + 0.02) - self.walked(time - 0.02)) / 0.04

    def walking(self, time):
        """The walk under way at a time, or None when the person stays where they are."""
        under_way = [leg for leg in self._legs if leg.start <= time < min(leg.end, leg.stopped)]
        return under_way[-1] if under_way else None

    def heading(self, time):
        heading = None
        for start, heading_at in self._turns:
            wanted = heading_at(time) if start <= time else None
            if wanted is None:
                continue
            heading = wanted if heading is None else heading + angle_difference(wanted, heading) * smooth((time - start) / TURN_SECONDS)
        return heading

    def _body(self, time):
        return [act for act in self._bodies if act.start <= time][-1]

    def root(self, time):
        """The person's figure space in the world: feet on the ground, or on the litter they ride."""
        body = self._body(time)
        if body.facts.get("rides"):
            return body.options["prop"].matrix(time) @ Matrix.Translation(ON_THE_LITTER) @ Matrix.Diagonal((self.scale, self.scale, self.scale, 1))
        spot = self.spot(time)
        return placement((spot.x, spot.y, self.stage.ground.height(spot.x, spot.y)), rotation_z(self.heading(time)), self.scale)

    def rides(self, time):
        return bool(self._body(time).facts.get("rides"))

    def holding(self, side, time):
        held = [piece for start, piece in self._holds[side] if start <= time]
        return held[-1] if held else None

    def point(self, name, time):
        """A named point of the body in the world; no name gives the chest."""
        if name == "feet":
            return self.root(time).translation
        joint, offset = POINTS[name or "chest"]
        return self.root(time) @ self.solved(time).point(joint, offset)

    def gaze(self, time):
        """The way the face points, in the world."""
        return (self.root(time).to_3x3() @ self.solved(time).world["head"] @ Vector((0, 1, 0))).normalized()

    def busy(self, time):
        return any(start <= time <= end for start, end in self._moves)

    # ---- what the body does
    def _end_overlay(self, time):
        if self._overlays:
            self._overlays[-1].end = min(self._overlays[-1].end, time)

    def _perform(self, act, time, base=None):
        if act.angles is not None:
            return {**ACTIONS["stand"].make(Moment(self, time, 0.0)), **act.angles}
        moment = Moment(self, time, time - act.start)
        options = {key: moment.local(value(time)) if key == "target" and value is not None else value for key, value in act.options.items()}
        return ACTIONS[act.name].make(moment, **options) if base is None else ACTIONS[act.name].make(moment, base, **options)

    def _pose_at(self, time):
        bodies = [act for act in self._bodies if act.start <= time]
        pose = self._perform(bodies[-1], time)
        settled = smooth((time - bodies[-1].start) / BODY_BLEND)
        if len(bodies) > 1 and settled < 1:
            pose = blend(self._perform(bodies[-2], time), pose, settled)
        for act in self._overlays:
            weight = ramp(time, act.start, act.start + OVERLAY_BLEND) * (1 - ramp(time, act.end, act.end + OVERLAY_BLEND))
            if weight > 0:
                pose = blend(pose, self._perform(act, time, pose), weight)
        for act in self._gestures:
            end = act.start + act.facts["seconds"]
            weight = ramp(time, act.start, act.start + 0.15) * (1 - ramp(time, end - 0.3, end))
            if weight > 0:
                pose = blend(pose, self._perform(act, time, pose), weight)
        inverse = self.root(time).inverted()
        for start, seconds, side, target in self._reaches:
            weight = ramp(time, start, start + 0.45) * (1 - ramp(time, start + seconds - 0.45, start + seconds))
            if weight > 0:
                reach_arm(pose, side, inverse @ Vector(target(time)), weight=weight)
        self._turn_head(pose, time, inverse)
        self._enliven(pose, time)
        return pose

    def _turn_head(self, pose, time, inverse):
        gazes = [gaze for gaze in self._gazes if gaze[0] <= time]
        own_turn, own_nod = pose.get("head_turn", 0.0), pose.get("head_nod", 0.0)
        for index, (start, target) in enumerate(gazes[-2:]):
            weight = ramp(time, start, start + 0.4) if index == len(gazes[-2:]) - 1 else 1.0
            turn, nod = own_turn, own_nod
            if target is not None:
                toward = (inverse @ Vector(target(time)) - Vector((0, 0, 1.62))).normalized()
                yaw = math.degrees(math.atan2(-toward.x, toward.y)) - pose.get("chest_twist", 0.0) - pose.get("hips_yaw", 0.0)
                pitch = math.degrees(math.asin(clamp(toward.z, -1, 1))) + pose.get("chest_bend", 0.0) + pose.get("hips_pitch", 0.0)
                turn, nod = clamp(angle_difference(yaw, 0.0), -80, 80), clamp(-pitch, -45, 55)
            pose["head_turn"], pose["head_nod"] = lerp(pose.get("head_turn", 0.0), turn, weight), lerp(pose.get("head_nod", 0.0), nod, weight)

    def _enliven(self, pose, time):
        """Breath, small shifts of weight, and cloth that trails behind a moving body."""
        life = pose.get("life", 1.0)
        breath = math.sin(time * 1.7 + self.seed)
        pose["chest_bend"] = pose.get("chest_bend", 0.0) + 0.9 * breath * life
        pose["head_nod"] = pose.get("head_nod", 0.0) + (0.8 * breath + 2.2 * wobble(time, self.seed, 0.23)) * life
        pose["head_turn"] = pose.get("head_turn", 0.0) + 4.0 * wobble(time, self.seed + 3, 0.19) * life
        pose["hips_roll"] = pose.get("hips_roll", 0.0) + 1.2 * wobble(time, self.seed + 5, 0.13) * life
        for side in "LR":
            pose[f"arm{side}_fwd"] = pose.get(f"arm{side}_fwd", 0.0) + 1.6 * wobble(time, self.seed + 7 + ord(side), 0.21) * life
        moving = clamp(abs(self.speed(time)) / 3.4)
        flutter = wobble(time, self.seed + 11, 1.3) * (2.0 + 9.0 * moving)
        pose["tails"] = pose.get("tails", 0.0) - 16 * moving + flutter
        pose["front"] = pose.get("front", 0.0) - 6 * moving + 0.5 * flutter
        pose["cloak"] = pose.get("cloak", 0.0) - 24 * moving + 1.4 * flutter

    def solved(self, time):
        if self._solved[0] == time:
            return self._solved[1]
        if self._solving:
            # Two people holding each other each need the other's pose; the second one asked answers standing.
            return solve(make_pose())
        self._solving = True
        try:
            self._solved = (time, solve(self._pose_at(time)))
        finally:
            self._solving = False
        return self._solved[1]

    def _show(self, time):
        worn = [look_id for start, look_id in self._wears if start <= time][-1]
        self.figure.wear(worn)
        self.figure.pose(self.solved(time), self.root(time))


def carry_between(prop, front, rear, time):
    """From a time on, a long prop rides level between two carriers, its handles at their hands."""

    def carried(now):
        ahead, behind = front.point("feet", now), rear.point("feet", now)
        middle = (ahead + behind) / 2
        lift = CARRY_HEIGHT * (front.scale + rear.scale) / 2 - prop.points["handle_front_left"].z
        return placement((middle.x, middle.y, middle.z + lift), rotation_z(heading_toward(behind, ahead)))

    prop.follows.append((time, carried))


def handle_span(prop):
    """How far apart two carriers must walk to hold a prop's two ends, or None when it has no handles."""
    if "handle_front_left" not in prop.points or "handle_rear_left" not in prop.points:
        return None
    return (prop.points["handle_front_left"] - prop.points["handle_rear_left"]).length
