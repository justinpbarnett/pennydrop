import type { Limb, Pose } from "./rig";

const HANG: Limb = { a: 4, b: 8 };
const HANG2: Limb = { a: -5, b: 8 };
const STAND_LEG: Limb = { a: 3, b: 3 };
const STAND_LEG2: Limb = { a: -3, b: 1 };
const KNEEL_LEG: Limb = { a: 88, b: 88 };
const KNEEL_LEG2: Limb = { a: 0, b: 98, foot: 58 };

const base = (over: Partial<Pose>): Pose => ({ lean: 0, head: 0, arm: HANG, arm2: HANG2, leg: STAND_LEG, leg2: STAND_LEG2, ...over });

export const POSES = {
  stand: base({}),
  point: base({ lean: 2, head: -4, arm: { a: 98, b: -4 } }),
  raise: base({ head: -6, arm: { a: 168, b: 4 } }),
  cheer: base({ head: -12, arm: { a: 150, b: 12 }, arm2: { a: 142, b: 14 } }),
  salute: base({ arm: { a: 110, b: 105, reach: 0.55 } }),
  bow: base({ lean: 34, head: 14, arm: { a: 2, b: 6 }, arm2: { a: -2, b: 6 } }),
  kneel: base({ lean: 4, head: 6, arm: { a: 30, b: 40 }, arm2: { a: 20, b: 40 }, leg: KNEEL_LEG, leg2: KNEEL_LEG2 }),
  plead: base({ lean: 6, head: -10, arm: { a: 112, b: 10 }, arm2: { a: 100, b: 16 }, leg: KNEEL_LEG, leg2: KNEEL_LEG2 }),
  fall: base({ lean: -86, head: -4, arm: { a: 88, b: 4 }, arm2: { a: 96, b: 6 }, leg: { a: 86, b: 6 }, leg2: { a: 92, b: 2 } }),
  wounded: base({ lean: 18, head: 12, arm: { a: 32, b: 100 }, arm2: { a: 16, b: 24 }, leg: { a: 14, b: 22 }, leg2: { a: -8, b: 6 } }),
  address: base({ lean: -3, head: -6, arm: { a: 122, b: -8 }, arm2: { a: 10, b: 30 } }),
  write: base({ lean: 22, head: 24, arm: { a: 62, b: 24 }, arm2: { a: 42, b: 52 } }),
  read: base({ lean: 4, head: 20, arm: { a: 48, b: 74 }, arm2: { a: 44, b: 80 } }),
  coat: base({ arm: { a: 26, b: 116 }, arm2: { a: -22, b: 44 } }),
  cross: base({ head: -2, arm: { a: 22, b: 120 }, arm2: { a: 24, b: 114 } }),
  despair: base({ lean: 26, head: 32, arm: { a: 72, b: 108 }, arm2: { a: 66, b: 114 } }),
  recoil: base({ lean: -14, head: -10, arm: { a: 122, b: 30 }, arm2: { a: 110, b: 40 }, leg: { a: 18, b: 6 }, leg2: { a: -12, b: 10 } }),
  reach: base({ lean: 8, arm: { a: 78, b: 4 } }),
  hold: base({ arm: { a: 22, b: 68 } }),
  aim: base({ lean: 6, head: 8, arm: { a: 86, b: 10 }, arm2: { a: 70, b: 72 } }),
  wave: base({ head: -4, arm: { a: 150, b: 20 } }),
  fist: base({ head: -8, arm: { a: 160, b: 36 } }),
  push: base({ lean: 20, arm: { a: 86, b: 10 }, arm2: { a: 80, b: 12 }, leg: { a: 22, b: 18 }, leg2: { a: -24, b: 0 } }),
  whisper: base({ lean: 10, head: 10, arm: { a: 52, b: 118 } }),
} as const satisfies Record<string, Pose>;

export type PoseName = keyof typeof POSES;
export const POSE_NAMES = Object.keys(POSES) as PoseName[];

export const isPose = (value: unknown): value is PoseName => typeof value === "string" && Object.hasOwn(POSES, value);

const UPRIGHT: readonly PoseName[] = ["stand", "point", "raise", "cheer", "salute", "address", "coat", "cross", "reach", "hold", "aim", "wave", "fist", "read", "whisper"];
export const isUpright = (pose: PoseName) => UPRIGHT.includes(pose);

const CARRIES: Partial<Record<PoseName, { near: boolean; far: boolean }>> = {
  coat: { near: true, far: true },
  hold: { near: true, far: false },
  cross: { near: true, far: true },
  read: { near: true, far: true },
  wounded: { near: true, far: false },
};

export function walkingPose(pose: PoseName, holding: boolean): { pose: PoseName; swing: { near: boolean; far: boolean } } {
  const carried = CARRIES[pose];
  if (carried) return { pose, swing: { near: !carried.near, far: !carried.far } };
  return holding ? { pose: "hold", swing: { near: false, far: true } } : { pose: "stand", swing: { near: true, far: true } };
}

const TAU = Math.PI * 2;

export function alive(pose: Pose, name: PoseName, clock: number, seed: number): Pose {
  const breath = Math.sin(TAU * 0.24 * clock + seed * TAU);
  const drift = Math.sin(TAU * 0.11 * clock + seed * 17);
  const sway = Math.sin(TAU * 0.17 * clock + seed * 5);
  const lying = name === "fall";
  const next: Pose = {
    ...pose,
    lean: pose.lean + (lying ? 0 : 0.8 * breath),
    head: pose.head + (lying ? 0 : 2.2 * drift),
    arm: { ...pose.arm, a: pose.arm.a + 1.2 * breath },
    arm2: { ...pose.arm2, a: pose.arm2.a + 1.2 * sway },
  };
  const beat = (hz: number) => Math.sin(TAU * hz * clock + seed * TAU);
  switch (name) {
    case "wave":
      return { ...next, arm: { ...next.arm, b: next.arm.b + 24 * beat(1.5) } };
    case "fist":
      return { ...next, arm: { ...next.arm, a: next.arm.a + 7 * beat(2.1), b: next.arm.b + 10 * beat(2.1) } };
    case "cheer": {
      const jump = Math.abs(beat(1.1));
      return { ...next, head: next.head - 4 * jump, arm: { ...next.arm, a: next.arm.a + 10 * jump }, arm2: { ...next.arm2, a: next.arm2.a + 10 * Math.abs(beat(1.1) + 0.3) } };
    }
    case "address":
      return { ...next, arm: { ...next.arm, a: next.arm.a + 7 * beat(0.45), b: next.arm.b + 6 * beat(0.45) } };
    case "push":
      return { ...next, lean: next.lean + 2.5 * beat(0.8) };
    case "despair":
      return { ...next, lean: next.lean + 1.5 * beat(0.6) };
    default:
      return next;
  }
}

export function jittered(pose: Pose, seed: number, amount: number): Pose {
  const j = (k: number) => Math.sin(seed * 97.13 + k * 13.7) * amount;
  return {
    ...pose,
    lean: pose.lean + j(1) * 0.4,
    head: pose.head + j(2),
    arm: { ...pose.arm, a: pose.arm.a + j(3), b: pose.arm.b + j(4) },
    arm2: { ...pose.arm2, a: pose.arm2.a + j(5), b: pose.arm2.b + j(6) },
  };
}
