import type { Drawable, Layer, Paint, Point } from "../../lab";
import { along, angleOf, BONE, type Ground, rising, type Side, type Skeleton } from "./rig";

export type Dress = "coat" | "longcoat" | "jacket" | "robe" | "gown";
export type Hat = "bicorne" | "shako" | "bearskin" | "plumed" | "tricorne" | "cap" | "round" | "bonnet" | "none";
export const ITEMS = ["orb", "letter", "scroll", "newspaper", "sword", "flag", "musket", "crown", "quill"] as const;
export type Item = (typeof ITEMS)[number];

export interface Costume {
  dress: Dress;
  hat: Hat;
  hatScale: number;
  sash: boolean;
  epaulettes: boolean;
}

export const COSTUMES = {
  general: { dress: "coat", hat: "bicorne", hatScale: 1.15, sash: false, epaulettes: true },
  officer: { dress: "coat", hat: "bicorne", hatScale: 0.92, sash: false, epaulettes: true },
  cadet: { dress: "jacket", hat: "bicorne", hatScale: 0.8, sash: false, epaulettes: false },
  soldier: { dress: "jacket", hat: "shako", hatScale: 1, sash: false, epaulettes: false },
  grenadier: { dress: "longcoat", hat: "bearskin", hatScale: 1, sash: false, epaulettes: false },
  deputy: { dress: "robe", hat: "plumed", hatScale: 1, sash: true, epaulettes: false },
  statesman: { dress: "longcoat", hat: "round", hatScale: 1, sash: true, epaulettes: false },
  citizen: { dress: "jacket", hat: "cap", hatScale: 1, sash: false, epaulettes: false },
  townsman: { dress: "longcoat", hat: "tricorne", hatScale: 1, sash: false, epaulettes: false },
  woman: { dress: "gown", hat: "bonnet", hatScale: 1, sash: false, epaulettes: false },
} as const satisfies Record<string, Costume>;
export type CostumeName = keyof typeof COSTUMES;

export interface Look {
  line: Paint;
  fill: Paint;
  detail: Paint;
  trim: Paint;
  width: number;
  opacity: number;
}

const DETAIL_WIDTH = 2.6;

type Shape = number[];

const ARC_POINTS = 7;

function circle(c: Point, r: number, n = 18): Shape {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [c.x + r * Math.cos(t), c.y + r * Math.sin(t)];
  }).flat();
}

function ellipse(c: Point, rx: number, ry: number, degrees: number, n = 22): Shape {
  const turn = (degrees * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    return [c.x + x * cos - y * sin, c.y + x * sin + y * cos];
  }).flat();
}

export function capsule(a: Point, ra: number, b: Point, rb: number): Shape {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(ra - rb) + 0.01) return circle(ra >= rb ? a : b, Math.max(ra, rb));
  const theta = Math.atan2(dy, dx);
  const phi = Math.acos((ra - rb) / d);
  const points: number[] = [];
  for (let i = 0; i <= ARC_POINTS; i++) {
    const t = theta - phi + (2 * phi * i) / ARC_POINTS;
    points.push(b.x + rb * Math.cos(t), b.y + rb * Math.sin(t));
  }
  for (let i = 0; i <= ARC_POINTS; i++) {
    const t = theta + phi + ((2 * Math.PI - 2 * phi) * i) / ARC_POINTS;
    points.push(a.x + ra * Math.cos(t), a.y + ra * Math.sin(t));
  }
  return points;
}

interface Detail {
  points: number[];
  closed?: boolean;
  paint?: Paint;
  width?: number;
  fill?: Paint;
}

export class Ink {
  readonly drawables: Drawable[] = [];
  private readonly layer: Layer;

  constructor(private readonly prefix: string, private readonly z: number, opacity: number) {
    this.layer = { id: prefix, opacity };
  }

  group(name: string, shapes: Shape[], look: Look, details: Detail[] = [], opacity = 1): void {
    const base = { kind: "path" as const, x: 0, y: 0, closed: true, opacity, z: this.z, layer: this.layer };
    shapes.forEach((points, i) => this.drawables.push({ ...base, id: `${this.prefix}.${name}.s${i}`, points, fill: "none", stroke: look.line, strokeWidth: look.width * 2 }));
    shapes.forEach((points, i) => this.drawables.push({ ...base, id: `${this.prefix}.${name}.f${i}`, points, fill: look.fill, stroke: "none" }));
    details.forEach((detail, i) => this.drawables.push({
      ...base,
      id: `${this.prefix}.${name}.d${i}`,
      points: detail.points,
      closed: detail.closed ?? false,
      fill: detail.fill ?? "none",
      stroke: detail.paint ?? look.detail,
      strokeWidth: detail.width ?? DETAIL_WIDTH,
    }));
  }

  add(drawable: Omit<Drawable, "id" | "z"> & { name: string }): void {
    const { name, ...rest } = drawable;
    this.drawables.push({ ...rest, id: `${this.prefix}.${name}`, z: this.z, layer: this.layer });
  }
}

const flat = (points: Point[]) => points.flatMap((p) => [p.x, p.y]);
const mid = (a: Point, b: Point, t = 0.5): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const offset = (p: Point, d: Point): Point => ({ x: p.x + d.x, y: p.y + d.y });

interface Frame {
  at(u: number, v: number): Point;
}

const MIN_WIDTH = 0.32;

function widthOf(facing: number): number {
  return Math.sign(facing || 1) * Math.max(MIN_WIDTH, Math.abs(facing));
}

function frameAt(origin: Point, tilt: number, facing: number, scale: number): Frame {
  const f = widthOf(facing);
  const up = rising(tilt, f, scale);
  const forward = rising(tilt + 90, f, scale);
  return { at: (u, v) => ({ x: origin.x + forward.x * u + up.x * v, y: origin.y + forward.y * u + up.y * v }) };
}

const headFrame = (sk: Skeleton) => frameAt(sk.head, sk.tilt, sk.facing, sk.scale);
const torsoFrame = (sk: Skeleton) => frameAt(sk.pelvis, sk.lean, sk.facing, sk.scale);

function armShapes(side: Side, s: number, wide: boolean): Shape[] {
  const sleeve = wide ? 1.35 : 1;
  return [
    capsule(side.shoulder, 11 * s * sleeve, side.elbow, 9 * s * sleeve),
    capsule(side.elbow, 9 * s * sleeve, side.wrist, (wide ? 10 : 7) * s),
    capsule(side.wrist, 7 * s, side.hand, 6.5 * s),
  ];
}

function legShapes(side: Side, s: number): Shape[] {
  return [
    capsule(side.hip, 17 * s, side.knee, 12 * s),
    capsule(side.knee, 12 * s, side.ankle, 8 * s),
    capsule(side.heel, 8 * s, side.toe, 6.5 * s),
  ];
}

function torsoShapes(sk: Skeleton, s: number, build: number): Shape[] {
  const shoulders = mid(sk.chest, sk.neck, 0.7);
  return [
    capsule(sk.pelvis, 24 * s * build, sk.waist, 21 * s * build),
    capsule(sk.waist, 21 * s * build, sk.chest, 26 * s * build),
    capsule(sk.chest, 26 * s * build, shoulders, 21 * s * build),
    capsule(shoulders, 12 * s, mid(sk.neck, sk.head, 0.45), 9 * s),
  ];
}

interface Skirt {
  length: number;
  flare: number;
  back: number;
  split: number;
  swing: number;
}

const SKIRTS: Partial<Record<Dress, Skirt>> = {
  longcoat: { length: 0.62, flare: 16, back: 10, split: 1, swing: 26 },
  robe: { length: 0.97, flare: 26, back: 20, split: 0.5, swing: 20 },
  gown: { length: 1.0, flare: 34, back: 30, split: 0.15, swing: 16 },
};

function alongLeg(side: Side, distance: number): Point {
  const thigh = Math.hypot(side.knee.x - side.hip.x, side.knee.y - side.hip.y);
  if (distance <= thigh) return mid(side.hip, side.knee, distance / (thigh || 1));
  const shin = Math.hypot(side.ankle.x - side.knee.x, side.ankle.y - side.knee.y);
  return mid(side.knee, side.ankle, Math.min(1, (distance - thigh) / (shin || 1)));
}

function hanging(side: Side, distance: number, swing: number): Point {
  const p = alongLeg(side, distance);
  const reach = Math.hypot(p.x - side.hip.x, p.y - side.hip.y);
  const limit = (swing * Math.PI) / 180;
  const angle = Math.max(-limit, Math.min(limit, Math.atan2(p.x - side.hip.x, p.y - side.hip.y)));
  return { x: side.hip.x + reach * Math.sin(angle), y: side.hip.y + reach * Math.cos(angle) };
}

const SKIRT_BODY = 20;

function skirtShape(sk: Skeleton, skirt: Skirt, ground: Ground): Shape {
  const s = sk.scale;
  const f = Math.sign(sk.facing || 1);
  const width = Math.max(0.3, Math.abs(sk.facing));
  const length = skirt.length * (BONE.thigh + BONE.shin) * s;
  const [front, back] = [hanging(sk.near, length, skirt.swing), hanging(sk.far, length, skirt.swing)].sort((a, b) => f * (b.x - a.x));
  const onFloor = (p: Point) => ({ x: p.x, y: Math.min(p.y, ground(p.x) - 4 * s) });
  const frontHem = onFloor({ x: front!.x + f * (SKIRT_BODY + skirt.flare) * s * width, y: front!.y });
  const backHem = onFloor({ x: back!.x - f * (SKIRT_BODY + skirt.flare + skirt.back) * s * width, y: back!.y });
  const parted = Math.min(0.7 * length, skirt.split * Math.max(0, Math.abs(front!.x - back!.x) - 12 * s));
  const middle = onFloor({ x: (front!.x + back!.x) / 2, y: Math.max(frontHem.y, backHem.y) + 6 * s - parted });
  const torso = torsoFrame(sk);
  return flat([torso.at(22, 40), torso.at(26, 4), frontHem, middle, backHem, torso.at(-30, 4), torso.at(-24, 40)]);
}

function tailsShape(sk: Skeleton): Shape {
  const s = sk.scale;
  const f = Math.sign(sk.facing || 1);
  const width = Math.max(0.3, Math.abs(sk.facing));
  const torso = torsoFrame(sk);
  const top = torso.at(-22, 26);
  const hang = (angleOf(sk.near.hip, sk.near.knee, f) + angleOf(sk.far.hip, sk.far.knee, f)) / 2;
  const back = Math.max(-44 * s, Math.min(...[sk.near.knee, sk.far.knee].map((k) => f * (k.x - sk.pelvis.x))) - 18 * s);
  const low = offset(sk.pelvis, along(hang, f, 0.5 * (BONE.thigh + BONE.shin) * s));
  const tip = { x: low.x + f * (back - 6 * s) * width * 0.6, y: low.y };
  return flat([torso.at(6, 30), top, { x: tip.x - f * 10 * s * width, y: tip.y - 4 * s }, { x: tip.x + f * 14 * s * width, y: tip.y + 2 * s }, torso.at(4, 0)]);
}

const framed = (frame: Frame, pairs: [number, number][], size = 1) => flat(pairs.map(([u, v]) => frame.at(u * size, v * size)));

function hatShape(hat: Hat, frame: Frame, size: number, trim: Paint): { shapes: Shape[]; details: Detail[] } {
  const p = (u: number, v: number) => frame.at(u * size, v * size);
  const poly = (pairs: [number, number][]) => framed(frame, pairs, size);
  switch (hat) {
    case "bicorne":
      return {
        shapes: [poly([[-54, 8], [-50, 24], [-38, 40], [-18, 50], [4, 52], [24, 47], [42, 34], [52, 18], [56, 6], [30, 15], [0, 18], [-30, 15]])],
        details: [],
      };
    case "shako":
      return {
        shapes: [poly([[-21, 18], [-25, 74], [25, 78], [21, 18]]), poly([[14, 18], [44, 12], [40, 22], [14, 26]])],
        details: [{ points: flat(circlePoints(p(8, 88), 8 * size)), closed: true, fill: trim, paint: trim }],
      };
    case "bearskin":
      return {
        shapes: [poly([[-31, -4], [-38, 30], [-40, 68], [-32, 100], [-12, 118], [10, 120], [30, 106], [38, 76], [36, 40], [30, 14], [22, 8], [-2, 2]])],
        details: [{ points: poly([[-30, 40], [-36, 76], [-28, 104]]), paint: trim, width: 6 }],
      };
    case "plumed":
      return {
        shapes: [
          poly([[-36, 18], [-20, 22], [-18, 46], [18, 50], [20, 22], [36, 18], [20, 14], [-20, 14]]),
        ],
        details: [{ points: poly([[2, 46], [16, 48], [26, 70], [30, 96], [16, 84], [4, 66]]), closed: true, fill: trim, paint: trim, width: 2 }],
      };
    case "tricorne":
      return { shapes: [poly([[-44, 12], [-16, 40], [4, 44], [40, 16], [0, 22]])], details: [] };
    case "cap":
      return { shapes: [poly([[-25, 8], [-27, 34], [-14, 52], [10, 58], [30, 52], [42, 36], [36, 26], [25, 22], [25, 8]])], details: [] };
    case "round":
      return { shapes: [poly([[-40, 16], [-20, 18], [-18, 62], [18, 64], [20, 18], [40, 16], [20, 12], [-20, 12]])], details: [] };
    case "bonnet":
      return { shapes: [poly([[-34, 6], [-30, 30], [-8, 42], [18, 36], [26, 18], [8, 22], [-14, 16]])], details: [] };
    case "none":
      return { shapes: [], details: [] };
  }
}

function circlePoints(c: Point, r: number, n = 12): Point[] {
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) }));
}

export interface Holding {
  item: Item;
  at?: Point;
  angle?: number;
  glow?: number;
  fade?: number;
}

export interface Figure {
  id: string;
  skeleton: Skeleton;
  costume: Costume;
  look: Look;
  holding?: Holding;
  ground: Ground;
  clock: number;
}

export function drawFigure(figure: Figure, z: number): Drawable[] {
  const { skeleton: sk, costume, look, ground } = figure;
  const s = sk.scale;
  const ink = new Ink(figure.id, z, look.opacity);
  const wide = costume.dress === "robe" || costume.dress === "gown";

  ink.group("arm2", armShapes(sk.far, s, wide), look);
  ink.group("leg2", legShapes(sk.far, s), look);
  if (costume.dress === "coat") ink.group("tails", [tailsShape(sk)], look);
  ink.group("leg", legShapes(sk.near, s), look);

  const body: Shape[] = torsoShapes(sk, s, costume.dress === "jacket" ? 1.04 : 1);
  const skirt = SKIRTS[costume.dress];
  if (skirt) body.push(skirtShape(sk, skirt, ground));
  const torso = torsoFrame(sk);
  const details: Detail[] = [];
  if (costume.dress === "coat" || costume.dress === "longcoat" || costume.dress === "jacket") {
    details.push({ points: flat([torso.at(16, BONE.torso - 18), torso.at(22, BONE.torso * 0.55), torso.at(24, 8)]) });
  }
  if (costume.sash) details.push({ points: flat([torso.at(-24, 22), torso.at(25, 28)]), paint: look.trim, width: 7 });
  ink.group("body", body, look, details);

  const head = headFrame(sk);
  const hat = hatShape(costume.hat, head, costume.hatScale, look.trim);
  const nose = framed(head, [[BONE.headRx - 6, 10], [BONE.headRx + 9, -4], [BONE.headRx - 4, -8]]);
  ink.group("head", [ellipse(sk.head, BONE.headRx * s * Math.max(0.82, Math.abs(sk.facing)), BONE.headRy * s, sk.tilt * Math.sign(sk.facing || 1)), nose], look);
  ink.group("hat", hat.shapes, look, hat.details);

  const nearArm = armShapes(sk.near, s, wide);
  if (costume.epaulettes) nearArm.push(ellipse(offset(sk.near.shoulder, { x: 0, y: -5 * s }), 18 * s * Math.max(0.6, Math.abs(sk.facing)), 9 * s, sk.lean * Math.sign(sk.facing || 1)));
  ink.group("arm", nearArm, look);
  if (figure.holding) drawItem(ink, figure.holding, sk, look, figure.clock);
  return ink.drawables;
}

function drawItem(ink: Ink, holding: Holding, sk: Skeleton, look: Look, clock: number): void {
  const s = sk.scale;
  const f = Math.sign(sk.facing || 1);
  const hand = holding.at ?? sk.near.hand;
  const forearm = angleOf(sk.near.wrist, sk.near.hand, f);
  const angle = holding.angle ?? forearm;
  const opacity = holding.fade ?? 1;
  const itemLook = { ...look, fill: look.trim };
  switch (holding.item) {
    case "orb": {
      const glow = holding.glow ?? 1;
      [46, 32].forEach((r, i) => ink.add({ name: `orb.halo${i}`, kind: "circle", x: hand.x, y: hand.y, r: r * s, fill: "highlight", stroke: "none", opacity: opacity * glow * (i === 0 ? 0.1 : 0.2) }));
      ink.add({ name: "orb.core", kind: "circle", x: hand.x, y: hand.y, r: 17 * s, fill: "highlight", stroke: "ink", strokeWidth: 2, opacity });
      return;
    }
    case "letter":
    case "newspaper": {
      const w = (holding.item === "letter" ? 34 : 54) * s;
      const h = (holding.item === "letter" ? 24 : 40) * s;
      const c = offset(hand, { x: f * 6 * s, y: -h * 0.3 });
      ink.group("item", [flat([{ x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }, { x: c.x - w / 2, y: c.y + h / 2 }])], itemLook, holding.item === "newspaper"
        ? [0.25, 0.5, 0.75].map((t) => ({ points: [c.x - w * 0.38, c.y - h / 2 + h * t, c.x + w * 0.38, c.y - h / 2 + h * t], width: 2 }))
        : [{ points: [c.x - w / 2, c.y - h / 2, c.x, c.y + h * 0.05, c.x + w / 2, c.y - h / 2], width: 2 }], opacity);
      return;
    }
    case "scroll": {
      const top = offset(hand, { x: 0, y: -34 * s });
      const bottom = offset(hand, { x: 0, y: 30 * s });
      ink.group("item", [capsule(top, 7 * s, offset(top, { x: f * 30 * s, y: 0 }), 7 * s), flat([offset(top, { x: f * 2 * s, y: 0 }), offset(top, { x: f * 28 * s, y: 0 }), offset(bottom, { x: f * 28 * s, y: 0 }), offset(bottom, { x: f * 2 * s, y: 0 })])], itemLook,
        [0.3, 0.5, 0.7].map((t) => ({ points: [hand.x + f * 7 * s, top.y + (bottom.y - top.y) * t, hand.x + f * 23 * s, top.y + (bottom.y - top.y) * t], width: 2 })), opacity);
      return;
    }
    case "quill": {
      const tip = offset(hand, along(angle + 160, f, 10 * s));
      const end = offset(hand, along(angle - 30, f, 60 * s));
      ink.group("item", [capsule(tip, 2 * s, end, 6 * s)], itemLook, [], opacity);
      return;
    }
    case "sword": {
      const blade = holding.angle ?? (forearm + 0);
      const tip = offset(hand, along(blade, f, 150 * s));
      ink.group("item", [capsule(hand, 4 * s, tip, 2 * s), capsule(offset(hand, along(blade + 90, f, 16 * s)), 3 * s, offset(hand, along(blade - 90, f, 16 * s)), 3 * s)], itemLook, [], opacity);
      return;
    }
    case "musket": {
      const base = offset(hand, { x: 0, y: 70 * s });
      const muzzle = offset(hand, along(holding.angle ?? 178, f, 190 * s));
      ink.group("item", [capsule(base, 7 * s, muzzle, 3 * s)], itemLook, [{ points: [muzzle.x, muzzle.y, muzzle.x + f * 2 * s, muzzle.y - 26 * s], width: 2.6 }], opacity);
      return;
    }
    case "flag": {
      const pole = holding.angle ?? 176;
      const foot = offset(hand, along(pole, f, -60 * s));
      const top = offset(hand, along(pole, f, 230 * s));
      const cloth: Point[] = [];
      const length = 130 * s;
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        cloth.push({ x: top.x + f * length * t, y: top.y + 6 * s + Math.sin(clock * 5 + t * 5) * 10 * s * t });
      }
      for (let i = 8; i >= 0; i--) {
        const t = i / 8;
        cloth.push({ x: top.x + f * length * t, y: top.y + 80 * s + Math.sin(clock * 5 + t * 5 + 0.6) * 10 * s * t });
      }
      ink.group("item", [capsule(foot, 4 * s, top, 3.5 * s)], itemLook, [], opacity);
      ink.group("cloth", [flat(cloth)], itemLook, [], opacity);
      return;
    }
    case "crown": {
      const c = offset(hand, { x: f * 4 * s, y: -26 * s });
      const w = 40 * s;
      const h = 30 * s;
      ink.group("item", [flat([{ x: c.x - w / 2, y: c.y + h / 2 }, { x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x - w / 4, y: c.y }, { x: c.x, y: c.y - h / 2 }, { x: c.x + w / 4, y: c.y }, { x: c.x + w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }])], itemLook, [], opacity);
      return;
    }
  }
}
