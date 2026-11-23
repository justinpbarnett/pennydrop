import { clamp01, lerp, type Point } from "../../lab";

export interface Limb {
  a: number;
  b: number;
  reach?: number;
  foot?: number;
}

export interface Pose {
  lean: number;
  head: number;
  arm: Limb;
  arm2: Limb;
  leg: Limb;
  leg2: Limb;
}

export interface Side {
  shoulder: Point;
  elbow: Point;
  wrist: Point;
  hand: Point;
  hip: Point;
  knee: Point;
  ankle: Point;
  heel: Point;
  toe: Point;
}

export interface Skeleton {
  facing: number;
  scale: number;
  lean: number;
  tilt: number;
  pelvis: Point;
  waist: Point;
  chest: Point;
  neck: Point;
  head: Point;
  near: Side;
  far: Side;
}

export type Ground = (x: number) => number;

export const BONE = {
  torso: 150, neck: 16, headRx: 23, headRy: 29,
  upper: 92, fore: 86, hand: 16,
  thigh: 118, shin: 116, foot: 40, heel: 9, ankle: 9,
  shoulderSpread: 26, hipSpread: 14,
} as const;

export const LEG = BONE.thigh + BONE.shin;
export const STANDING_PELVIS = LEG + BONE.ankle;

const RADIANS = Math.PI / 180;
const FOOT_DAMP = 0.5;
const KNEE_CONTACT = 12;
const PELVIS_CONTACT = 26;
const HAND_CONTACT = 8;
const TOE_CONTACT = 7;

export const smooth = (t: number) => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};

export function along(angle: number, facing: number, length: number): Point {
  return { x: facing * Math.sin(angle * RADIANS) * length, y: Math.cos(angle * RADIANS) * length };
}

export function rising(angle: number, facing: number, length: number): Point {
  return { x: facing * Math.sin(angle * RADIANS) * length, y: -Math.cos(angle * RADIANS) * length };
}

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scaled = (p: Point, s: number, origin: Point): Point => ({ x: origin.x + p.x * s, y: origin.y + p.y * s });

export function angleOf(from: Point, to: Point, facing: number): number {
  return Math.atan2(Math.sign(facing || 1) * (to.x - from.x), to.y - from.y) / RADIANS;
}

const autoFoot = (limb: Limb) => 90 + FOOT_DAMP * (limb.a - limb.b);

export function lerpLimb(a: Limb, b: Limb, t: number): Limb {
  const foot = a.foot === undefined && b.foot === undefined ? undefined : lerp(a.foot ?? autoFoot(a), b.foot ?? autoFoot(b), t);
  return { a: lerp(a.a, b.a, t), b: lerp(a.b, b.b, t), reach: lerp(a.reach ?? 1, b.reach ?? 1, t), foot };
}

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    lean: lerp(a.lean, b.lean, t),
    head: lerp(a.head, b.head, t),
    arm: lerpLimb(a.arm, b.arm, t),
    arm2: lerpLimb(a.arm2, b.arm2, t),
    leg: lerpLimb(a.leg, b.leg, t),
    leg2: lerpLimb(a.leg2, b.leg2, t),
  };
}

function lateral(facing: number): number {
  return Math.sign(facing || 1) * (1 - Math.min(1, Math.abs(facing)));
}

interface Upper {
  waist: Point;
  chest: Point;
  neck: Point;
  head: Point;
  near: Pick<Side, "shoulder" | "elbow" | "wrist" | "hand">;
  far: Pick<Side, "shoulder" | "elbow" | "wrist" | "hand">;
}

function arm(shoulder: Point, limb: Limb, facing: number): Pick<Side, "shoulder" | "elbow" | "wrist" | "hand"> {
  const reach = limb.reach ?? 1;
  const elbow = add(shoulder, along(limb.a, facing, BONE.upper * reach));
  const wrist = add(elbow, along(limb.a + limb.b, facing, BONE.fore * reach));
  const hand = add(wrist, along(limb.a + limb.b, facing, BONE.hand * reach));
  return { shoulder, elbow, wrist, hand };
}

function upperBody(pose: Pose, facing: number): Upper {
  const side = lateral(facing);
  const waist = rising(pose.lean, facing, BONE.torso * 0.35);
  const chest = rising(pose.lean, facing, BONE.torso * 0.72);
  const neck = rising(pose.lean, facing, BONE.torso);
  const head = add(add(neck, rising(pose.lean + pose.head * 0.5, facing, BONE.neck)), rising(pose.lean + pose.head, facing, BONE.headRy));
  const shoulderAt = rising(pose.lean, facing, BONE.torso - 14);
  const nearShoulder = { x: shoulderAt.x - side * BONE.shoulderSpread, y: shoulderAt.y };
  const farShoulder = { x: shoulderAt.x + side * BONE.shoulderSpread, y: shoulderAt.y };
  return { waist, chest, neck, head, near: arm(nearShoulder, pose.arm, facing), far: arm(farShoulder, pose.arm2, facing) };
}

function foot(ankle: Point, shinAngle: number, facing: number, flat: number, fixed?: number): Pick<Side, "heel" | "toe"> {
  const angle = fixed ?? lerp(90 + FOOT_DAMP * shinAngle, 90, flat);
  return { heel: add(ankle, along(angle, facing, -BONE.heel)), toe: add(ankle, along(angle, facing, BONE.foot)) };
}

function legFk(hip: Point, limb: Limb, facing: number): Pick<Side, "hip" | "knee" | "ankle" | "heel" | "toe"> {
  const knee = add(hip, along(limb.a, facing, BONE.thigh));
  const shinAngle = limb.a - limb.b;
  const ankle = add(knee, along(shinAngle, facing, BONE.shin));
  return { hip, knee, ankle, ...foot(ankle, shinAngle, facing, 0, limb.foot) };
}

function legIk(hip: Point, target: Point, facing: number, flat: number): Pick<Side, "hip" | "knee" | "ankle" | "heel" | "toe"> {
  const span = Math.min(Math.max(Math.hypot(target.x - hip.x, target.y - hip.y), Math.abs(BONE.thigh - BONE.shin) + 1), LEG * 0.9999);
  const toward = angleOf(hip, target, facing);
  const bend = Math.acos((BONE.thigh ** 2 + span ** 2 - BONE.shin ** 2) / (2 * BONE.thigh * span)) / RADIANS;
  const knee = add(hip, along(toward + bend, facing, BONE.thigh));
  const ankle = add(hip, along(toward, facing, span));
  return { hip, knee, ankle, ...foot(ankle, angleOf(knee, ankle, facing), facing, flat) };
}

function place(relative: Omit<Skeleton, "facing" | "scale" | "lean" | "tilt">, pelvis: Point, scale: number): Omit<Skeleton, "facing" | "scale" | "lean" | "tilt"> {
  const at = (p: Point) => scaled(p, scale, pelvis);
  const sideAt = (s: Side): Side => Object.fromEntries(Object.entries(s).map(([key, p]) => [key, at(p)])) as unknown as Side;
  return {
    pelvis,
    waist: at(relative.waist), chest: at(relative.chest), neck: at(relative.neck), head: at(relative.head),
    near: sideAt(relative.near), far: sideAt(relative.far),
  };
}

function contacts(rel: Omit<Skeleton, "facing" | "scale" | "lean" | "tilt">): { x: number; y: number }[] {
  const side = (s: Side) => [
    { x: s.ankle.x, y: s.ankle.y + BONE.ankle },
    { x: s.heel.x, y: s.heel.y + BONE.ankle },
    { x: s.toe.x, y: s.toe.y + TOE_CONTACT },
    { x: s.knee.x, y: s.knee.y + KNEE_CONTACT },
    { x: s.wrist.x, y: s.wrist.y + HAND_CONTACT },
  ];
  return [...side(rel.near), ...side(rel.far), { x: 0, y: PELVIS_CONTACT }, { x: rel.head.x, y: rel.head.y + BONE.headRy }];
}

export function posed(pose: Pose, x: number, ground: Ground, facing: number, scale: number): Skeleton {
  const upper = upperBody(pose, facing);
  const side = lateral(facing);
  const nearHip = { x: -side * BONE.hipSpread, y: 0 };
  const farHip = { x: side * BONE.hipSpread, y: 0 };
  const relative = {
    pelvis: { x: 0, y: 0 }, waist: upper.waist, chest: upper.chest, neck: upper.neck, head: upper.head,
    near: { ...upper.near, ...legFk(nearHip, pose.leg, facing) },
    far: { ...upper.far, ...legFk(farHip, pose.leg2, facing) },
  };
  const pelvisY = Math.min(...contacts(relative).map((c) => ground(x + c.x * scale) - c.y * scale));
  return { facing, scale, lean: pose.lean, tilt: pose.lean + pose.head, ...place(relative, { x, y: pelvisY }, scale) };
}

export interface Feet {
  near: Point;
  far: Point;
  nearFlat: number;
  farFlat: number;
}

export function striding(pose: Pose, pelvis: Point, feet: Feet, facing: number, scale: number): Skeleton {
  const upper = upperBody(pose, facing);
  const relativeTarget = (p: Point) => ({ x: (p.x - pelvis.x) / scale, y: (p.y - pelvis.y) / scale });
  const relative = {
    pelvis: { x: 0, y: 0 }, waist: upper.waist, chest: upper.chest, neck: upper.neck, head: upper.head,
    near: { ...upper.near, ...legIk({ x: 0, y: 0 }, relativeTarget(feet.near), facing, feet.nearFlat) },
    far: { ...upper.far, ...legIk({ x: 0, y: 0 }, relativeTarget(feet.far), facing, feet.farFlat) },
  };
  return { facing, scale, lean: pose.lean, tilt: pose.lean + pose.head, ...place(relative, pelvis, scale) };
}

export interface Gait {
  stride: number;
  speed: number;
  lift: number;
  lean: number;
  reach: number;
  swing: number;
  elbow: number;
}

export const GAITS = {
  walk: { stride: 190, speed: 384, lift: 26, lean: 4, reach: 0.985, swing: 22, elbow: 10 },
  run: { stride: 300, speed: 900, lift: 70, lean: 14, reach: 0.93, swing: 40, elbow: 85 },
  march: { stride: 170, speed: 330, lift: 34, lean: 0, reach: 0.99, swing: 8, elbow: 2 },
} as const satisfies Record<string, Gait>;

export type GaitName = keyof typeof GAITS;

const RAMP_SECONDS = 0.35;

export function travelSeconds(distance: number, gait: Gait): number {
  const d = Math.abs(distance);
  if (d === 0) return 0;
  const rampDistance = gait.speed * RAMP_SECONDS;
  return d >= rampDistance ? RAMP_SECONDS + d / gait.speed : 2 * Math.sqrt((d * RAMP_SECONDS) / gait.speed);
}

export function travelled(distance: number, gait: Gait, seconds: number): number {
  const d = Math.abs(distance);
  const total = travelSeconds(d, gait);
  if (total === 0) return 0;
  const t = Math.min(Math.max(seconds, 0), total);
  const accel = gait.speed / RAMP_SECONDS;
  const peakTime = Math.min(RAMP_SECONDS, total / 2);
  const peak = accel * peakTime;
  const rampDistance = (peak * peakTime) / 2;
  if (t <= peakTime) return (accel * t * t) / 2;
  const cruise = total - 2 * peakTime;
  if (t <= peakTime + cruise) return rampDistance + peak * (t - peakTime);
  const left = total - t;
  return d - (accel * left * left) / 2;
}

export interface Steps {
  falls: number[];
  stride: number;
}

export function footfalls(distance: number, gait: Gait): Steps {
  const d = Math.abs(distance);
  const count = Math.max(1, Math.round(d / gait.stride));
  const stride = d / count;
  const falls = [0, 0, ...Array.from({ length: count }, (_, i) => (i + 0.5) * stride), d, d];
  return { falls, stride };
}

export interface StepSample {
  near: number;
  far: number;
  nearLift: number;
  farLift: number;
  nearFrom: number;
  nearTo: number;
  farFrom: number;
  farTo: number;
  nearSwing: number;
  farSwing: number;
}

export function stepAt(steps: Steps, covered: number, gait: Gait): StepSample {
  const { falls, stride } = steps;
  const sample = { near: 0, far: 0, nearLift: 0, farLift: 0, nearFrom: 0, nearTo: 0, farFrom: 0, farTo: 0, nearSwing: 0, farSwing: 0 };
  sample.near = falls[0]!;
  sample.far = falls[1]!;
  for (let i = 2; i < falls.length; i++) {
    const from = falls[i - 2]!;
    const to = falls[i]!;
    const start = (falls[i - 2]! + falls[i - 1]!) / 2;
    const end = (falls[i - 1]! + to) / 2;
    const near = i % 2 === 0;
    if (covered >= end) {
      if (near) sample.near = to;
      else sample.far = to;
      continue;
    }
    if (covered > start && end > start) {
      const u = (covered - start) / (end - start);
      const at = lerp(from, to, smooth(u));
      const lift = gait.lift * Math.sin(Math.PI * u) * Math.min(1, (to - from) / (2 * stride || 1));
      if (near) Object.assign(sample, { near: at, nearLift: lift, nearFrom: from, nearTo: to, nearSwing: u });
      else Object.assign(sample, { far: at, farLift: lift, farFrom: from, farTo: to, farSwing: u });
    }
    break;
  }
  return sample;
}

export interface Walk {
  base: Pose;
  start: number;
  facing: number;
  distance: number;
  covered: number;
  gait: Gait;
  ground: Ground;
  scale: number;
  freeArms: { near: boolean; far: boolean };
}

export function walking(walk: Walk): Skeleton {
  const { base, start, facing, distance, covered, gait, ground, scale } = walk;
  const steps = footfalls(distance, gait);
  const step = stepAt(steps, covered, gait);
  const ramp = smooth(Math.min(covered, Math.abs(distance) - covered) / (steps.stride / 2));
  const reach = lerp(LEG, LEG * gait.reach, ramp) * scale;
  const ankle = BONE.ankle * scale;
  const worldX = (d: number) => start + facing * d;
  const pelvisX = worldX(covered);
  const target = (at: number, lift: number, from: number, to: number, swing: number): Point => {
    if (lift === 0 && swing === 0) return { x: worldX(at), y: ground(worldX(at)) - ankle };
    const low = ground(worldX(from));
    const high = ground(worldX(to));
    const climb = Math.abs(low - high) * 0.6;
    return { x: worldX(at), y: lerp(low, high, smooth(swing)) - ankle - (lift + climb * Math.sin(Math.PI * swing)) * scale };
  };
  const near = target(step.near, step.nearLift, step.nearFrom, step.nearTo, step.nearSwing);
  const far = target(step.far, step.farLift, step.farFrom, step.farTo, step.farSwing);
  const support = (foot: Point, swing: number, from: number, to: number) => {
    const floor = swing > 0 ? lerp(ground(worldX(from)), ground(worldX(to)), smooth(swing)) - ankle : foot.y;
    const dx = Math.min(Math.abs(foot.x - pelvisX), reach * 0.999);
    return floor - Math.sqrt(reach * reach - dx * dx);
  };
  const pelvisY = Math.max(support(near, step.nearSwing, step.nearFrom, step.nearTo), support(far, step.farSwing, step.farFrom, step.farTo));
  const half = steps.stride / 2 || 1;
  const swingOf = (footX: number) => -gait.swing * Math.max(-1.2, Math.min(1.2, (facing * (footX - pelvisX)) / (half * scale))) * ramp;
  const arm = (limb: Limb, free: boolean, footX: number): Limb => {
    if (!free) return limb;
    const a = swingOf(footX);
    return { a: lerp(limb.a, a, ramp), b: lerp(limb.b, gait.elbow + Math.max(0, a) * 0.6, ramp), reach: limb.reach };
  };
  const pose: Pose = {
    ...base,
    lean: base.lean + gait.lean * ramp,
    arm: arm(base.arm, walk.freeArms.near, near.x),
    arm2: arm(base.arm2, walk.freeArms.far, far.x),
  };
  const flat = (swing: number) => 1 - Math.sin(Math.PI * swing);
  return striding(pose, { x: pelvisX, y: pelvisY }, { near, far, nearFlat: flat(step.nearSwing), farFlat: flat(step.farSwing) }, facing, scale);
}
