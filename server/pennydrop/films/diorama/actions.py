"""The action vocabulary: every action turns a moment into a pose.

A body action poses the whole person from nothing.
An overlay action changes the pose it is given, so a seated person can talk and a kneeling one can point.
A moment carries the clock, how far the person has walked, and what the hands hold.
Targets arrive as points in the person's own figure space.
"""

import math

from mathutils import Vector

from .maths import clamp, pulse, ramp
from .pose import (
    GRIP_DROP,
    REST_POSITION,
    SIDES,
    aim_arm,
    aim_hand,
    blend,
    grasp,
    hold_two_handed,
    make_pose,
    reach,
    reach_joint,
    sequence,
    solve,
)
from .spec import Choice, Number, Registry
from .where import Aim, Named

ACTIONS = Registry("action")
ARM = (Choice(["left", "right"], "arm"), "right")
AHEAD = Vector((0, 10, 1.4))


def action(about, kind, overlay=False, seconds=None, speed=None, step=None, sounds=(), rides=False, **options):
    """Register an action. kind is pose, loop, gesture or locomotion; sounds are (seconds after the start, what is heard).

    An action that rides puts the person on its prop, wherever the prop goes.
    """
    facts = {"kind": kind, "overlay": overlay, "sounds": sounds}
    if rides:
        facts["rides"] = True
    if seconds:
        facts["seconds"] = seconds
    if speed:
        facts["speed"], facts["step"] = speed, step
    return ACTIONS.register(about, options, **facts)


def gaits():
    return [name for name, entry in ACTIONS.entries.items() if entry.facts["kind"] == "locomotion"]


def _direction_angles(direction):
    """Pitch up and yaw left, in degrees, of a direction in figure space."""
    direction = Vector(direction).normalized()
    return math.degrees(math.asin(clamp(direction.z, -1, 1))), math.degrees(math.atan2(-direction.x, direction.y))


def _turn_head(pose, target, share=0.6):
    pitch, yaw = _direction_angles(Vector(target) - Vector((0, 0, 1.6)))
    pose["head_turn"] = clamp(yaw, -75, 75) * share
    pose["head_nod"] = -pitch * 0.6
    return clamp(yaw, -75, 75)


# ---------------------------------------------------------------- postures
@action("standing relaxed", "pose")
def stand(moment):
    return make_pose(arm_out=6, elbow=12, arm_twist=8)


@action("standing stiff and straight", "pose")
def attention(moment):
    return make_pose(arm_out=3, elbow=4, chest_bend=-3, head_nod=-3, life=0.5)


@action("standing with the hands clasped behind the back", "pose")
def at_ease(moment):
    return make_pose(arm_fwd=-22, arm_out=4, elbow=42, arm_twist=75, chest_bend=-3, leg_out=5, grip=0.6)


@action("standing with the right hand tucked into the coat", "pose")
def hand_in_coat(moment):
    pose = make_pose(armL_fwd=-20, armL_out=4, elbowL=40, armL_twist=70, chest_bend=-2)
    return reach(pose, "R", (0.02, 0.16, 1.22), pole=(1, -0.2, -0.6))


@action("standing with a musket or pole upright against the right shoulder", "pose")
def shoulder_arms(moment):
    pose = make_pose(armL_out=4, elbowL=5, armR_fwd=16, elbowR=100, chest_bend=-2, life=0.5)
    return aim_hand(pose, pitch=97)


@action("standing beaten: shoulders dropped, head down", "pose")
def slump(moment):
    return make_pose(chest_bend=14, head_nod=26, arm_out=4, elbow=6, hips_pitch=2, knee=6, leg_fwd=3)


@action("standing with the arms crossed", "pose")
def arms_crossed(moment):
    pose = make_pose(chest_bend=-2)
    reach(pose, "L", (0.14, 0.2, 1.2), pole=(-1, -0.2, -0.6))
    return reach(pose, "R", (-0.12, 0.23, 1.24), pole=(1, -0.2, -0.6))


@action("sitting on a seat, hands on the thighs", "pose")
def sit(moment):
    return make_pose(leg_fwd=84, knee=86, leg_out=5, chest_bend=5, arm_fwd=32, arm_out=6, elbow=48, arm_twist=10)


@action("sitting on the ground, knees drawn up", "pose")
def sit_on_ground(moment):
    return make_pose(hips_pitch=-12, leg_fwd=62, knee=105, chest_bend=24, arm_fwd=62, elbow=22, head_nod=4)


@action("crouching low on both feet", "pose")
def crouch(moment):
    return make_pose(leg_fwd=95, knee=128, foot=18, hips_pitch=28, chest_bend=6, arm_fwd=48, elbow=45, head_nod=-14)


@action("one knee on the ground, back straight", "pose")
def kneel(moment):
    return make_pose(legL_fwd=88, kneeL=92, footL=4, legR_fwd=-8, kneeR=100, footR=10, hips_pitch=4, chest_bend=4, arm_out=6, elbow=25, armL_fwd=35, elbowL=50)


@action("down on one knee, bent over a hurt thigh with a hand pressed on it", "pose")
def kneel_wounded(moment):
    pose = kneel(moment)
    sway = math.sin(moment.time * 2.4)
    pose.update(chest_bend=24 + 3 * sway, head_nod=16, hips_pitch=10, hips_roll=-4, armR_fwd=10, elbowR=35, armR_out=14)
    reach_joint(pose, "L", "legL", (0.0, 0.1, -0.24), pole=(-1, -0.4, -0.3))
    return aim_hand(pose, pitch=-25, weight=0.8)


@action("lying on the back, one knee up, stirring", "pose")
def lie(moment):
    stir = moment.time * 1.7 + moment.seed
    return make_pose(
        hips_pitch=-90, legL_fwd=8, kneeL=10, legR_fwd=38 + 5 * math.sin(stir), kneeR=65 + 8 * math.sin(stir), armL_out=42, armL_fwd=10, armR_out=14,
        armR_fwd=30, elbowR=95, armR_twist=60, elbowL=20, chest_bend=5, head_nod=8, head_turn=18 * math.sin(stir * 0.6), tails=20, life=0.3,
    )  # fmt: skip


@action("lying on a litter, bed or table; the person goes where the prop goes", "pose", rides=True, prop=Named("prop"))
def lie_on(moment, prop):
    pose = lie(moment)
    pose.update(legR_fwd=20, kneeR=30, armL_out=10, tails=0)
    return pose


@action("hit: buckle, sit down hard and end flat on the back", "pose", sounds=((0.9, "fall"),))
def fall_wounded(moment):
    crumple = make_pose(hips_pitch=-28, chest_bend=14, knee=95, leg_fwd=42, arm_out=48, arm_fwd=-12, elbow=30, head_nod=12)
    seated = make_pose(hips_pitch=-58, leg_fwd=62, knee=55, chest_bend=18, arm_fwd=-35, arm_out=30, elbow=15, head_nod=5)
    return sequence(moment.since, [(0, stand(moment)), (0.17, _recoiling()), (0.5, crumple), (0.86, seated), (1.2, lie(moment))])


@action("stabbed or shot in the leg: jolt back, the leg gives, down on one knee", "pose", sounds=((0.0, "hit"),), partner=(Named("person"), None))
def struck(moment, partner=None):
    jolt = make_pose(chest_bend=-14, head_nod=-18, arm_out=38, arm_fwd=15, elbow=40, legL_fwd=30, kneeL=45, legR_fwd=-12, kneeR=25, hips_pitch=-6)
    return sequence(moment.since, [(0, jolt), (0.22, jolt), (0.85, kneel_wounded(moment))])


@action("wounded on one knee but still pointing the others on toward the target", "loop", target=(Aim(), None))
def press_on(moment, target=None):
    pose = kneel_wounded(moment)
    pose.update(chest_bend=10, head_nod=-6)
    aim_arm(pose, "R", _from_shoulder(pose, "R", target), elbow=8 + 8 * abs(math.sin(moment.since * 6)))
    return aim_hand(pose, pitch=20)


@action("leaning with both hands planted on a table in front", "pose", height=(Number(0.5, 1.3), 0.95))
def lean_on_table(moment, height=0.95):
    pose = make_pose(chest_bend=12, hips_pitch=6, leg_fwd=6, head_nod=-4)
    reach(pose, "L", (-0.3, 0.42, height + GRIP_DROP))
    return reach(pose, "R", (0.3, 0.42, height + GRIP_DROP))


@action("left hand on a table, right finger jabbing at a map or paper on it", "loop", height=(Number(0.5, 1.3), 0.95), target=(Aim(), None))
def point_map(moment, height=0.95, target=None):
    pose = make_pose(chest_bend=13, hips_pitch=6, leg_fwd=6, head_nod=2)
    jab = 0.07 * abs(math.sin(moment.since * 5.5)) * (0.4 + 0.6 * math.exp(-moment.since * 0.8))
    spot = Vector((0.1, 0.55, height)) if target is None else Vector((clamp(target.x, -0.45, 0.5), clamp(target.y, 0.3, 0.72), height))
    reach(pose, "L", (-0.32, 0.38, height + GRIP_DROP))
    pose["gripR"] = 0.7
    return reach(pose, "R", spot + Vector((0, 0, 0.1 + jab)), pole=(1, -0.4, -0.2))


@action("musket to the shoulder, aiming", "pose", pitch=(Number(-30, 45), 0.0))
def aim(moment, pitch=0.0):
    pose = make_pose(chest_twist=-28, head_turn=24, head_tilt=-8, legL_fwd=14, legR_fwd=-12, kneeL=10, hips_yaw=-12, chest_bend=6)
    reach(pose, "R", (0.2, 0.30, 1.36), pole=(1, -0.3, -0.3))
    aim_hand(pose, pitch=pitch, yaw=6)
    return hold_two_handed(pose, 0.5)


@action("bayonet or spear forward, knees bent, waiting", "pose")
def guard(moment):
    pose = make_pose(legL_fwd=26, kneeL=30, legR_fwd=-20, kneeR=22, hips_pitch=10, chest_twist=-22, head_turn=18, armR_fwd=-12, armR_out=10, elbowR=70)
    aim_hand(pose, pitch=6 + 2 * math.sin(moment.time * 3))
    return hold_two_handed(pose, 0.6)


@action("driving a ramrod or pole home, again and again", "loop", rate=(Number(0.3, 3), 1.1))
def ram(moment, rate=1.1):
    stroke = math.sin(moment.since * 2 * math.pi * rate)
    pose = make_pose(legL_fwd=22, kneeL=22 + 10 * stroke, legR_fwd=-18, kneeR=8, hips_pitch=12 + 6 * stroke, chest_bend=8 + 5 * stroke, chest_twist=-16, root_y=0.1 * stroke)
    reach(pose, "R", (0.16, 0.42 + 0.22 * stroke, 1.08), pole=(1, -0.5, -0.4))
    aim_hand(pose, pitch=3)
    return hold_two_handed(pose, 0.5)


@action("shoulder down, shoving something heavy forward", "loop")
def heave(moment):
    push = math.sin(moment.since * 5)
    pose = make_pose(hips_pitch=30, chest_bend=14, legL_fwd=50 + 8 * push, kneeL=58, legR_fwd=-8 - 6 * push, kneeR=12, head_nod=-12, arm_twist=10, grip=0.1)
    reach(pose, "L", (-0.2, 0.62, 1.0 + 0.03 * push))
    return reach(pose, "R", (0.2, 0.62, 1.0 + 0.03 * push))


@action("turned half away with the hands over the ears", "pose")
def cover_ears(moment):
    pose = make_pose(chest_bend=16, chest_twist=22, head_nod=18, knee=14, leg_fwd=8, hips_pitch=4, grip=0.1)
    solved = solve(pose)
    reach(pose, "L", solved.point("head", (-0.19, 0.02, 0.2)), pole=(-1, 0.2, -0.4))
    return reach(pose, "R", solved.point("head", (0.19, 0.02, 0.2)), pole=(1, 0.2, -0.4))


@action("arms around another person", "pose", partner=Named("person"))
def embrace(moment, partner):
    pose = make_pose(chest_bend=10, head_tilt=14, head_nod=6, grip=0.1)
    reach(pose, "L", moment.local(partner.point("shoulder_right", moment.time)) + Vector((0, 0.1, 0)), pole=(-1, 0, -0.3))
    return reach(pose, "R", moment.local(partner.point("shoulder_left", moment.time)) + Vector((0, 0.1, -0.2)), pole=(1, 0, -0.3))


@action("struggling with another person, hands on their shoulders, shoving", "loop", partner=Named("person"))
def grapple(moment, partner):
    shove = math.sin(moment.since * 6 + moment.seed)
    pose = make_pose(legL_fwd=28, kneeL=30, legR_fwd=-22, kneeR=14, hips_pitch=14 + 5 * shove, chest_bend=6, head_nod=-8, root_y=0.05 * shove)
    grasp(pose, "L", moment.local(partner.point("shoulder_right", moment.time)))
    return grasp(pose, "R", moment.local(partner.point("shoulder_left", moment.time)))


@action("gripping another person by the arm to hold or drag them", "pose", partner=Named("person"), arm=ARM)
def seize(moment, partner, arm="right"):
    pose = make_pose(armL_out=6, elbowL=12, armR_out=6, elbowR=12, chest_bend=4)
    nearest = min(("shoulder_left", "shoulder_right"), key=lambda point: (moment.local(partner.point(point, moment.time))).length)
    return grasp(pose, SIDES[arm], moment.local(partner.point(nearest, moment.time)) + Vector((0, 0, -0.16)))


# ---------------------------------------------------------------- locomotion
def _gait(moment, step, swing, knee, arm, lean):
    phase = math.pi * moment.walked / step
    stride, lift = math.sin(phase), math.cos(phase)
    return make_pose(
        legL_fwd=swing * stride, legR_fwd=-swing * stride, kneeL=6 + knee * max(0, lift) ** 1.3, kneeR=6 + knee * max(0, -lift) ** 1.3,
        footL=-10 * max(0, -stride), footR=-10 * max(0, stride), armL_fwd=-arm * stride, armR_fwd=arm * stride,
        elbowL=18 + 12 * max(0, -stride), elbowR=18 + 12 * max(0, stride), arm_out=6, chest_twist=-6 * stride, hips_yaw=4 * stride,
        hips_pitch=lean, hips_roll=2.5 * lift, chest_bend=lean * 0.5, life=0.4,
    )  # fmt: skip


def _moving(moment):
    return clamp(abs(moment.speed) / 0.35)


@action("an ordinary walk", "locomotion", speed=1.3, step=0.62)
def walk(moment):
    return blend(stand(moment), _gait(moment, 0.62, 25, 52, 22, 3), _moving(moment))


@action("a brisk, purposeful walk", "locomotion", speed=1.75, step=0.75)
def stride(moment):
    return blend(stand(moment), _gait(moment, 0.75, 30, 55, 30, 6), _moving(moment))


@action("a beaten walk: small steps, head down", "locomotion", speed=0.8, step=0.5)
def trudge(moment):
    pose = _gait(moment, 0.5, 19, 40, 8, 3)
    pose.update(chest_bend=13, head_nod=26)
    return blend(slump(moment), pose, _moving(moment))


@action("a slow careful creep, body low", "locomotion", speed=0.7, step=0.45)
def sneak(moment):
    pose = _gait(moment, 0.45, 24, 50, 6, 14)
    pose.update(chest_bend=16, head_nod=-16, knee=24, elbow=60)
    return pose


@action("parade step with a musket at the shoulder", "locomotion", speed=1.45, step=0.68)
def march(moment):
    pose = _gait(moment, 0.68, 30, 34, 26, 0)
    pose.update(armR_fwd=16, elbowR=100, armR_out=4, chest_twist=0, chest_bend=-3, head_nod=-3)
    aim_hand(pose, pitch=97)
    return blend(shoulder_arms(moment), pose, _moving(moment))


@action("running", "locomotion", speed=3.6, step=0.95)
def run(moment):
    pose = _gait(moment, 0.95, 40, 80, 38, 14)
    pose.update(elbowL=85, elbowR=85)
    return blend(stand(moment), pose, _moving(moment))


@action("running with a bayonet or spear levelled", "locomotion", speed=3.4, step=0.9)
def charge(moment):
    pose = _gait(moment, 0.9, 38, 78, 0, 16)
    pose.update(armR_fwd=-18, armR_out=10, elbowR=72, chest_twist=-18, head_turn=14, head_nod=-10)
    aim_hand(pose, pitch=3 + 3 * math.sin(moment.walked * 4))
    return blend(guard(moment), hold_two_handed(pose, 0.6), _moving(moment))


@action("running with a sword or arm held high, waving the others on", "locomotion", speed=3.4, step=0.9)
def lead_charge(moment):
    pose = _gait(moment, 0.9, 36, 75, 0, 12)
    pose.update(armL_fwd=-25, elbowL=50, armL_out=20, head_nod=-8)
    aim_arm(pose, "R", (0.25, 0.5, 1), elbow=18)
    return aim_hand(pose, pitch=55 + 12 * math.sin(moment.time * 7))


@action("carrying one end of a litter or a long load with another person; walk it with this gait", "locomotion", speed=1.0, step=0.55, prop=Named("prop"), end=(Choice(["front", "rear"], "end"), "front"))
def carry(moment, prop, end="front"):
    pose = blend(make_pose(chest_bend=5), _gait(moment, 0.55, 20, 38, 0, 5), _moving(moment))
    pose.update(chest_bend=6 if end == "front" else 8, head_nod=0 if end == "front" else 8)
    for side, name in (("L", "left"), ("R", "right")):
        handle = moment.local(prop.point(f"handle_{end}_{name}", moment.time))
        grasp(pose, side, handle, pole=(-1 if side == "L" else 1, -0.6 if end == "rear" else 0.6, 0.2))
    return pose


@action("carrying something heavy against the belly; the prop goes where the person goes", "locomotion", speed=1.0, step=0.55, prop=(Named("prop"), None))
def carry_load(moment, prop=None):
    pose = blend(make_pose(), _gait(moment, 0.55, 20, 38, 0, 3), _moving(moment))
    pose.update(chest_bend=-6, grip=0.5)
    reach(pose, "L", (-0.16, 0.3, 1.0))
    return reach(pose, "R", (0.16, 0.3, 1.0))


# ---------------------------------------------------------------- overlays: loops held over a posture
def _from_shoulder(pose, side, target):
    """The direction from a shoulder to a target, in chest space."""
    solved = solve(pose)
    target = AHEAD if target is None else Vector(target)
    return solved.world["chest"].inverted() @ (target - solved.point("arm" + side))


@action("stop gesturing and keep the posture", "pose", overlay=True)
def still(moment, base):
    return dict(base)


@action("pointing at a target and looking at it, held", "loop", overlay=True, target=(Aim(), None), arm=ARM)
def point_at(moment, base, target=None, arm="right"):
    pose, side = dict(base), SIDES[arm]
    target = AHEAD if target is None else Vector(target)
    yaw = _turn_head(pose, target)
    pose["chest_twist"] = pose.get("chest_twist", 0) + yaw * 0.3
    direction = _from_shoulder(pose, side, target)
    aim_arm(pose, side, direction, elbow=6 + 16 * math.exp(-moment.since * 3) * abs(math.sin(moment.since * 9)))
    pitch, turn = _direction_angles(target - REST_POSITION["arm" + side])
    aim_hand(pose, pitch=pitch, yaw=turn, side=side)
    pose["grip" + side] = 0.75
    return pose


@action("speaking with the hands", "loop", overlay=True, energy=(Number(0.2, 2), 1.0))
def talk(moment, base, energy=1.0):
    pose = dict(base)
    beat = moment.since * 3.4 + moment.seed
    pose.update(
        armR_fwd=28 + 14 * energy * math.sin(beat), elbowR=78 + 28 * energy * math.sin(beat * 1.3 + 1), armR_twist=18 + 18 * math.sin(beat * 0.7), armR_out=10,
        armL_fwd=10 + 8 * energy * math.sin(beat * 0.9 + 2), elbowL=38 + 24 * energy * math.sin(beat * 1.1 + 0.5), armL_twist=15,
        head_nod=base.get("head_nod", 0) + 5 * math.sin(beat * 1.7), head_tilt=4 * math.sin(beat * 0.6), chest_bend=base.get("chest_bend", 0) + 4, chest_twist=5 * math.sin(beat * 0.5),
    )  # fmt: skip
    return pose


@action("laying down the law: one arm chopping the air", "loop", overlay=True)
def order(moment, base):
    pose = dict(base)
    chop = moment.since * 5.0
    pose.update(armR_fwd=55 + 18 * math.sin(chop), elbowR=55 - 25 * math.sin(chop), armR_out=8, armR_twist=25, armL_fwd=-10, elbowL=60, armL_out=18, armL_twist=60, chest_bend=base.get("chest_bend", 0) + 6, head_nod=4 * math.sin(chop))
    return pose


@action("arms flung wide, head shaking, objecting", "loop", overlay=True)
def protest(moment, base):
    pose = dict(base)
    shake = moment.since + moment.seed
    pose.update(make_pose(arm_out=38, arm_fwd=38 + 9 * math.sin(shake * 7), elbow=68 + 12 * math.sin(shake * 7 + 1), arm_twist=-40, grip=0.0))
    pose.update(head_turn=16 * math.sin(shake * 9), chest_bend=base.get("chest_bend", 0) - 6)
    return pose


@action("shouting with a fist shaking in the air", "loop", overlay=True, arm=ARM)
def shake_fist(moment, base, arm="right"):
    pose, side = dict(base), SIDES[arm]
    shake = moment.since * 8 + moment.seed
    pose.update({f"arm{side}_fwd": 118 + 14 * math.sin(shake), f"arm{side}_out": 18, "elbow" + side: 62 + 22 * math.sin(shake + 1), "grip" + side: 1.0})
    pose.update(head_nod=-10 + 4 * math.sin(shake * 0.5), chest_bend=base.get("chest_bend", 0) + 6 + 3 * math.sin(shake * 0.5))
    return pose


@action("both arms up, bouncing with joy", "loop", overlay=True)
def cheer(moment, base):
    pose = dict(base)
    bounce = moment.since * 9 + moment.seed
    pose.update(armR_fwd=165 + 10 * math.sin(bounce), armR_out=18, elbowR=20 + 15 * math.sin(bounce), armL_fwd=150 + 12 * math.sin(bounce + 1), armL_out=22, elbowL=25)
    pose.update(chest_bend=base.get("chest_bend", 0) - 8, head_nod=-12, lift=base.get("lift", 0) + 0.03 * max(0, math.sin(bounce)))
    return pose


@action("clapping the hands", "loop", overlay=True)
def clap(moment, base):
    pose = dict(base)
    apart = 0.07 + 0.07 * (0.5 + 0.5 * math.sin(moment.since * 14 + moment.seed))
    pose["grip"] = 0.0
    reach(pose, "L", (-apart, 0.3, 1.25), pole=(-1, -0.3, -0.6))
    return reach(pose, "R", (apart, 0.3, 1.25), pole=(1, -0.3, -0.6))


@action("one arm held high in triumph, with whatever it holds", "loop", overlay=True, arm=ARM)
def raise_high(moment, base, arm="right"):
    pose, side = dict(base), SIDES[arm]
    wave = moment.since * 6 + moment.seed
    pose.update({f"arm{side}_fwd": 160 + 8 * math.sin(wave), f"arm{side}_out": 14, "elbow" + side: 14, f"arm{side}_twist": 0})
    pose.update(chest_bend=base.get("chest_bend", 0) - 6, head_nod=-10)
    return aim_hand(pose, pitch=80 + 10 * math.sin(wave), side=side)


@action("waving a raised hand", "loop", overlay=True, arm=ARM)
def wave(moment, base, arm="right"):
    pose, side = dict(base), SIDES[arm]
    swing = math.sin(moment.since * 7)
    pose.update({f"arm{side}_fwd": 150, f"arm{side}_out": 24 + 16 * swing, "elbow" + side: 30 + 14 * swing, f"arm{side}_twist": 0, "grip" + side: 0.0})
    return pose


@action("a spyglass or other held thing raised to the eye", "pose", overlay=True)
def look_through(moment, base):
    pose = dict(base)
    reach(pose, "R", solve(pose).point("head", (0.07, 0.27, 0.17 + GRIP_DROP)), pole=(1, -0.2, -0.6))
    return aim_hand(pose, pitch=4)


@action("reading what the right hand holds, head bowed over it", "loop", overlay=True)
def read(moment, base):
    pose = dict(base)
    drift = math.sin(moment.since * 1.3)
    reach(pose, "R", (0.1, 0.32, 1.24 + 0.01 * drift), pole=(1, -0.3, -0.7))
    aim_hand(pose, pitch=55, yaw=12 + 6 * drift)
    pose.update(head_nod=24 + 3 * drift, head_turn=-6 + 5 * math.sin(moment.since * 0.9))
    return pose


@action("writing on a desk or table in front", "loop", overlay=True, height=(Number(0.5, 1.3), 0.78))
def write(moment, base, height=0.78):
    pose = dict(base)
    stroke = moment.since * 6
    pose.update(chest_bend=base.get("chest_bend", 0) + 10, head_nod=22, gripR=0.8)
    reach(pose, "L", (-0.22, 0.34, height + GRIP_DROP))
    return reach(pose, "R", (0.14 + 0.05 * math.sin(stroke * 0.31), 0.36 + 0.012 * math.sin(stroke), height + 0.08), pole=(1, -0.4, -0.3))


@action("holding something out with both hands", "pose", overlay=True, height=(Number(0.6, 1.5), 1.15))
def offer(moment, base, height=1.15):
    pose = dict(base)
    pose.update(chest_bend=base.get("chest_bend", 0) + 8, head_nod=6)
    reach(pose, "L", (-0.14, 0.5, height))
    reach(pose, "R", (0.14, 0.5, height))
    return aim_hand(pose, pitch=0, yaw=90)


@action("a hand resting on a target, such as a shoulder or a gun barrel", "pose", overlay=True, target=Aim(), arm=ARM)
def hand_on(moment, base, target, arm="right"):
    pose, side = dict(base), SIDES[arm]
    pose["grip" + side] = 0.3
    return reach(pose, side, Vector(target) + Vector((0, 0, 0.1)))


# ---------------------------------------------------------------- overlays: gestures that play once
def _recoiling():
    return make_pose(chest_bend=-16, head_nod=-14, arm_out=42, arm_fwd=22, elbow=45, kneeL=18, kneeR=28, hips_pitch=-7, root_y=-0.08)


@action("a start backward in shock", "gesture", overlay=True, seconds=1.2)
def recoil(moment, base):
    return _recoiling()


@action("a shrug", "gesture", overlay=True, seconds=1.2)
def shrug(moment, base):
    pose = dict(base)
    pose.update(make_pose(arm_out=30, arm_fwd=25, elbow=85, arm_twist=-50, grip=0.0))
    pose.update(head_tilt=10)
    return pose


@action("nodding", "gesture", overlay=True, seconds=1.0)
def nod(moment, base):
    pose = dict(base)
    pose["head_nod"] = base.get("head_nod", 0) + 20 * (0.5 - 0.5 * math.cos(2 * math.pi * 2 * moment.since))
    return pose


@action("shaking the head", "gesture", overlay=True, seconds=1.3)
def shake_head(moment, base):
    pose = dict(base)
    pose["head_turn"] = base.get("head_turn", 0) + 24 * math.sin(2 * math.pi * 2.2 * moment.since)
    return pose


@action("a bow from the waist", "gesture", overlay=True, seconds=1.5)
def bow(moment, base):
    return make_pose(hips_pitch=20, head_nod=14, arm_out=5, leg_fwd=20, armR_fwd=10, elbowR=70, armR_twist=70)


@action("a military salute, hand to the hat", "gesture", overlay=True, seconds=1.8)
def salute(moment, base):
    pose = dict(base)
    pose.update(chest_bend=-3, head_nod=-3, gripR=0.0)
    return reach(pose, "R", solve(pose).point("head", (0.19, 0.14, 0.25)), pole=(1, -0.15, 0.1))


@action("beckoning someone closer with one arm", "gesture", overlay=True, seconds=1.6, arm=ARM)
def beckon(moment, base, arm="right"):
    pose, side = dict(base), SIDES[arm]
    curl = math.sin(moment.since * 9)
    pose.update({f"arm{side}_fwd": 62, f"arm{side}_out": 12, "elbow" + side: 55 + 35 * curl, f"arm{side}_twist": -60, "grip" + side: 0.3})
    return pose


@action("aim, then the musket kicks on the shot", "gesture", overlay=True, seconds=1.4, sounds=((0.3, "musket"),), pitch=(Number(-30, 45), 0.0))
def fire_musket(moment, base, pitch=0.0):
    pose = aim(moment, pitch)
    kick = pulse(moment.since, 0.3, 0.36, 0.8)
    pose.update(chest_bend=pose["chest_bend"] - 9 * kick, root_y=-0.06 * kick)
    return aim_hand(pose, pitch=pitch + 10 * kick, yaw=6)


@action("a bayonet or spear thrust that lands on the target", "gesture", overlay=True, seconds=1.25, sounds=((0.3, "stab"),), target=(Aim(), None))
def lunge(moment, base, target=None):
    drawn = make_pose(legL_fwd=18, kneeL=25, legR_fwd=-14, kneeR=20, hips_pitch=4, chest_twist=-34, armR_fwd=-40, armR_out=12, elbowR=95, root_y=-0.1)
    aim_hand(drawn, pitch=-7)
    hold_two_handed(drawn, 0.55)
    hit = make_pose(legL_fwd=58, kneeL=62, legR_fwd=-34, kneeR=6, hips_pitch=24, chest_bend=10, chest_twist=-8, armR_fwd=48, armR_out=6, elbowR=14, head_nod=-10, root_y=0.28)
    pitch, yaw = -14.0, 0.0
    if target is not None:
        toward = Vector(target) - solve(hit).grip("R")
        pitch, yaw = _direction_angles(toward)
        hit["root_y"] = clamp(0.28 + (toward.length - moment.reach("R")) * math.cos(math.radians(pitch)), -0.2, 0.75)
        pitch, yaw = _direction_angles(Vector(target) - solve(hit).grip("R"))
    aim_hand(hit, pitch=pitch, yaw=yaw)
    hold_two_handed(hit, 0.6)
    return sequence(moment.since, [(0, guard(moment)), (0.2, drawn), (0.3, hit), (0.62, hit), (1.1, guard(moment))])


@action("a gunner reaches a match to the target, then flinches from the blast", "gesture", overlay=True, seconds=1.7, target=(Aim(), None))
def touch_off(moment, base, target=None):
    pose = make_pose(legL_fwd=16, legR_fwd=-14, kneeL=14, chest_bend=14, hips_pitch=6, armL_fwd=-20, armL_out=20, elbowL=40, head_turn=-10)
    weight = ramp(moment.since, 0, 0.38)
    direction = _from_shoulder(pose, "R", target)
    aim_arm(pose, "R", direction, elbow=10, weight=weight)
    pitch, yaw = _direction_angles((AHEAD if target is None else Vector(target)) - REST_POSITION["armR"])
    aim_hand(pose, pitch=pitch, yaw=yaw, weight=weight)
    return blend(pose, cover_ears(moment), pulse(moment.since, 0.42, 0.55, 1.5))
