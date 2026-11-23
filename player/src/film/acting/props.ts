import type { Credit, Drawable, Point } from "../../lab";
import { Ink, type Look } from "./body";
import ICONS from "./prop-icons.json";
import { PROP_TABLE, type PropName, type PropSpec } from "./prop-table";
import { BONE, STANDING_PELVIS } from "./rig";

export type { PropName } from "./prop-table";

export interface PropPlace {
  name: PropName;
  x: number;
  base: number;
  ground: number;
  facing: 1 | -1;
  scale: number;
}

export interface FireMoment {
  progress: number;
  target: Point | null;
}

interface Icon {
  d: string;
  backing: number[];
  fill?: string;
  box: number[];
}

const PROP_Z = 2;
const FIGURE_METERS = 1.75;
const METER = (STANDING_PELVIS + BONE.torso + BONE.neck + 2 * BONE.headRy) / FIGURE_METERS;
const RECOIL = { share: 0.45, reach: 0.05 } as const;
const BOB = { lift: 0.012, tilt: 1.2, draft: 0.06 } as const;
const SWAY_DEGREES = 2.4;
const GLOW = { reach: 0.45, pad: 110 } as const;

const specOf = (name: PropName): PropSpec => PROP_TABLE[name];
const iconOf = (name: PropName): Icon => ICONS.icons[specOf(name).icon as keyof typeof ICONS.icons];
const backings = new Map<string, string>();

function backingOf(icon: Icon): string {
  const known = backings.get(icon.d);
  if (known !== undefined) return known;
  const backing = icon.d.split(/(?=M)/).filter((_, i) => icon.backing.includes(i)).join("");
  backings.set(icon.d, backing);
  return backing;
}

export const PROP_NAMES = Object.keys(PROP_TABLE) as PropName[];
export const GUNS = PROP_NAMES.filter((name) => specOf(name).effect === "gun");
export const BOATS = PROP_NAMES.filter((name) => specOf(name).effect === "boat");
export const SURFACES = PROP_NAMES.filter((name) => specOf(name).surface);

export function propSize(name: PropName, scale: number): { w: number; h: number } {
  const [, , w, h] = iconOf(name).box as [number, number, number, number];
  const height = specOf(name).meters * METER * scale;
  return { w: (height * w) / h, h: height };
}

const mirrored = (place: PropPlace) => {
  const faces = specOf(place.name).faces;
  return faces !== undefined && faces !== place.facing;
};

function spotOf(place: PropPlace, center: Point): Point | null {
  const spot = specOf(place.name).spot;
  if (!spot) return null;
  const { w, h } = propSize(place.name, place.scale);
  const u = mirrored(place) ? 1 - spot[0] : spot[0];
  return { x: center.x + (u - 0.5) * w, y: center.y + (spot[1] - 0.5) * h };
}

export function muzzleOf(place: PropPlace): Point | null {
  if (specOf(place.name).effect !== "gun") return null;
  return spotOf(place, { x: place.x, y: place.base - propSize(place.name, place.scale).h / 2 });
}

export function propCredit(names: Iterable<PropName>): Credit | null {
  const authors = [...new Set([...names].map((name) => specOf(name).by))];
  return authors.length ? { what: "Icons", authors, source: "game-icons.net", license: ICONS.source.license } : null;
}

function seedOf(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) % 1000;
  return (hash / 1000) * Math.PI * 2;
}

interface Pose {
  center: Point;
  rotation: number;
}

function poseOf(place: PropPlace, clock: number, fire: FireMoment | null, seed: number): Pose {
  const spec = specOf(place.name);
  const { w, h } = propSize(place.name, place.scale);
  const center = { x: place.x, y: place.base - h / 2 };
  switch (spec.effect) {
    case "gun": {
      const kick = fire && fire.progress < RECOIL.share ? Math.sin((Math.PI * fire.progress) / RECOIL.share) : 0;
      return { center: { x: center.x - place.facing * RECOIL.reach * w * kick, y: center.y }, rotation: 0 };
    }
    case "boat":
      return { center: { x: center.x, y: center.y + h * (BOB.draft + BOB.lift * Math.sin(clock * 1.3 + seed)) }, rotation: BOB.tilt * Math.sin(clock * 0.9 + seed * 2) };
    case "sway": {
      const degrees = (SWAY_DEGREES / Math.sqrt(spec.meters)) * (Math.sin(clock * 0.8 + seed) + 0.35 * Math.sin(clock * 1.9 + seed * 3)) / 1.35;
      const turn = (degrees * Math.PI) / 180;
      return { center: { x: place.x + (h / 2) * Math.sin(turn), y: place.base - (h / 2) * Math.cos(turn) }, rotation: degrees };
    }
    default:
      return { center, rotation: 0 };
  }
}

export function drawProp(id: string, place: PropPlace, look: Look, clock: number, fire: FireMoment | null): Drawable[] {
  const spec = specOf(place.name);
  const icon = iconOf(place.name);
  const { w, h } = propSize(place.name, place.scale);
  const [x, y, cropW, cropH] = icon.box as [number, number, number, number];
  const pose = poseOf(place, clock, fire, seedOf(id));
  const ink = new Ink(id, PROP_Z, look.opacity);
  const placed = { kind: "silhouette" as const, x: pose.center.x, y: pose.center.y, w, h, crop: { x, y, w: cropW, h: cropH }, mirror: mirrored(place), rotation: pose.rotation };
  const backing = { ...placed, fill: look.line, stroke: look.line, strokeWidth: look.width * 2 };
  if (icon.fill) ink.add({ ...backing, name: "fill", d: icon.fill });
  const flame = spec.effect === "flame" ? spotOf(place, pose.center) : null;
  if (flame) {
    const flicker = (Math.sin(clock * 9 + seedOf(id)) + 0.6 * Math.sin(clock * 13.7)) / 1.6;
    const r = (GLOW.reach * Math.max(w, h) + GLOW.pad) * (1 + 0.04 * Math.sin(clock * 7.3));
    const clip = { x: flame.x - r, y: flame.y - r, w: 2 * r, h: Math.max(0, Math.min(2 * r, place.ground - (flame.y - r))) };
    ink.add({ name: "glow", kind: "circle", soft: true, clip, x: flame.x, y: flame.y, r, fill: "highlight", stroke: "none", opacity: 0.34 + 0.06 * flicker });
    ink.add({ name: "core", kind: "circle", soft: true, clip, x: flame.x, y: flame.y, r: r * 0.45, fill: "highlight", stroke: "none", opacity: 0.26 + 0.08 * flicker });
  }
  ink.add({ ...backing, name: "back", d: backingOf(icon) });
  ink.add({ ...placed, name: "face", d: icon.d, fill: look.fill, stroke: "none", strokeWidth: 0 });
  const muzzle = fire && spec.effect === "gun" ? spotOf(place, pose.center) : null;
  return muzzle && fire ? [...ink.drawables, ...drawShot(id, muzzle, place.facing, fire, clock, look.opacity)] : ink.drawables;
}

const SHOT = { flash: [0.06, 0.24], flight: [0.1, 0.5], burst: [0.5, 0.95] } as const;
const span = (t: number, [from, to]: readonly [number, number]) => Math.min(1, Math.max(0, (t - from) / (to - from)));

function drawShot(id: string, muzzle: Point, f: number, fire: FireMoment, clock: number, opacity: number): Drawable[] {
  const t = fire.progress;
  const target = fire.target ?? { x: muzzle.x + f * 1800, y: muzzle.y + 120 };
  const rise = Math.max(60, Math.abs(target.x - muzzle.x) * 0.16);
  const path = (u: number): Point => ({ x: muzzle.x + (target.x - muzzle.x) * u, y: muzzle.y + (target.y - muzzle.y) * u - 4 * rise * u * (1 - u) });
  const out: Drawable[] = [];

  const smoke = new Ink(`${id}.smoke`, 4, opacity * 0.3 * (1 - span(t, [0.3, 1])));
  const puff = span(t, [0.08, 0.7]);
  if (t > 0.08) {
    for (let i = 0; i < 4; i++) {
      const center = { x: muzzle.x + f * (30 + 70 * puff + i * 24), y: muzzle.y - 30 * puff - i * 10 + Math.sin(clock * 1.3 + i) * 3 };
      smoke.add({ name: `puff${i}`, kind: "path", x: 0, y: 0, points: circle(center, (26 + 44 * puff) * (1 - i * 0.14)), closed: true, fill: "muted", stroke: "none" });
    }
  }
  out.push(...smoke.drawables);

  const fx = new Ink(`${id}.shot`, 5, opacity);
  const flash = Math.sin(Math.PI * span(t, SHOT.flash));
  if (flash > 0) fx.add({ name: "flash", kind: "path", x: 0, y: 0, points: star({ x: muzzle.x + f * 46 * flash, y: muzzle.y }, 74 * flash, 0.42, 7, 0), closed: true, fill: "highlight", stroke: "none" });

  const flight = span(t, SHOT.flight);
  if (flight > 0 && flight < 1) {
    const u = flight;
    const tail = Array.from({ length: 9 }, (_, i) => path(Math.max(0, u - (i / 8) * 0.22)));
    const side = tail.map((p, i) => {
      const next = tail[Math.min(tail.length - 1, i + 1)]!;
      const prev = tail[Math.max(0, i - 1)]!;
      const len = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
      const w = 9 * (1 - i / (tail.length - 1));
      return { n: { x: ((next.y - prev.y) / len) * w, y: (-(next.x - prev.x) / len) * w }, p };
    });
    fx.add({ name: "trail", kind: "path", x: 0, y: 0, points: [...side.flatMap(({ p, n }) => [p.x + n.x, p.y + n.y]), ...side.reverse().flatMap(({ p, n }) => [p.x - n.x, p.y - n.y])], closed: true, fill: "accent", stroke: "none", opacity: 0.75 });
    const ball = path(u);
    fx.add({ name: "ball", kind: "circle", x: ball.x, y: ball.y, r: 13, fill: "ink", stroke: "ground", strokeWidth: 4 });
  }

  const burst = span(t, SHOT.burst);
  if (burst > 0 && burst < 1) {
    const fade = 1 - burst;
    const cloud = new Ink(`${id}.impact`, 4, opacity * 0.32 * fade);
    for (let i = 0; i < 5; i++) {
      const center = { x: target.x + (i - 2) * 34 * (0.6 + burst), y: target.y - 50 * burst - Math.abs(i - 2) * -12 };
      cloud.add({ name: `puff${i}`, kind: "path", x: 0, y: 0, points: circle(center, (30 + 50 * burst) * (1 - Math.abs(i - 2) * 0.16)), closed: true, fill: "muted", stroke: "none" });
    }
    out.push(...cloud.drawables);
    const pop = Math.sin(Math.PI * burst * 2.4);
    if (burst < 1 / 2.4) fx.add({ name: "burst", kind: "path", x: 0, y: 0, points: star(target, 34 + 100 * pop, 0.4, 8, 0.2), closed: true, fill: "highlight", stroke: "none" });
    const fly = (i: number, u: number): Point => {
      const a = -Math.PI / 2 + (i - 2.5) * 0.46;
      return { x: target.x + Math.cos(a) * 330 * u, y: target.y + Math.sin(a) * 330 * u + 260 * u * u };
    };
    for (let i = 0; i < 6; i++) {
      const head = fly(i, burst);
      const tail = fly(i, Math.max(0, burst - 0.08));
      fx.add({ name: `bit${i}`, kind: "line", x: tail.x, y: tail.y, x2: head.x, y2: head.y, stroke: "accent", strokeWidth: 6, opacity: fade });
    }
  }
  return [...out, ...fx.drawables];
}

function star(center: Point, r: number, inner: number, points: number, turn: number): number[] {
  return Array.from({ length: points * 2 }, (_, i) => {
    const a = (i / (points * 2)) * Math.PI * 2 + turn;
    const rr = i % 2 === 0 ? r : r * inner;
    return [center.x + rr * Math.cos(a), center.y + rr * Math.sin(a)];
  }).flat();
}

function circle(center: Point, r: number): number[] {
  return Array.from({ length: 24 }, (_, i) => [center.x + r * Math.cos((i / 24) * Math.PI * 2), center.y + r * Math.sin((i / 24) * Math.PI * 2)]).flat();
}
