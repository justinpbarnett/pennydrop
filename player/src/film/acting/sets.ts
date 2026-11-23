import type { Drawable, Paint, Point } from "../../lab";
import { capsule, Ink, type Look } from "./body";
import type { Ground } from "./rig";

export const STAGE_W = 2400;
export const STAGE_H = 1350;
export const FLOOR = 1180;
export const MUZZLE_REACH = 170;
const SET_Z = 1;
const LINE = 3.5;

export const GENERAL_MARKS: Record<string, number> = {
  "off left": -260, "far left": 300, left: 650, "center left": 950, center: 1200,
  "center right": 1450, right: 1750, "far right": 2100, "off right": 2660,
};

export interface Setting {
  marks: Record<string, number>;
  ground: Ground;
  draw(clock: number): Drawable[];
}

class Sketch {
  readonly drawables: Drawable[] = [];
  private count = 0;

  line(points: number[], paint: Paint = "edge", width = LINE, opacity = 0.8, closed = false, fill: Paint = "none"): void {
    this.drawables.push({ id: `set.${this.count++}`, kind: "path", x: 0, y: 0, points, closed, fill, stroke: paint, strokeWidth: width, opacity, z: SET_Z });
  }

  text(content: string, at: Point, size = 40, paint: Paint = "muted", opacity = 0.9): void {
    this.drawables.push({ id: `set.${this.count++}`, kind: "text", x: at.x, y: at.y, text: content, size, font: "read", fill: paint, opacity, z: SET_Z });
  }

  rect(x: number, y: number, w: number, h: number, paint: Paint = "edge", width = LINE, opacity = 0.8): void {
    this.line([x, y, x + w, y, x + w, y + h, x, y + h], paint, width, opacity, true);
  }

  arch(x: number, y: number, w: number, h: number, paint: Paint = "edge", opacity = 0.8): void {
    const r = w / 2;
    const points = [x, y + h];
    for (let i = 0; i <= 16; i++) {
      const t = Math.PI + (Math.PI * i) / 16;
      points.push(x + r + r * Math.cos(t), y + r + r * Math.sin(t));
    }
    points.push(x + w, y + h);
    this.line(points, paint, LINE, opacity);
  }

  column(x: number, top: number, bottom: number, width = 46, opacity = 0.7): void {
    this.line([x - width / 2, bottom, x - width / 2, top], "edge", LINE, opacity);
    this.line([x + width / 2, bottom, x + width / 2, top], "edge", LINE, opacity);
    this.line([x - width / 2 - 14, top, x + width / 2 + 14, top], "edge", LINE, opacity);
    this.line([x - width / 2 - 10, bottom, x + width / 2 + 10, bottom], "edge", LINE, opacity);
  }

  waves(from: number, to: number, y: number, clock: number, rows = 3): void {
    for (let row = 0; row < rows; row++) {
      const points: number[] = [];
      for (let x = from; x <= to; x += 40) points.push(x, y + row * 46 + Math.sin(x / 70 + clock * 1.3 + row * 1.7) * 6);
      this.line(points, row === 0 ? "edge" : "rule", 3, 0.8 - row * 0.15);
    }
  }
}

const flat: Ground = () => FLOOR;

function floorLine(sketch: Sketch, ground: Ground, from = -200, to = STAGE_W + 200): void {
  const points: number[] = [];
  for (let x = from; x <= to; x += 10) points.push(x, ground(x));
  sketch.line(points, "edge", 4, 0.9);
}

function steps(ground: number, rises: { from: number; to: number; drop: number }[]): Ground {
  return (x) => rises.reduce((y, step) => (x >= step.from && x < step.to ? ground - step.drop : y), ground);
}

function ship(sketch: Sketch, x: number, y: number, scale: number, clock: number): void {
  const bob = Math.sin(clock * 0.9 + x) * 4;
  const s = (px: number, py: number) => [x + px * scale, y + bob + py * scale];
  sketch.line([...s(-150, 0), ...s(150, 0), ...s(115, 50), ...s(-115, 50)], "muted", LINE, 0.75, true, "ground");
  sketch.line([...s(-50, 0), ...s(-50, -230)], "muted", LINE, 0.75);
  sketch.line([...s(50, 0), ...s(50, -260)], "muted", LINE, 0.75);
  sketch.line([...s(-50, -210), ...s(-50, -40), ...s(-130, -60)], "edge", 3, 0.75, true);
  sketch.line([...s(50, -240), ...s(50, -50), ...s(130, -70)], "edge", 3, 0.75, true);
}

function tent(sketch: Sketch, x: number, w: number, h: number): void {
  sketch.line([x - w / 2, FLOOR - 110, x, FLOOR - 110 - h, x + w / 2, FLOOR - 110], "edge", LINE, 0.65, true);
  sketch.line([x, FLOOR - 110 - h, x - w * 0.12, FLOOR - 110], "edge", 3, 0.5);
}

type SetMaker = (labels: string[]) => Setting;

const SETTINGS: Record<string, SetMaker> = {
  field: () => ({
    marks: {},
    ground: flat,
    draw(clock) {
      const sketch = new Sketch();
      floorLine(sketch, flat);
      sketch.line([-200, 980, 300, 930, 700, 960, 1100, 900, 1500, 950, 1900, 910, 2600, 960], "rule", 3, 0.9);
      for (let i = 0; i < 18; i++) {
        const x = 80 + i * 137;
        const lean = Math.sin(clock * 0.8 + i) * 5;
        sketch.line([x, FLOOR + 40, x + lean, FLOOR + 16], "rule", 3, 0.7);
      }
      return sketch.drawables;
    },
  }),
  hall: () => {
    const ground = steps(FLOOR, [{ from: 1440, to: 1480, drop: 40 }, { from: 1480, to: 1960, drop: 88 }]);
    return {
      marks: { tribune: 1720, floor: 800, benches: 400 },
      ground,
      draw() {
        const sketch = new Sketch();
        [180, 480, 780, 1080, 2140].forEach((x) => sketch.column(x, 340, FLOOR));
        [1500, 1940].forEach((x) => sketch.column(x, 340, FLOOR - 88));
        sketch.line([-200, 320, 2600, 320], "edge", LINE, 0.7);
        sketch.line([-200, 290, 2600, 290], "edge", LINE, 0.5);
        sketch.rect(1480, FLOOR - 88, 480, 88, "edge", LINE, 0.85);
        sketch.line([1440, FLOOR, 1440, FLOOR - 40, 1480, FLOOR - 40], "edge", LINE, 0.85);
        sketch.line([1560, FLOOR - 88, 1560, FLOOR - 230, 1880, FLOOR - 230, 1880, FLOOR - 88], "edge", LINE, 0.6);
        floorLine(sketch, ground);
        return sketch.drawables;
      },
    };
  },
  orangery: () => ({
    marks: { doors: 300, windows: 1200 },
    ground: flat,
    draw() {
      const sketch = new Sketch();
      [140, 520, 900, 1280, 1660, 2040].forEach((x) => sketch.arch(x, 420, 220, 560, "edge", 0.7));
      [140, 520, 900, 1280, 1660, 2040].forEach((x) => sketch.line([x + 110, 420, x + 110, 980], "rule", 3, 0.7));
      sketch.line([-200, 360, 2600, 360], "edge", LINE, 0.6);
      floorLine(sketch, flat);
      return sketch.drawables;
    },
  }),
  street: () => {
    const ground = steps(FLOOR, [{ from: 1600, to: 1660, drop: 34 }, { from: 1660, to: 1720, drop: 68 }, { from: 1720, to: 2600, drop: 102 }]);
    return {
      marks: { steps: 1640, church: 1980, street: 900 },
      ground,
      draw() {
        const sketch = new Sketch();
        [[-60, 420, 460], [420, 520, 420], [860, 380, 420]].forEach(([x, top, w]) => {
          sketch.line([x!, FLOOR, x!, top!, x! + w!, top!, x! + w!, FLOOR], "edge", LINE, 0.6);
          for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) sketch.rect(x! + 60 + col * (w! / 3), top! + 70 + row * 170, 70, 110, "rule", 3, 0.8);
          }
        });
        sketch.line([1740, FLOOR - 102, 1740, 520, 2340, 520, 2340, FLOOR - 102], "edge", LINE, 0.8);
        sketch.line([1700, 520, 2040, 330, 2380, 520], "edge", LINE, 0.8, true);
        [1800, 1940, 2140, 2280].forEach((x) => sketch.column(x, 540, FLOOR - 102, 40, 0.7));
        sketch.arch(1980, 760, 120, 318, "edge", 0.8);
        sketch.line([1600, FLOOR, 1600, FLOOR - 34, 1660, FLOOR - 34, 1660, FLOOR - 68, 1720, FLOOR - 68, 1720, FLOOR - 102, 2600, FLOOR - 102], "edge", 4, 0.9);
        floorLine(sketch, ground, -200, 1600);
        return sketch.drawables;
      },
    };
  },
  harbor: () => ({
    marks: { fort: 420, battery: 760, quay: 1150, shore: 1260, sea: 1900 },
    ground: flat,
    draw(clock) {
      const sketch = new Sketch();
      sketch.line([-200, 1000, 120, 860, 520, 820, 880, 900, 1180, 1000], "rule", 3, 0.9);
      sketch.line([260, 850, 260, 760, 330, 760, 330, 790, 400, 790, 400, 760, 470, 760, 470, 790, 540, 790, 540, 760, 610, 760, 610, 860], "edge", LINE, 0.8);
      sketch.waves(1330, 2560, FLOOR + 6, clock, 3);
      ship(sketch, 1700, FLOOR - 4, 0.95, clock);
      ship(sketch, 2180, FLOOR - 30, 0.7, clock);
      floorLine(sketch, flat, -200, 1320);
      sketch.line([1320, FLOOR, 1340, FLOOR + 60], "edge", 4, 0.9);
      return sketch.drawables;
    },
  }),
  camp: () => ({
    marks: { tents: 500, fire: 1500 },
    ground: flat,
    draw() {
      const sketch = new Sketch();
      [[260, 300, 210], [700, 360, 240], [1900, 320, 220], [2250, 260, 190]].forEach(([x, w, h]) => tent(sketch, x!, w!, h!));
      sketch.line([-200, 1070, 2600, 1070], "rule", 3, 0.7);
      floorLine(sketch, flat);
      return sketch.drawables;
    },
  }),
  bridge: () => {
    const ground: Ground = (x) => (x > 700 && x < 1700 ? FLOOR - 70 * Math.sin((Math.PI * (x - 700)) / 1000) : FLOOR);
    return {
      marks: { bridge: 1200, "near bank": 420, "far bank": 1980 },
      ground,
      draw(clock) {
        const sketch = new Sketch();
        sketch.waves(640, 1760, FLOOR + 120, clock, 2);
        [[760, 1033], [1033, 1366], [1366, 1640]].forEach(([a, b]) => {
          const points: number[] = [];
          for (let i = 0; i <= 16; i++) {
            const t = Math.PI + (Math.PI * i) / 16;
            points.push((a! + b!) / 2 + ((b! - a!) / 2) * Math.cos(t), FLOOR + 120 + 110 * Math.sin(t));
          }
          sketch.line(points, "edge", LINE, 0.8);
        });
        const rail: number[] = [];
        for (let x = 700; x <= 1700; x += 20) rail.push(x, ground(x) - 90);
        sketch.line(rail, "edge", 3, 0.6);
        floorLine(sketch, ground);
        return sketch.drawables;
      },
    };
  },
  office: () => ({
    marks: { desk: 1100, window: 1700, door: 340 },
    ground: flat,
    draw() {
      const sketch = new Sketch();
      sketch.rect(1560, 420, 300, 400, "edge", LINE, 0.8);
      sketch.line([1710, 420, 1710, 820], "edge", 3, 0.7);
      sketch.line([1560, 620, 1860, 620], "edge", 3, 0.7);
      sketch.rect(240, 560, 200, FLOOR - 560, "edge", LINE, 0.7);
      floorLine(sketch, flat);
      return sketch.drawables;
    },
  }),
  prison: () => ({
    marks: { window: 1420, cell: 1000, door: 400 },
    ground: flat,
    draw() {
      const sketch = new Sketch();
      sketch.rect(1300, 420, 250, 220, "edge", LINE, 0.85);
      [1340, 1390, 1440, 1490].forEach((x) => sketch.line([x + 10, 420, x + 10, 640], "muted", 5, 0.85));
      sketch.line([1300, 530, 1550, 530], "muted", 5, 0.85);
      sketch.line([300, FLOOR, 300, 600, 500, 600, 500, FLOOR], "edge", LINE, 0.7);
      sketch.line([1700, FLOOR - 120, 2200, FLOOR - 120], "edge", LINE, 0.7);
      floorLine(sketch, flat);
      return sketch.drawables;
    },
  }),
  palace: () => {
    const ground = steps(FLOOR, [{ from: 1500, to: 1560, drop: 40 }, { from: 1560, to: 2000, drop: 80 }]);
    return {
      marks: { throne: 1780, hall: 900 },
      ground,
      draw() {
        const sketch = new Sketch();
        [220, 560, 900, 2200].forEach((x) => sketch.column(x, 360, FLOOR));
        sketch.line([-200, 340, 2600, 340], "edge", LINE, 0.7);
        sketch.rect(1560, FLOOR - 80, 440, 80, "edge", LINE, 0.85);
        sketch.line([1500, FLOOR, 1500, FLOOR - 40, 1560, FLOOR - 40], "edge", LINE, 0.85);
        sketch.line([1680, FLOOR - 80, 1680, FLOOR - 400, 1780, FLOOR - 460, 1880, FLOOR - 400, 1880, FLOOR - 80], "accent", LINE, 0.6);
        floorLine(sketch, ground);
        return sketch.drawables;
      },
    };
  },
  ranks: (labels) => {
    const count = Math.max(1, labels.length);
    const from = 200;
    const width = (STAGE_W - 2 * from) / count;
    const rise = Math.min(110, 560 / count);
    const tread = (i: number) => FLOOR - (i + 1) * rise;
    const ground: Ground = (x) => {
      const i = Math.floor((x - from) / width);
      return i < 0 ? FLOOR : tread(Math.min(i, count - 1));
    };
    const marks = Object.fromEntries(labels.map((_, i) => [`step ${i + 1}`, from + (i + 0.5) * width]));
    return {
      marks: { ...marks, floor: 100 },
      ground,
      draw() {
        const sketch = new Sketch();
        const profile: number[] = [-200, FLOOR, from, FLOOR];
        labels.forEach((label, i) => {
          profile.push(from + i * width, tread(i), from + (i + 1) * width, tread(i));
          sketch.text(label, { x: from + (i + 0.5) * width, y: tread(i) + 46 }, 40, "muted", 0.85);
        });
        profile.push(STAGE_W + 200, tread(count - 1));
        sketch.line(profile, "edge", 4, 0.9);
        labels.forEach((_, i) => sketch.line([from + i * width, tread(i), from + i * width, FLOOR], "rule", 3, 0.8));
        return sketch.drawables;
      },
    };
  },
};

export const SET_NAMES = Object.keys(SETTINGS);

export function settingOf(name: string, labels: string[]): Setting {
  const maker = SETTINGS[name];
  if (!maker) throw new Error(`unknown set "${name}"`);
  const setting = maker(labels);
  return { ...setting, marks: { ...GENERAL_MARKS, ...setting.marks } };
}

export const THING_KINDS = ["cannon", "desk", "urn", "throne"] as const;
export type ThingKind = (typeof THING_KINDS)[number];

export interface FireMoment {
  progress: number;
  target: Point | null;
}

export function drawThing(id: string, kind: ThingKind, x: number, facing: number, ground: Ground, look: Look, clock: number, fire: FireMoment | null): Drawable[] {
  const ink = new Ink(id, 2, look.opacity);
  const y = ground(x);
  const f = facing;
  switch (kind) {
    case "cannon": {
      const kick = fire ? -f * 34 * Math.sin(Math.PI * Math.min(1, fire.progress / 0.45)) * (fire.progress < 0.45 ? 1 : 0) : 0;
      const cx = x + kick;
      const breech = { x: cx - f * 90, y: y - 104 };
      const muzzle = { x: cx + f * MUZZLE_REACH, y: y - 134 };
      const wheel: number[] = [];
      for (let i = 0; i < 20; i++) wheel.push(cx + 62 * Math.cos((i / 20) * Math.PI * 2), y - 62 + 62 * Math.sin((i / 20) * Math.PI * 2));
      ink.group("trail", [capsule({ x: cx - f * 40, y: y - 80 }, 14, { x: cx - f * 200, y: y - 10 }, 10)], look);
      ink.group("barrel", [capsule(breech, 30, muzzle, 19)], look, [{ points: [muzzle.x - f * 30, muzzle.y - 16, muzzle.x - f * 30, muzzle.y + 16], width: 2.6 }]);
      ink.group("wheel", [wheel], look, [0, 60, 120].map((deg) => {
        const t = (deg * Math.PI) / 180 + kick / 62;
        return { points: [cx - 56 * Math.cos(t), y - 62 - 56 * Math.sin(t), cx + 56 * Math.cos(t), y - 62 + 56 * Math.sin(t)], width: 3 };
      }));
      return fire ? [...ink.drawables, ...drawShot(id, muzzle, f, fire, clock, look.opacity)] : ink.drawables;
    }
    case "desk": {
      const leg = (at: number) => [at - 9, y - 300, at + 9, y - 300, at + 9, y, at - 9, y];
      ink.group("desk", [[x - 170, y - 330, x + 170, y - 330, x + 170, y - 300, x - 170, y - 300], leg(x - 150), leg(x + 150)], look, [
        { points: [x - 60, y - 338, x + 30, y - 342], paint: look.trim, width: 6 },
      ]);
      const flicker = Math.sin(clock * 9) * 3 + Math.sin(clock * 13.7) * 2;
      ink.add({ name: "glow", kind: "circle", x: x + 120, y: y - 400, r: 60, fill: "highlight", stroke: "none", opacity: 0.12 });
      ink.add({ name: "candle", kind: "path", x: 0, y: 0, points: [x + 112, y - 332, x + 112, y - 380, x + 128, y - 380, x + 128, y - 332], closed: true, fill: look.fill, stroke: look.line, strokeWidth: look.width * 2 });
      ink.add({ name: "flame", kind: "path", x: 0, y: 0, points: [x + 120, y - 418 + flicker, x + 130, y - 394, x + 120, y - 384, x + 110, y - 394], closed: true, fill: "highlight", stroke: "none" });
      return ink.drawables;
    }
    case "urn": {
      ink.group("urn", [[x - 80, y, x - 96, y - 120, x - 70, y - 210, x + 70, y - 210, x + 96, y - 120, x + 80, y]], look, [{ points: [x - 40, y - 210, x + 40, y - 210], paint: look.trim, width: 6 }]);
      return ink.drawables;
    }
    case "throne": {
      ink.group("throne", [[x - 70, y, x - 70, y - 420, x, y - 470, x + 70, y - 420, x + 70, y]], { ...look, fill: look.trim }, [{ points: [x - 70, y - 190, x + 70, y - 190] }]);
      return ink.drawables;
    }
  }
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
