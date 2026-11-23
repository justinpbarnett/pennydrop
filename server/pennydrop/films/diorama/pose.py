"""The body as joint angles: the skeleton, the pose vocabulary, the forward solve and arm reach.

A pose is a flat dict of named angles in degrees, so blending two poses is a blend of their numbers.
Figure space has the feet on z = 0, the face toward +y and the left side at -x, at the reference height.
"""

import math
from itertools import pairwise

from mathutils import Vector

from .maths import clamp, lerp, rotation_x, rotation_y, rotation_z, smooth

REFERENCE_HEIGHT = 1.75
SHOULDER_X, HIP_X = 0.255, 0.105
UPPER_ARM, FOREARM = 0.28, 0.30
SIDES = {"left": "L", "right": "R"}
SIDE_X = {"L": -1.0, "R": 1.0}
# Where a held thing sits in the hand: on the palm, below the wrist, with its length along +y.
GRIP_DROP, GRIP_INWARD = 0.03, 0.045
# What a key means when a pose leaves it out.
NEUTRAL = {"ground": 1.0, "life": 1.0, "gripL": 0.25, "gripR": 0.25}

REST = {
    "hips": (None, (0, 0, 0.92)),
    "chest": ("hips", (0, 0, 1.04)),
    "head": ("chest", (0, 0, 1.46)),
    "tails": ("hips", (0, -0.10, 1.0)),
    "front": ("hips", (0, 0.08, 1.0)),
    "cloak": ("chest", (0, -0.11, 1.42)),
}
for _side, _x in SIDE_X.items():
    REST["arm" + _side] = ("chest", (_x * SHOULDER_X, 0, 1.37))
    REST["fore" + _side] = ("arm" + _side, (_x * SHOULDER_X, 0, 1.09))
    REST["hand" + _side] = ("fore" + _side, (_x * SHOULDER_X, 0, 0.83))
    REST["fingers" + _side] = ("hand" + _side, (_x * SHOULDER_X, 0, 0.765))
    REST["tips" + _side] = ("fingers" + _side, (_x * SHOULDER_X, 0, 0.732))
    REST["thumb" + _side] = ("hand" + _side, (_x * (SHOULDER_X - 0.012), 0.036, 0.8))
    REST["leg" + _side] = ("hips", (_x * HIP_X, 0, 0.90))
    REST["shin" + _side] = ("leg" + _side, (_x * HIP_X, 0, 0.49))
    REST["foot" + _side] = ("shin" + _side, (_x * HIP_X, 0, 0.085))
JOINTS = ["hips", "chest", "head", "tails", "front", "cloak"] + [joint + side for side in "LR" for joint in ("arm", "fore", "hand", "fingers", "tips", "thumb", "leg", "shin", "foot")]
REST_POSITION = {joint: Vector(REST[joint][1]) for joint in JOINTS}

# Points that may rest on the ground: joint -> [(offset, radius)].
CONTACTS = {"hips": [((0, 0, 0), 0.14)], "chest": [((0, 0, 0.25), 0.15)], "head": [((0, 0, 0.175), 0.175)]}
for _side in "LR":
    CONTACTS["foot" + _side] = [((0, -0.06, -0.085), 0), ((0, 0.17, -0.085), 0)]
    CONTACTS["shin" + _side] = [((0, 0, 0), 0.07)]
    CONTACTS["fore" + _side] = [((0, 0, 0), 0.05)]
    CONTACTS["hand" + _side] = [((0, 0, -0.04), 0.05)]

# A key written without a side sets both sides.
SYMMETRIC = ("arm_fwd", "arm_out", "arm_twist", "elbow", "hand_bend", "hand_twist", "grip", "leg_fwd", "leg_out", "leg_twist", "knee", "foot")
BODY_ANGLES = {
    "hips_yaw": "turn of the whole body at the hips", "hips_pitch": "lean forward from the hips (negative leans back, -90 lies on the back)",
    "hips_roll": "tilt to the side", "chest_twist": "twist of the upper body", "chest_bend": "bend forward at the waist",
    "chest_side": "bend sideways at the waist", "head_turn": "head to the left (negative to the right)", "head_nod": "head down (negative up)",
    "head_tilt": "head tilted to the shoulder", "arm_fwd": "upper arm raised forward (180 is straight up, negative is back)",
    "arm_out": "upper arm raised out to the side", "arm_twist": "upper arm turned inward", "elbow": "elbow bent",
    "hand_bend": "wrist bent", "hand_twist": "wrist turned", "grip": "fingers closed, 0 open to 1 a fist",
    "leg_fwd": "thigh raised forward (negative back)", "leg_out": "thigh out to the side", "leg_twist": "thigh turned",
    "knee": "knee bent", "foot": "foot raised at the ankle", "lift": "whole body raised, in meters",
}  # fmt: skip


def pose_key_names():
    names = []
    for key in BODY_ANGLES:
        names.append(key)
        if key in SYMMETRIC:
            names += [_sided(key, side) for side in "LR"]
    return names


def _sided(key, side):
    joint, _, angle = key.partition("_")
    return joint + side + ("_" + angle if angle else "")


def make_pose(**angles):
    """A pose from named angles; a key without L or R, such as arm_out or knee, sets both sides."""
    pose = {}
    for key, value in angles.items():
        if key in SYMMETRIC:
            for side in "LR":
                pose.setdefault(_sided(key, side), value)
        else:
            pose[key] = value
    return pose


def blend(first, second, weight):
    if weight <= 0:
        return dict(first)
    if weight >= 1:
        return dict(second)
    return {key: lerp(first.get(key, NEUTRAL.get(key, 0.0)), second.get(key, NEUTRAL.get(key, 0.0)), weight) for key in set(first) | set(second)}


def sequence(local_time, keys):
    """Blend through [(time, pose)] with eased steps."""
    if local_time <= keys[0][0]:
        return dict(keys[0][1])
    for (start, start_pose), (end, end_pose) in pairwise(keys):
        if local_time <= end:
            return blend(start_pose, end_pose, smooth((local_time - start) / (end - start)))
    return dict(keys[-1][1])


class Solved:
    """A pose worked out: each joint's local rotation, world rotation and position in figure space."""

    def __init__(self, local, world, position):
        self.local, self.world, self.position = local, world, position

    def point(self, joint, offset=(0, 0, 0)):
        return self.position[joint] + self.world[joint] @ Vector(offset)

    def grip(self, side):
        """Where the hand of a side holds things."""
        return self.point("hand" + side, (-SIDE_X[side] * GRIP_INWARD, 0, -GRIP_DROP))


def solve(pose):
    """Work a pose out, resting the lowest part of the body on the ground."""
    angle = pose.get
    local = {
        "hips": rotation_z(angle("hips_yaw", 0)) @ rotation_x(-angle("hips_pitch", 0)) @ rotation_y(angle("hips_roll", 0)),
        "chest": rotation_z(angle("chest_twist", 0)) @ rotation_x(-angle("chest_bend", 0)) @ rotation_y(angle("chest_side", 0)),
        "head": rotation_z(angle("head_turn", 0)) @ rotation_x(-angle("head_nod", 0)) @ rotation_y(angle("head_tilt", 0)),
    }
    for side in "LR":
        mirror = -SIDE_X[side]
        local["arm" + side] = rotation_x(angle(f"arm{side}_fwd", 0)) @ rotation_y(mirror * angle(f"arm{side}_out", 0)) @ rotation_z(-mirror * angle(f"arm{side}_twist", 0))
        local["fore" + side] = rotation_x(angle("elbow" + side, 0))
        local["hand" + side] = rotation_x(angle(f"hand{side}_bend", 0)) @ rotation_z(-mirror * angle(f"hand{side}_twist", 0))
        curl = clamp(angle("grip" + side, 0.25)) * 85
        local["fingers" + side] = rotation_y(-mirror * curl)
        local["tips" + side] = rotation_y(-mirror * curl)
        local["thumb" + side] = rotation_y(-mirror * curl * 0.5) @ rotation_x(-curl * 0.4)
        local["leg" + side] = rotation_x(angle(f"leg{side}_fwd", 0)) @ rotation_y(mirror * angle(f"leg{side}_out", 0)) @ rotation_z(mirror * angle(f"leg{side}_twist", 0))
        local["shin" + side] = rotation_x(-angle("knee" + side, 0))
        local["foot" + side] = rotation_x(angle("foot" + side, 0))
    # Cloth hangs with gravity, and a skirt opens no further than the thighs push it.
    hang = clamp(angle("hips_pitch", 0), -25, 75)
    rear_thigh = min(angle("legL_fwd", 0), angle("legR_fwd", 0)) - 5
    front_thigh = max(angle("legL_fwd", 0), angle("legR_fwd", 0)) + 4
    local["tails"] = rotation_x(min(hang, rear_thigh) + angle("tails", 0))
    local["front"] = rotation_x(max(hang, front_thigh) + angle("front", 0))
    local["cloak"] = rotation_x(clamp(angle("hips_pitch", 0) + angle("chest_bend", 0), -20, 80) + angle("cloak", 0))

    world, position = {}, {}
    for joint in JOINTS:
        parent = REST[joint][0]
        if parent is None:
            world[joint] = local[joint]
            position[joint] = Vector((angle("root_x", 0), angle("root_y", 0), 0))
        else:
            world[joint] = world[parent] @ local[joint]
            position[joint] = position[parent] + world[parent] @ (REST_POSITION[joint] - REST_POSITION[parent])
        # A hand can hold its prop at a set angle in figure space, whatever the arm does.
        if joint.startswith("hand"):
            weight = angle(joint + "_aim", 0)
            if weight > 0.001:
                wanted = (rotation_z(angle(joint + "_yaw", 0)) @ rotation_x(angle(joint + "_pitch", 0)) @ rotation_y(angle(joint + "_roll", 0))).to_quaternion()
                world[joint] = world[joint].to_quaternion().slerp(wanted, clamp(weight)).to_matrix()
                local[joint] = world[parent].inverted() @ world[joint]
    lowest = min((position[joint] + world[joint] @ Vector(offset)).z - radius for joint, points in CONTACTS.items() for offset, radius in points)
    rise = lerp(REST_POSITION["hips"].z, -lowest, angle("ground", 1.0)) + angle("lift", 0)
    for joint in JOINTS:
        position[joint] = position[joint] + Vector((0, 0, rise))
    return Solved(local, world, position)


def aim_arm(pose, side, direction, elbow=5.0, weight=1.0):
    """Point a straight arm along a direction given in chest space."""
    direction = Vector(direction).normalized()
    wanted = {
        f"arm{side}_out": math.degrees(math.asin(clamp(direction.x * SIDE_X[side], -1, 1))),
        f"arm{side}_fwd": math.degrees(math.atan2(direction.y, -direction.z)),
        f"arm{side}_twist": 0.0,
        "elbow" + side: elbow,
    }
    for key, value in wanted.items():
        pose[key] = lerp(pose.get(key, 0.0), value, weight)
    return pose


def reach(pose, side, target, pole=None, weight=1.0):
    """Two bone reach: put the wrist of a side on a point given in figure space."""
    if weight <= 0.001:
        return pose
    side_x = SIDE_X[side]
    solved = solve(pose)
    shoulder = REST_POSITION["arm" + side]
    in_chest = solved.world["chest"].inverted() @ (Vector(target) - solved.position["chest"]) + REST_POSITION["chest"]
    toward = in_chest - shoulder
    distance = clamp(toward.length, 0.1, (UPPER_ARM + FOREARM) * 0.998)
    toward = toward.normalized()
    shoulder_angle = math.acos(clamp((UPPER_ARM**2 + distance**2 - FOREARM**2) / (2 * UPPER_ARM * distance), -1, 1))
    pole = Vector(pole or (side_x * 0.6, -0.5, -1))
    bend = pole - toward * pole.dot(toward)
    bend = bend.normalized() if bend.length > 1e-4 else Vector((side_x, 0, 0))
    upper = (toward * math.cos(shoulder_angle) + bend * math.sin(shoulder_angle)).normalized()
    lower = (toward * distance - upper * UPPER_ARM).normalized()
    out = math.degrees(math.asin(clamp(upper.x * side_x, -1, 1)))
    forward = math.degrees(math.atan2(upper.y, -upper.z))
    untwisted = rotation_x(forward) @ rotation_y(-side_x * out)
    across = lower - upper * lower.dot(upper)
    twist = 0.0
    if across.length > 1e-4:
        across = untwisted.inverted() @ across.normalized()
        twist = math.degrees(math.atan2(-across.x, across.y)) * side_x
    wanted = {f"arm{side}_out": out, f"arm{side}_fwd": forward, f"arm{side}_twist": twist, "elbow" + side: math.degrees(math.acos(clamp(upper.dot(lower), -1, 1)))}
    for key, value in wanted.items():
        pose[key] = lerp(pose.get(key, 0.0), value, weight)
    return pose


def grasp(pose, side, target, pole=None, weight=1.0):
    """Close the hand of a side around a point given in figure space."""
    target = Vector(target)
    wrist = target + Vector((0, 0, GRIP_DROP))
    for _ in range(3):
        wrist = wrist + (target - solve(reach(dict(pose), side, wrist, pole)).grip(side))
    reach(pose, side, wrist, pole, weight)
    pose["grip" + side] = lerp(pose.get("grip" + side, 0.25), 1.0, weight)
    return pose


def reach_joint(pose, side, joint, offset, pole=None, weight=1.0):
    """Put a hand on a point of the person's own body."""
    return reach(pose, side, solve(pose).point(joint, offset), pole, weight)


def aim_hand(pose, pitch=0.0, yaw=0.0, weight=1.0, side="R", roll=0.0):
    """Hold whatever is in a hand at an angle in figure space: pitch up from level, yaw to the left."""
    pose[f"hand{side}_aim"], pose[f"hand{side}_pitch"], pose[f"hand{side}_yaw"], pose[f"hand{side}_roll"] = weight, pitch, yaw, roll
    pose["grip" + side] = 1.0
    return pose


def hold_two_handed(pose, along=0.55):
    """Bring the left hand onto the long thing held in the right hand, some way along it."""
    return grasp(pose, "L", solve(pose).point("handR", (-GRIP_INWARD, along, -GRIP_DROP)))
