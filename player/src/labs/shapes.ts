import { textWidth } from "../text-metrics";
import { type Drawable, fail, type LabDef, type LabOp, lerp, type Paint, type Point, type Role, type Size } from "../lab";

type SpecFields = Record<string, unknown>;
type Side = "a" | "b" | "c";
type Arrangement = "frame" | "squares";

interface Base {
  objectId: string;
  numerals: boolean;
}

interface OpDef<S> {
  doc: string;
  seconds: number;
  run(state: S, op: LabOp): S;
  during?(before: S, after: S, op: LabOp, progress: number): Drawable[];
}

interface Figure<S extends Base> {
  spec: Record<string, string>;
  init(spec: SpecFields, objectId: string, numerals: boolean): S;
  ops: Record<string, OpDef<S>>;
  size(state: S): Size;
  draw(state: S): Drawable[];
}

const SIDES: Side[] = ["a", "b", "c"];
const SIDE_ROLE: Record<Side, Role> = { a: "done", b: "swap", c: "accent" };
const MAX_FILLED_SIDE = 12;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const ease = (value: number) => clamp01(value) ** 2 * (3 - 2 * clamp01(value));
const whole = (value: number) => Math.floor(value + 1e-9);
const fmt = (value: number) => String(Math.round(value * 100) / 100);
const isWhole = (value: number) => Math.abs(value - Math.round(value)) < 1e-9;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const mix = (from: Point, to: Point, t: number): Point => ({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) });
const along = (origin: Point, steps: [Point, number][]): Point => ({
  x: origin.x + steps.reduce((sum, [direction, length]) => sum + direction.x * length, 0),
  y: origin.y + steps.reduce((sum, [direction, length]) => sum + direction.y * length, 0),
});

function staggered(progress: number, index: number, count: number, spread: number): number {
  return ease((progress - (spread * index) / count) / (1 - spread));
}

function wholeField(spec: SpecFields, key: string, fallback: number, min: number, max: number, objectId: string): number {
  const value = spec[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${objectId}: "${key}" must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function wholeArg(op: LabOp, key: string, min: number, max: number, fallback?: number): number {
  const value = op.args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`op "${op.name}" needs "${key}" as a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function positiveField(spec: SpecFields, key: string, objectId: string): number | undefined {
  const value = spec[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${objectId}: "${key}" must be a positive number, got ${JSON.stringify(value)}`);
  return value;
}

function text(id: string, x: number, y: number, content: string, size: number, fill: Paint = "ink", extra: Partial<Drawable> = {}): Drawable {
  return { id, kind: "text", x, y, text: content, size, font: "read", fill, ...extra };
}

function box(id: string, x: number, y: number, w: number, h: number, extra: Partial<Drawable>): Drawable {
  return { id, kind: "rect", x, y, w, h, ...extra };
}

function arc(center: Point, radius: number, degrees: number, samples: number): number[] {
  return range(samples).flatMap((index) => {
    const angle = ((degrees * index) / (samples - 1)) * (Math.PI / 180);
    return [center.x + radius * Math.cos(angle), center.y - radius * Math.sin(angle)];
  });
}


interface BlocksState extends Base {
  figure: "blocks";
  count: number;
  columns: number;
  counted: number;
  groupSize: number | null;
}

const BLOCK = 64;
const BLOCK_GAP = 14;
const GROUP_PAD = 16;
const GROUP_GAP = 36;
const BLOCKS_TOP = 120;
const BLOCKS_BOTTOM = 90;
const BLOCKS_MAX_WIDTH = 1000;
const BLOCKS_MIN_WIDTH = 520;
const GROUP_COLUMNS = 5;

interface Outline {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  role: Role;
}

function gridExtent(count: number, columns: number): Size {
  return { w: Math.min(count, columns) * (BLOCK + BLOCK_GAP) - BLOCK_GAP, h: Math.ceil(count / columns) * (BLOCK + BLOCK_GAP) - BLOCK_GAP };
}

function blockLayout(state: BlocksState): { slots: Point[]; outlines: Outline[]; size: Size } {
  const { count, columns, groupSize } = state;
  let slots: Point[];
  let outlines: Outline[] = [];
  let content: Size;
  if (groupSize === null) {
    slots = range(count).map((index) => ({ x: (index % columns) * (BLOCK + BLOCK_GAP) + BLOCK / 2, y: Math.floor(index / columns) * (BLOCK + BLOCK_GAP) + BLOCK / 2 }));
    content = gridExtent(count, columns);
  } else {
    const inner = Math.min(groupSize, GROUP_COLUMNS);
    const groups = Math.ceil(count / groupSize);
    const full = gridExtent(groupSize, inner);
    const boxW = full.w + 2 * GROUP_PAD;
    const boxH = full.h + 2 * GROUP_PAD;
    const perRow = Math.min(groups, Math.max(1, Math.floor((BLOCKS_MAX_WIDTH + GROUP_GAP) / (boxW + GROUP_GAP))));
    slots = [];
    outlines = range(groups).map((group) => {
      const originX = (group % perRow) * (boxW + GROUP_GAP);
      const originY = Math.floor(group / perRow) * (boxH + GROUP_GAP);
      const members = Math.min(groupSize, count - group * groupSize);
      const extent = gridExtent(members, inner);
      range(members).forEach((member) => slots.push({
        x: originX + GROUP_PAD + (member % inner) * (BLOCK + BLOCK_GAP) + BLOCK / 2,
        y: originY + GROUP_PAD + Math.floor(member / inner) * (BLOCK + BLOCK_GAP) + BLOCK / 2,
      }));
      return { id: `group-${group}`, x: originX + (extent.w + 2 * GROUP_PAD) / 2, y: originY + (extent.h + 2 * GROUP_PAD) / 2, w: extent.w + 2 * GROUP_PAD, h: extent.h + 2 * GROUP_PAD, role: members === groupSize ? "accent" : "warn" };
    });
    content = { w: perRow * (boxW + GROUP_GAP) - GROUP_GAP, h: Math.ceil(groups / perRow) * (boxH + GROUP_GAP) - GROUP_GAP };
  }
  const width = Math.max(content.w, BLOCKS_MIN_WIDTH);
  const shift = { x: (width - content.w) / 2, y: BLOCKS_TOP };
  return {
    slots: slots.map((slot) => ({ x: slot.x + shift.x, y: slot.y + shift.y })),
    outlines: outlines.map((outline) => ({ ...outline, x: outline.x + shift.x, y: outline.y + shift.y })),
    size: { w: width, h: BLOCKS_TOP + content.h + BLOCKS_BOTTOM },
  };
}

function groupCaption(state: BlocksState): string {
  const size = state.groupSize!;
  const full = Math.floor(state.count / size);
  const left = state.count % size;
  return `${plural(full, "group")} of ${size}${left > 0 ? `, ${left} left over` : ""}`;
}

function drawBlocks(state: BlocksState, shown: number): Drawable[] {
  const layout = blockLayout(state);
  const lit = whole(shown);
  const pulse = shown - lit > 1e-9 ? Math.sin(Math.PI * (shown - lit)) : 0;
  const out: Drawable[] = [];
  layout.slots.forEach((slot, index) => {
    const isLit = index < lit;
    const scale = index === lit ? 1 + 0.2 * pulse : 1;
    out.push(box(`b${index}`, slot.x, slot.y, BLOCK * scale, BLOCK * scale, {
      fill: isLit ? "accent" : "fill2", stroke: isLit || scale > 1 ? "accent" : "edge", strokeWidth: 2, radius: 0.28, z: 2, part: `${state.objectId}[${index}]`,
    }));
    if (isLit && state.numerals) out.push(text(`n${index}`, slot.x, slot.y, String(index + 1), 30, "ground", { z: 3 }));
  });
  for (const outline of layout.outlines) out.push(box(outline.id, outline.x, outline.y, outline.w, outline.h, { fill: "none", stroke: outline.role, strokeWidth: 3, radius: 0.5, z: 1 }));
  if (state.numerals && lit > 0) out.push(text("total", layout.size.w / 2, 54, String(lit), 76, "ink", { z: 3 }));
  if (state.numerals && state.groupSize !== null) out.push(text("caption", layout.size.w / 2, layout.size.h - 40, groupCaption(state), 40, "ink"));
  return out;
}

const blocks: Figure<BlocksState> = {
  spec: {
    count: "how many blocks, 1 to 100",
    columns: "optional blocks per row, 1 to 20, default 10 or fewer",
  },
  init(spec, objectId, numerals) {
    const count = wholeField(spec, "count", 0, 1, 100, objectId);
    const columns = wholeField(spec, "columns", Math.min(count, 10), 1, 20, objectId);
    return { figure: "blocks", objectId, numerals, count, columns, counted: 0, groupSize: null };
  },
  ops: {
    count: {
      doc: 'lights the blocks one by one while the count ticks up; optional "to": n counts up to n, default all',
      seconds: 2.6,
      run(state, op) {
        const to = wholeArg(op, "to", 1, state.count, state.count);
        if (to <= state.counted) fail(`op "count" on ${state.objectId}: already counted to ${state.counted}; "to" must be from ${state.counted + 1} to ${state.count}`);
        return { ...state, counted: to };
      },
      during: (before, after, _op, progress) => drawBlocks(after, lerp(before.counted, after.counted, progress)),
    },
    group: {
      doc: '{"size": k} slides the blocks into groups of k and counts the groups; a short last group is marked as left over',
      seconds: 1.4,
      run(state, op) {
        if (state.count < 2) fail(`op "group" on ${state.objectId}: one block cannot make groups; make a figure with "count" of at least 2`);
        return { ...state, groupSize: wholeArg(op, "size", 2, state.count) };
      },
    },
    ungroup: {
      doc: "slides the groups back into one row of blocks",
      seconds: 1.2,
      run(state) {
        if (state.groupSize === null) fail(`op "ungroup" on ${state.objectId}: the blocks are not grouped; use op "group" with "size" first`);
        return { ...state, groupSize: null };
      },
    },
  },
  size: (state) => blockLayout(state).size,
  draw: (state) => drawBlocks(state, state.counted),
};


interface Hop {
  from: number;
  to: number;
  step: number;
}

interface LineState extends Base {
  figure: "line";
  from: number;
  to: number;
  token: number;
  hops: Hop[];
}

const LINE_WIDTH = 1000;
const LINE_PAD = 60;
const LINE_Y = 250;
const TOKEN_LIFT = 24;

const lineX = (state: LineState, value: number) => LINE_PAD + ((value - state.from) * LINE_WIDTH) / (state.to - state.from);
const hopHeight = (state: LineState, hop: Hop) => Math.min(150, 36 + 0.12 * Math.abs(lineX(state, hop.to) - lineX(state, hop.from)));

function hopPoints(state: LineState, hop: Hop): number[] {
  const x0 = lineX(state, hop.from);
  const x1 = lineX(state, hop.to);
  return range(21).flatMap((index) => {
    const t = index / 20;
    return [lerp(x0, x1, t), LINE_Y - TOKEN_LIFT - hopHeight(state, hop) * Math.sin(Math.PI * t)];
  });
}

function hopDrawables(state: LineState, index: number, reveal: number): Drawable[] {
  const hop = state.hops[index]!;
  const mid = lineX(state, (hop.from + hop.to) / 2);
  const out: Drawable[] = [{ id: `hop-${index}`, kind: "path", x: 0, y: 0, points: hopPoints(state, hop), fill: "none", stroke: "accent", strokeWidth: 3.5, z: 2, draw: clamp01(reveal) }];
  if (state.numerals) out.push(text(`hop-${index}-label`, mid, LINE_Y - TOKEN_LIFT - hopHeight(state, hop) - 28, `${hop.step > 0 ? "+" : "-"}${Math.abs(hop.step)}`, 30, "ink", { opacity: clamp01((reveal - 0.6) * 2.5), z: 3 }));
  return out;
}

function tokenDrawable(at: Point): Drawable {
  return { id: "token", kind: "circle", x: at.x, y: at.y, r: 22, fill: "accent", stroke: "ink", strokeWidth: 2, z: 4 };
}

const line: Figure<LineState> = {
  spec: {
    from: "left end number, a whole number, default 0",
    to: "right end number, a whole number up to 40 above from, default 10",
    start: "where the hopper stands, default from",
  },
  init(spec, objectId, numerals) {
    const from = wholeField(spec, "from", 0, -1000, 1000, objectId);
    const to = wholeField(spec, "to", from + 10, from + 1, from + 40, objectId);
    const token = wholeField(spec, "start", from, from, to, objectId);
    return { figure: "line", objectId, numerals, from, to, token, hops: [] };
  },
  ops: {
    hop: {
      doc: '{"by": n} the hopper hops n along the line, leaving an arc; "each": k hops k at a time, so by 6 each 2 is three hops; negative goes left',
      seconds: 1.6,
      run(state, op) {
        const by = wholeArg(op, "by", -40, 40);
        if (by === 0) fail(`op "hop" on ${state.objectId}: "by" must not be 0`);
        const step = op.args.each === undefined ? by : wholeArg(op, "each", 1, 40) * Math.sign(by);
        if (Math.abs(by) % Math.abs(step) !== 0) fail(`op "hop" on ${state.objectId}: ${by} is not a whole number of hops of ${Math.abs(step)}; use "each" of 1 or a number that divides ${Math.abs(by)}`);
        const target = state.token + by;
        if (target < state.from || target > state.to) {
          fail(`op "hop" on ${state.objectId}: hopping ${by} from ${state.token} lands on ${target}, off the line that runs ${state.from} to ${state.to}; hop by ${state.to - state.token} at most to the right or ${state.from - state.token} to the left`);
        }
        const hops = range(Math.abs(by / step)).map((index) => ({ from: state.token + index * step, to: state.token + (index + 1) * step, step }));
        return { ...state, token: target, hops: [...state.hops, ...hops] };
      },
      during(before, after, _op, progress) {
        const added = after.hops.slice(before.hops.length);
        const position = progress * added.length;
        const current = Math.min(added.length - 1, whole(position));
        const hop = added[current]!;
        const t = ease(position - current);
        const out = added.flatMap((_, index) => hopDrawables(after, before.hops.length + index, position - index));
        const at = { x: lerp(lineX(after, hop.from), lineX(after, hop.to), t), y: LINE_Y - TOKEN_LIFT - hopHeight(after, hop) * Math.sin(Math.PI * t) };
        return [...out, tokenDrawable(at)];
      },
    },
  },
  size: () => ({ w: LINE_WIDTH + 2 * LINE_PAD, h: LINE_Y + 80 }),
  draw(state) {
    const spacing = LINE_WIDTH / (state.to - state.from);
    const labelEvery = spacing >= 54 ? 1 : 5;
    const out: Drawable[] = [{ id: "axis", kind: "line", x: LINE_PAD - 24, y: LINE_Y, x2: LINE_PAD + LINE_WIDTH + 24, y2: LINE_Y, stroke: "ink", strokeWidth: 3, z: 1 }];
    for (let value = state.from; value <= state.to; value++) {
      const x = lineX(state, value);
      out.push({ id: `tick-${value}`, kind: "line", x, y: LINE_Y - 10, x2: x, y2: LINE_Y + 10, stroke: "ink", strokeWidth: 2, z: 1 });
      const labelled = (value - state.from) % labelEvery === 0 || value === state.to;
      if (state.numerals && labelled) out.push(text(`num-${value}`, x, LINE_Y + 46, String(value), value === state.token ? 42 : 30, value === state.token ? "ink" : "muted"));
    }
    state.hops.forEach((_, index) => out.push(...hopDrawables(state, index, 1)));
    out.push(tokenDrawable({ x: lineX(state, state.token), y: LINE_Y - TOKEN_LIFT }));
    return out;
  },
};


interface FractionState extends Base {
  figure: "fraction";
  parts: number;
  shaded: number;
}

const BAR_WIDTH = 960;
const BAR_HEIGHT = 150;
const BAR_PAD = 60;
const BAR_Y = 100;

function drawFraction(state: FractionState, shown: number): Drawable[] {
  const lit = whole(shown);
  const partWidth = BAR_WIDTH / state.parts;
  const center = BAR_PAD + BAR_WIDTH / 2;
  const out: Drawable[] = range(state.parts).map((index) => box(`part-${index}`, BAR_PAD + partWidth * (index + 0.5), BAR_Y, partWidth, BAR_HEIGHT, {
    fill: index < lit ? "accent" : "fill2", stroke: "ink", strokeWidth: 2.5, z: 1,
  }));
  if (state.numerals) {
    out.push(
      text("numerator", center, BAR_Y + BAR_HEIGHT / 2 + 66, String(lit), 64),
      { id: "vinculum", kind: "line", x: center - 50, y: BAR_Y + BAR_HEIGHT / 2 + 102, x2: center + 50, y2: BAR_Y + BAR_HEIGHT / 2 + 102, stroke: "ink", strokeWidth: 4 },
      text("denominator", center, BAR_Y + BAR_HEIGHT / 2 + 148, String(state.parts), 64),
    );
  }
  return out;
}

const fraction: Figure<FractionState> = {
  spec: {
    parts: "how many equal parts the bar is cut into, 1 to 12, default 4",
    shaded: "parts already shaded, default 0",
  },
  init(spec, objectId, numerals) {
    const parts = wholeField(spec, "parts", 4, 1, 12, objectId);
    return { figure: "fraction", objectId, numerals, parts, shaded: wholeField(spec, "shaded", 0, 0, parts, objectId) };
  },
  ops: {
    shade: {
      doc: '{"to": n} shades parts one by one until n are shaded; the numerator ticks up over the whole bar\'s part count',
      seconds: 1.8,
      run(state, op) {
        const to = wholeArg(op, "to", 0, state.parts);
        if (to === state.shaded) fail(`op "shade" on ${state.objectId}: already ${state.shaded} of ${state.parts} shaded; pick another "to" from 0 to ${state.parts}`);
        return { ...state, shaded: to };
      },
      during: (before, after, _op, progress) => drawFraction(after, lerp(before.shaded, after.shaded, progress)),
    },
  },
  size: () => ({ w: BAR_WIDTH + 2 * BAR_PAD, h: BAR_Y + BAR_HEIGHT / 2 + 190 }),
  draw: (state) => drawFraction(state, state.shaded),
};


interface AreaState extends Base {
  figure: "area";
  columns: number;
  rows: number;
  filled: number;
}

const AREA_LEFT = 70;
const AREA_TOP = 70;
const AREA_BOTTOM = 110;

const areaCell = (state: AreaState) => Math.min(60, Math.floor(900 / state.columns), Math.floor(520 / state.rows));

function drawArea(state: AreaState, shown: number): Drawable[] {
  const cell = areaCell(state);
  const lit = whole(shown);
  const width = state.columns * cell;
  const height = state.rows * cell;
  const out: Drawable[] = range(state.columns * state.rows).map((index) => box(
    `u${index}`, AREA_LEFT + (index % state.columns + 0.5) * cell, AREA_TOP + (Math.floor(index / state.columns) + 0.5) * cell, cell, cell,
    { fill: index < lit ? "accent" : "fill", stroke: index < lit ? "ground" : "edge", strokeWidth: 1.4, opacity: index < lit ? 0.7 : 1, z: 1 },
  ));
  out.push(box("body", AREA_LEFT + width / 2, AREA_TOP + height / 2, width, height, { fill: "none", stroke: "ink", strokeWidth: 3, z: 2 }));
  if (state.numerals) {
    out.push(
      text("columns", AREA_LEFT + width / 2, AREA_TOP - 32, String(state.columns), 38, "muted"),
      text("rows", AREA_LEFT - 36, AREA_TOP + height / 2, String(state.rows), 38, "muted"),
      text("formula", AREA_LEFT + width / 2, AREA_TOP + height + 58, `${state.columns} × ${state.rows} = ${lit > 0 ? lit : "?"}`, 56),
    );
  }
  return out;
}

const area: Figure<AreaState> = {
  spec: {
    columns: "unit squares across, 1 to 20",
    rows: "unit squares down, 1 to 20; equal to columns makes a square",
  },
  init(spec, objectId, numerals) {
    const columns = wholeField(spec, "columns", 0, 1, 20, objectId);
    return { figure: "area", objectId, numerals, columns, rows: wholeField(spec, "rows", columns, 1, 20, objectId), filled: 0 };
  },
  ops: {
    fill: {
      doc: 'fills the unit squares row by row while the count ticks up; optional "to": n fills the first n, default all',
      seconds: 2.4,
      run(state, op) {
        const total = state.columns * state.rows;
        const to = wholeArg(op, "to", 1, total, total);
        if (to <= state.filled) fail(`op "fill" on ${state.objectId}: ${state.filled} of ${total} squares are already filled; "to" must be from ${state.filled + 1} to ${total}`);
        return { ...state, filled: to };
      },
      during: (before, after, _op, progress) => drawArea(after, lerp(before.filled, after.filled, progress)),
    },
  },
  size(state) {
    return { w: AREA_LEFT + state.columns * areaCell(state) + 30, h: AREA_TOP + state.rows * areaCell(state) + AREA_BOTTOM };
  },
  draw: (state) => drawArea(state, state.filled),
};


interface AngleState extends Base {
  figure: "angle";
  degrees: number;
}

const RAY = 380;
const ANGLE_PAD = 40;
const ANGLE_VERTEX: Point = { x: RAY + ANGLE_PAD, y: RAY + ANGLE_PAD };
const ARC_RADIUS = 96;
const RIGHT_MARK = 44;

function drawAngle(state: AngleState, degrees: number): Drawable[] {
  const radians = (degrees * Math.PI) / 180;
  const vertex = ANGLE_VERTEX;
  const tip = { x: vertex.x + RAY * Math.cos(radians), y: vertex.y - RAY * Math.sin(radians) };
  const sweep = arc(vertex, ARC_RADIUS, degrees, 33);
  const out: Drawable[] = [
    { id: "wedge", kind: "path", x: 0, y: 0, points: [vertex.x, vertex.y, ...sweep], closed: true, fill: "accent", stroke: "none", opacity: 0.28, z: 1 },
    { id: "base", kind: "line", x: vertex.x, y: vertex.y, x2: vertex.x + RAY, y2: vertex.y, stroke: "ink", strokeWidth: 5, z: 2 },
    { id: "ray", kind: "line", x: vertex.x, y: vertex.y, x2: tip.x, y2: tip.y, stroke: "accent", strokeWidth: 6, z: 3 },
    { id: "arc", kind: "path", x: 0, y: 0, points: sweep, fill: "none", stroke: "accent", strokeWidth: 4, z: 3 },
    { id: "right-mark", kind: "path", x: 0, y: 0, points: [vertex.x + RIGHT_MARK, vertex.y, vertex.x + RIGHT_MARK, vertex.y - RIGHT_MARK, vertex.x, vertex.y - RIGHT_MARK], fill: "none", stroke: "ink", strokeWidth: 3, opacity: Math.abs(degrees - 90) < 0.5 ? 1 : 0, z: 3 },
  ];
  if (state.numerals) out.push(text("degrees", vertex.x, vertex.y + 54, `${Math.round(degrees)}°`, 52));
  return out;
}

const angle: Figure<AngleState> = {
  spec: { degrees: "size of the angle, 1 to 180, default 90; 90 gets a square corner mark" },
  init(spec, objectId, numerals) {
    return { figure: "angle", objectId, numerals, degrees: wholeField(spec, "degrees", 90, 1, 180, objectId) };
  },
  ops: {
    open: {
      doc: '{"to": degrees} swings the top ray to a new angle, 1 to 180, while the number ticks',
      seconds: 1.8,
      run(state, op) {
        const to = wholeArg(op, "to", 1, 180);
        if (to === state.degrees) fail(`op "open" on ${state.objectId}: the angle is already ${to} degrees; pick another "to" from 1 to 180`);
        return { ...state, degrees: to };
      },
      during: (before, after, _op, progress) => drawAngle(after, lerp(before.degrees, after.degrees, progress)),
    },
  },
  size: () => ({ w: 2 * RAY + 2 * ANGLE_PAD, h: RAY + ANGLE_PAD + 110 }),
  draw: (state) => drawAngle(state, state.degrees),
};


interface TriangleState extends Base {
  figure: "triangle";
  lengths: Record<Side, number>;
  unit: number;
  built: Record<Side, boolean>;
  filled: Record<Side, number>;
  combined: boolean;
}

interface SquareFrame {
  origin: Point;
  across: Point;
  outward: Point;
  start: Point;
  end: Point;
  turn: number;
}

interface TriangleView {
  growth: Record<Side, number>;
  shown: Record<Side, number>;
  combine: number;
}

const SIDE_TAG_HEIGHT = 44;
const SIDE_TAG_PADDING = 28;
const SIDE_TAG_GAP = 14;
const SIDE_TAG_FONT = 30;
const EXTENT_PAD = 4;
const RIGHT_MARK_CLEARANCE = 10;

function quarterTurn(direction: Point): number {
  const degrees = (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
  return ((((degrees + 45) % 90) + 90) % 90) - 45;
}

function triangleUnit(a: number, b: number): number {
  return Math.min(100, 1000 / (a + 2 * b), 620 / (2 * a + b));
}

function squareFrames(state: TriangleState): Record<Side, SquareFrame> {
  const { a, b, c } = state.lengths;
  const u = state.unit;
  const right = { x: b * u, y: (a + b) * u };
  const foot = { x: right.x + a * u, y: right.y };
  const top = { x: right.x, y: right.y - b * u };
  const hypotenuse = { x: (top.x - foot.x) / (c * u), y: (top.y - foot.y) / (c * u) };
  return {
    a: { origin: right, across: { x: 1, y: 0 }, outward: { x: 0, y: 1 }, start: right, end: foot, turn: 0 },
    b: { origin: top, across: { x: 0, y: 1 }, outward: { x: -1, y: 0 }, start: top, end: right, turn: 0 },
    c: { origin: foot, across: hypotenuse, outward: { x: b / c, y: -a / c }, start: foot, end: top, turn: quarterTurn(hypotenuse) },
  };
}

function cellCenter(frame: SquareFrame, unit: number, column: number, row: number): Point {
  return along(frame.origin, [[frame.across, (column + 0.5) * unit], [frame.outward, (row + 0.5) * unit]]);
}

const sideLength = (state: TriangleState, side: Side) => state.lengths[side];
const hasCells = (state: TriangleState, side: Side) => isWhole(sideLength(state, side));
const cellTotal = (state: TriangleState, side: Side) => Math.round(sideLength(state, side) ** 2);

function staticView(state: TriangleState): TriangleView {
  const growth = { a: state.built.a ? 1 : 0, b: state.built.b ? 1 : 0, c: state.built.c ? 1 : 0 };
  return { growth, shown: { ...state.filled }, combine: state.combined ? 1 : 0 };
}

function cellPose(state: TriangleState, frames: Record<Side, SquareFrame>, side: Side, index: number, combine: number): { at: Point; turn: number; moved: number } {
  const length = sideLength(state, side);
  const home = cellCenter(frames[side], state.unit, index % length, Math.floor(index / length));
  if (side === "c" || combine <= 0) return { at: home, turn: frames[side].turn, moved: 0 };
  const slot = (side === "a" ? 0 : cellTotal(state, "a")) + index;
  const total = cellTotal(state, "a") + cellTotal(state, "b");
  const moved = staggered(combine, slot, total, 0.6);
  const target = cellCenter(frames.c, state.unit, slot % state.lengths.c, Math.floor(slot / state.lengths.c));
  return { at: mix(home, target, moved), turn: lerp(frames[side].turn, frames.c.turn, moved), moved };
}

function squareCount(state: TriangleState, side: Side, view: TriangleView): string | null {
  if (view.combine > 0 && side !== "c") return null;
  if (side === "c" && view.combine > 0) return String(whole(lerp(view.shown.c, cellTotal(state, "a") + cellTotal(state, "b"), view.combine)));
  if (!hasCells(state, side)) return fmt(sideLength(state, side) ** 2);
  return whole(view.shown[side]) > 0 ? String(whole(view.shown[side])) : null;
}

function drawSquare(state: TriangleState, frames: Record<Side, SquareFrame>, side: Side, view: TriangleView): Drawable[] {
  const growth = view.growth[side];
  if (growth <= 0) return [];
  const frame = frames[side];
  const u = state.unit;
  const length = sideLength(state, side);
  const part = `${state.objectId}[${side}]`;
  const role = SIDE_ROLE[side];
  const reach = length * u * growth;
  const corners = [frame.origin, along(frame.origin, [[frame.across, length * u]]), along(frame.origin, [[frame.across, length * u], [frame.outward, reach]]), along(frame.origin, [[frame.outward, reach]])];
  const out: Drawable[] = [{
    id: `${side}-square`, kind: "path", x: 0, y: 0, points: corners.flatMap((corner) => [corner.x, corner.y]), closed: true,
    fill: hasCells(state, side) ? "fill" : role, stroke: role, strokeWidth: 3.5, opacity: hasCells(state, side) ? 1 : 0.3, z: 1, part,
  }];
  if (hasCells(state, side)) {
    range(cellTotal(state, side)).forEach((index) => {
      const row = Math.floor(index / length);
      const visible = clamp01(growth * length - row);
      const lit = index < whole(view.shown[side]) && !(side === "c" && view.combine > 0);
      const pose = cellPose(state, frames, side, index, view.combine);
      out.push(box(`${side}-u${index}`, pose.at.x, pose.at.y, u, u, {
        fill: lit ? role : "fill", stroke: lit ? "ground" : "edge", strokeWidth: 1.4, opacity: lit ? 0.62 * visible : visible, rotation: pose.turn, z: pose.moved > 0 ? 4 : 2, part,
      }));
    });
  }
  const count = state.numerals && growth >= 1 ? squareCount(state, side, view) : null;
  if (count !== null) {
    const center = along(frame.origin, [[frame.across, (length * u) / 2], [frame.outward, (length * u) / 2]]);
    const size = Math.min(72, Math.max(28, u * 1.1));
    out.push(
      box(`${side}-count-back`, center.x, center.y, size * (0.5 * count.length + 0.9), size * 1.25, { fill: "ground", opacity: 0.8, radius: 0.5, z: 5 }),
      text(`${side}-count`, center.x, center.y, count, size, "ink", { z: 6 }),
    );
  }
  return out;
}

function shifted(drawables: Drawable[], dx: number, dy: number): Drawable[] {
  return drawables.map((drawable) => ({
    ...drawable,
    x: drawable.x + dx,
    y: drawable.y + dy,
    ...(drawable.x2 !== undefined && drawable.y2 !== undefined ? { x2: drawable.x2 + dx, y2: drawable.y2 + dy } : {}),
    ...(drawable.points ? { points: drawable.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) } : {}),
  }));
}

function extentOf(drawables: Drawable[]): { min: Point; max: Point } {
  const min = { x: Infinity, y: Infinity };
  const max = { x: -Infinity, y: -Infinity };
  const include = (x: number, y: number) => {
    min.x = Math.min(min.x, x - EXTENT_PAD);
    min.y = Math.min(min.y, y - EXTENT_PAD);
    max.x = Math.max(max.x, x + EXTENT_PAD);
    max.y = Math.max(max.y, y + EXTENT_PAD);
  };
  for (const drawable of drawables) {
    if (drawable.kind === "path" && drawable.points) for (let index = 0; index < drawable.points.length; index += 2) include(drawable.points[index]!, drawable.points[index + 1]!);
    if (drawable.kind === "rect" && !drawable.rotation) {
      include(drawable.x - drawable.w! / 2, drawable.y - drawable.h! / 2);
      include(drawable.x + drawable.w! / 2, drawable.y + drawable.h! / 2);
    }
  }
  return { min, max };
}

function sideTagSize(state: TriangleState, side: Side): { label: string; w: number; h: number } {
  const label = `${side} = ${fmt(sideLength(state, side))}`;
  return { label, w: textWidth(label, SIDE_TAG_FONT, "read") + SIDE_TAG_PADDING, h: SIDE_TAG_HEIGHT };
}

function triangleDrawables(state: TriangleState, view: TriangleView): Drawable[] {
  const frames = squareFrames(state);
  const { a: right, b: top } = { a: frames.a.start, b: frames.b.start };
  const foot = frames.a.end;
  const out: Drawable[] = [{ id: "body", kind: "path", x: 0, y: 0, points: [right.x, right.y, foot.x, foot.y, top.x, top.y], closed: true, fill: "fill2", stroke: "ink", strokeWidth: 2.5, z: 3 }];
  const mark = Math.min(40, 0.2 * Math.min(state.lengths.a, state.lengths.b) * state.unit);
  const clear = RIGHT_MARK_CLEARANCE;
  out.push({
    id: "right-mark", kind: "path", x: 0, y: 0,
    points: [right.x + clear + mark, right.y - clear, right.x + clear + mark, right.y - clear - mark, right.x + clear, right.y - clear - mark],
    fill: "none", stroke: "ink", strokeWidth: 2.5, z: 6,
  });
  for (const side of SIDES) {
    const frame = frames[side];
    out.push({ id: `${side}-edge`, kind: "line", x: frame.start.x, y: frame.start.y, x2: frame.end.x, y2: frame.end.y, stroke: SIDE_ROLE[side], strokeWidth: 7, z: 5, part: `${state.objectId}[${side}]` });
    out.push(...drawSquare(state, frames, side, view));
    if (state.numerals) {
      const tag = sideTagSize(state, side);
      const reach = view.growth[side] * sideLength(state, side) * state.unit;
      const halfAlong = (Math.abs(frame.outward.x) * tag.w + Math.abs(frame.outward.y) * tag.h) / 2;
      const middle = along(mix(frame.start, frame.end, 0.5), [[frame.outward, reach + SIDE_TAG_GAP + halfAlong]]);
      out.push(
        box(`${side}-tag`, middle.x, middle.y, tag.w, tag.h, { fill: "ground", stroke: SIDE_ROLE[side], strokeWidth: 2.5, radius: 0.5, z: 7 }),
        text(`${side}-label`, middle.x, middle.y, tag.label, SIDE_TAG_FONT, "ink", { z: 8 }),
      );
    }
  }
  return out;
}

const builtView = (): TriangleView => ({ growth: { a: 1, b: 1, c: 1 }, shown: { a: 0, b: 0, c: 0 }, combine: 0 });

function triangleExtent(state: TriangleState) {
  return extentOf(triangleDrawables(state, builtView()));
}

function drawTriangle(state: TriangleState, view: TriangleView): Drawable[] {
  const { min } = triangleExtent(state);
  return shifted(triangleDrawables(state, view), -min.x, -min.y);
}

function sidesOf(state: TriangleState, op: LabOp): Side[] {
  const named = op.args.side ?? op.parts;
  const list = Array.isArray(named) ? named : [named];
  const bad = list.filter((side) => !SIDES.includes(side as Side));
  if (list.length === 0 || (list.length === 1 && list[0] === undefined) || bad.length > 0) {
    fail(`op "${op.name}" on ${state.objectId} needs a side: "side": "a", "b" or "c" (or a list of them), or on: ["${state.objectId}[a]"]; a and b are the legs, c the hypotenuse`);
  }
  return list as Side[];
}

function requireCells(state: TriangleState, side: Side, op: LabOp): void {
  if (!state.built[side]) fail(`op "${op.name}" on ${state.objectId}: the square on side ${side} is not built yet; use op "square" with "side": "${side}" first`);
  if (!hasCells(state, side)) fail(`op "${op.name}" on ${state.objectId}: unit squares need whole-number sides, but side ${side} is ${fmt(sideLength(state, side))} long; use whole numbers such as legs 3 and 4, or 6 and 8`);
  if (sideLength(state, side) > MAX_FILLED_SIDE) fail(`op "${op.name}" on ${state.objectId}: side ${side} is ${fmt(sideLength(state, side))} long; unit squares stay countable up to ${MAX_FILLED_SIDE}, so use a smaller triangle`);
}

function readTriangle(spec: SpecFields, objectId: string, numerals: boolean): TriangleState {
  const given = { a: positiveField(spec, "a", objectId), b: positiveField(spec, "b", objectId), c: positiveField(spec, "c", objectId) };
  const known = SIDES.filter((side) => given[side] !== undefined);
  if (known.length < 2) fail(`${objectId}: a right triangle needs two of its sides: the legs "a" and "b", or one leg and the hypotenuse "c"; got ${known.length === 0 ? "none" : `only "${known[0]}"`}`);
  let { a, b, c } = given;
  if (a !== undefined && b !== undefined) {
    const hypotenuse = Math.hypot(a, b);
    if (c !== undefined && Math.abs(c - hypotenuse) > 0.005 * hypotenuse) {
      fail(`${objectId}: sides ${fmt(a)}, ${fmt(b)} and ${fmt(c)} do not make a right triangle: ${fmt(a)}² + ${fmt(b)}² = ${fmt(a * a + b * b)}, but ${fmt(c)}² = ${fmt(c * c)}; with legs ${fmt(a)} and ${fmt(b)} the hypotenuse is ${fmt(hypotenuse)}, so give "c": ${fmt(hypotenuse)} or leave "c" out`);
    }
    c = hypotenuse;
  } else {
    const leg = (a ?? b)!;
    const hypotenuse = c!;
    if (hypotenuse <= leg) fail(`${objectId}: the hypotenuse c is the longest side, so c must be bigger than the leg; got c = ${fmt(hypotenuse)} and a leg of ${fmt(leg)}`);
    const other = Math.sqrt(hypotenuse * hypotenuse - leg * leg);
    if (a === undefined) a = other;
    else b = other;
  }
  const lengths = { a: a!, b: b!, c: c! };
  return {
    figure: "triangle", objectId, numerals, lengths, unit: triangleUnit(lengths.a, lengths.b),
    built: { a: false, b: false, c: false }, filled: { a: 0, b: 0, c: 0 }, combined: false,
  };
}

const triangle: Figure<TriangleState> = {
  spec: {
    a: 'leg along the bottom, a positive number; give two of "a", "b", "c"',
    b: "leg up the left side, a positive number",
    c: "hypotenuse, a positive number; computed when a and b are given, and checked against them if given too",
  },
  init: (spec, objectId, numerals) => readTriangle(spec, objectId, numerals),
  ops: {
    square: {
      doc: '{"side": "a"|"b"|"c"} (a list builds several, or on: ["tri[a]"]) grows a square outward from that side; its area is the side length squared',
      seconds: 1.4,
      run(state, op) {
        const sides = sidesOf(state, op);
        const again = sides.find((side) => state.built[side]);
        if (again) fail(`op "square" on ${state.objectId}: the square on side ${again} is already built`);
        return { ...state, built: { ...state.built, ...Object.fromEntries(sides.map((side) => [side, true])) } };
      },
      during(before, after, _op, progress) {
        const view = staticView(after);
        for (const side of SIDES) if (after.built[side] && !before.built[side]) view.growth[side] = progress;
        return drawTriangle(after, view);
      },
    },
    fill: {
      doc: 'same "side"; fills that square with unit squares one by one and counts them (whole-number sides up to 12); optional "to": n fills the first n of a single side',
      seconds: 2.4,
      run(state, op) {
        const sides = sidesOf(state, op);
        const filled = { ...state.filled };
        for (const side of sides) {
          requireCells(state, side, op);
          const total = cellTotal(state, side);
          const to = wholeArg(op, "to", 1, total, total);
          if (to <= state.filled[side]) fail(`op "fill" on ${state.objectId}: the square on side ${side} already has ${state.filled[side]} of its ${total} unit squares; "to" must be from ${state.filled[side] + 1} to ${total}`);
          filled[side] = to;
        }
        return { ...state, filled };
      },
      during(before, after, _op, progress) {
        const view = staticView(after);
        for (const side of SIDES) view.shown[side] = lerp(before.filled[side], after.filled[side], progress);
        return drawTriangle(after, view);
      },
    },
    combine: {
      doc: "slides every unit square of the squares on a and b into the square on c, where they fit exactly, because a² + b² = c²; needs a and b filled and c built",
      seconds: 3.2,
      run(state, op) {
        for (const side of SIDES) requireCells(state, side, op);
        for (const side of ["a", "b"] as const) {
          if (state.filled[side] < cellTotal(state, side)) fail(`op "combine" on ${state.objectId}: fill the square on side ${side} first, it has ${state.filled[side]} of ${cellTotal(state, side)} unit squares`);
        }
        if (state.combined) fail(`op "combine" on ${state.objectId}: the squares on a and b are already inside the square on c`);
        return { ...state, combined: true };
      },
      during(_before, after, _op, progress) {
        return drawTriangle(after, { ...staticView(after), combine: progress });
      },
    },
  },
  size(state) {
    const { min, max } = triangleExtent(state);
    return { w: max.x - min.x, h: max.y - min.y };
  },
  draw: (state) => drawTriangle(state, staticView(state)),
};


interface RearrangeState extends Base {
  figure: "rearrange";
  a: number;
  b: number;
  arrangement: Arrangement;
}

interface Pose {
  corner: Point;
  direction: Point;
}

const PROOF_SIDE = 520;
const PROOF_LABEL_BAND = 54;
const PROOF_SUM_BAND = 70;
const MOVE_ORDER = [3, 0, 2, 1];
const HOLE_FADE = 0.15;

function poses(state: RearrangeState, arrangement: Arrangement): Pose[] {
  const { a, b } = state;
  const s = a + b;
  const corners = arrangement === "frame"
    ? [[0, 0, 1, 0], [s, 0, 0, 1], [s, s, -1, 0], [0, s, 0, -1]]
    : [[0, a, 1, 0], [s, 0, 0, 1], [a, s, -1, 0], [a, a, 0, -1]];
  return corners.map(([x, y, dx, dy]) => ({ corner: { x: x!, y: y! }, direction: { x: dx!, y: dy! } }));
}

const proofUnit = (state: RearrangeState) => PROOF_SIDE / (state.a + state.b);
const proofTop = (state: RearrangeState) => (state.numerals ? PROOF_LABEL_BAND : 0);
const proofPoint = (state: RearrangeState, at: Point): Point => ({ x: at.x * proofUnit(state), y: proofTop(state) + at.y * proofUnit(state) });

function pieceDrawables(state: RearrangeState, index: number, corner: Point, direction: Point): Drawable[] {
  const u = proofUnit(state);
  const at = proofPoint(state, corner);
  const rotation = (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
  const turned = { x: at.x, y: at.y, rotation };
  return [
    { id: `piece-${index}`, kind: "path", ...turned, points: [at.x, at.y, at.x + state.a * u, at.y, at.x, at.y + state.b * u], closed: true, fill: "fill2", stroke: "ink", strokeWidth: 2.5, z: 3 },
    { id: `piece-${index}-a`, kind: "line", ...turned, x2: at.x + state.a * u, y2: at.y, stroke: SIDE_ROLE.a, strokeWidth: 6, z: 4 },
    { id: `piece-${index}-b`, kind: "line", ...turned, x2: at.x, y2: at.y + state.b * u, stroke: SIDE_ROLE.b, strokeWidth: 6, z: 4 },
  ];
}

function holeDrawables(state: RearrangeState, opacity: Record<"a" | "b" | "c", number>): Drawable[] {
  const { a, b } = state;
  const s = a + b;
  const u = proofUnit(state);
  const hypotenuseHole = [[a, 0], [s, a], [b, s], [0, b]].flatMap(([x, y]) => {
    const point = proofPoint(state, { x: x!, y: y! });
    return [point.x, point.y];
  });
  const squareHole = (side: "a" | "b", from: number): Drawable => {
    const length = side === "a" ? a : b;
    const center = proofPoint(state, { x: from + length / 2, y: from + length / 2 });
    return box(`hole-${side}`, center.x, center.y, length * u, length * u, { fill: SIDE_ROLE[side], stroke: SIDE_ROLE[side], strokeWidth: 3, opacity: 0.4 * opacity[side], z: 1 });
  };
  const out: Drawable[] = [
    { id: "hole-c", kind: "path", x: 0, y: 0, points: hypotenuseHole, closed: true, fill: SIDE_ROLE.c, stroke: SIDE_ROLE.c, strokeWidth: 3, opacity: 0.4 * opacity.c, z: 1 },
    squareHole("a", 0),
    squareHole("b", a),
  ];
  if (state.numerals) {
    const spots: [string, number, Point, number][] = [
      ["c", a * a + b * b, { x: s / 2, y: s / 2 }, Math.hypot(a, b)],
      ["a", a * a, { x: a / 2, y: a / 2 }, a],
      ["b", b * b, { x: a + b / 2, y: a + b / 2 }, b],
    ];
    for (const [side, value, center, length] of spots) {
      const at = proofPoint(state, center);
      out.push(text(`hole-${side}-area`, at.x, at.y, fmt(value), Math.min(72, Math.max(26, 0.5 * length * u)), "ink", { opacity: opacity[side as Side], z: 5 }));
    }
  }
  return out;
}

function drawProof(state: RearrangeState, placed: Pose[], opacity: Record<"a" | "b" | "c", number>): Drawable[] {
  const { a, b } = state;
  const u = proofUnit(state);
  const center = PROOF_SIDE / 2;
  const top = proofTop(state);
  const out: Drawable[] = [
    box("frame", center, top + PROOF_SIDE / 2, PROOF_SIDE, PROOF_SIDE, { fill: "fill", stroke: "ink", strokeWidth: 3, z: 0 }),
    ...placed.flatMap((pose, index) => pieceDrawables(state, index, pose.corner, pose.direction)),
    ...holeDrawables(state, opacity),
  ];
  if (state.numerals) {
    out.push(
      text("edge-a", (a * u) / 2, top - 36, fmt(a), 36, SIDE_ROLE.a),
      text("edge-b", (a + b / 2) * u, top - 36, fmt(b), 36, SIDE_ROLE.b),
      text("edge-sum", center, top + PROOF_SIDE + 46, `${fmt(a)} + ${fmt(b)} = ${fmt(a + b)}`, 36, "muted"),
    );
  }
  return out;
}

const holeOpacity = (arrangement: Arrangement) => (arrangement === "frame" ? { a: 0, b: 0, c: 1 } : { a: 1, b: 1, c: 0 });

const rearrange: Figure<RearrangeState> = {
  spec: {
    a: "one leg of the right triangle, a positive number",
    b: "the other leg, a positive number; four copies of the triangle sit inside a square of side a + b",
    arrangement: '"frame" (default): the four triangles circle a tilted square of side c; "squares": they leave a square of side a and a square of side b',
  },
  init(spec, objectId, numerals) {
    const a = positiveField(spec, "a", objectId);
    const b = positiveField(spec, "b", objectId);
    if (a === undefined || b === undefined) fail(`${objectId}: figure "rearrange" needs both legs "a" and "b" as positive numbers`);
    const arrangement = spec.arrangement ?? "frame";
    if (arrangement !== "frame" && arrangement !== "squares") fail(`${objectId}: "arrangement" must be "frame" or "squares", got ${JSON.stringify(arrangement)}`);
    return { figure: "rearrange", objectId, numerals, a, b, arrangement };
  },
  ops: {
    arrange: {
      doc: '{"into": "frame"|"squares"} slides the four triangles to the other arrangement; the left over area is c² in "frame" and a² + b² in "squares"',
      seconds: 3.6,
      run(state, op) {
        const into = op.args.into;
        if (into !== "frame" && into !== "squares") fail(`op "arrange" on ${state.objectId} needs "into" as "frame" or "squares", got ${JSON.stringify(into)}`);
        if (into === state.arrangement) fail(`op "arrange" on ${state.objectId}: the triangles are already in the "${into}" arrangement; use "${into === "frame" ? "squares" : "frame"}"`);
        return { ...state, arrangement: into };
      },
      during(before, after, _op, progress) {
        const from = poses(before, before.arrangement);
        const to = poses(after, after.arrangement);
        const moving = MOVE_ORDER.filter((index) => from[index]!.corner.x !== to[index]!.corner.x || from[index]!.corner.y !== to[index]!.corner.y);
        const slot = 0.7 / Math.max(1, moving.length);
        const placed = from.map((pose, index) => {
          const order = moving.indexOf(index);
          const t = order < 0 ? 0 : ease((progress - HOLE_FADE - order * slot) / slot);
          return { corner: mix(pose.corner, to[index]!.corner, t), direction: pose.direction };
        });
        const start = holeOpacity(before.arrangement);
        const end = holeOpacity(after.arrangement);
        const opacity = { a: 0, b: 0, c: 0 };
        for (const side of ["a", "b", "c"] as const) {
          opacity[side] = start[side] === end[side] ? start[side] : start[side] > end[side] ? 1 - clamp01(progress / HOLE_FADE) : clamp01((progress - 1 + HOLE_FADE) / HOLE_FADE);
        }
        return drawProof(after, placed, opacity);
      },
    },
  },
  size: (state) => ({ w: PROOF_SIDE, h: proofTop(state) + PROOF_SIDE + (state.numerals ? PROOF_SUM_BAND : 0) }),
  draw: (state) => drawProof(state, poses(state, state.arrangement), holeOpacity(state.arrangement)),
};


type ShapesState = BlocksState | LineState | FractionState | AreaState | AngleState | TriangleState | RearrangeState;

const FIGURES = { blocks, line, fraction, area, angle, triangle, rearrange } as unknown as Record<ShapesState["figure"], Figure<ShapesState>>;
const FIGURE_NAMES = Object.keys(FIGURES);

const figureOf = (state: ShapesState) => FIGURES[state.figure];

function opDocs(): Record<string, string> {
  const docs: Record<string, string[]> = {};
  for (const [name, figure] of Object.entries(FIGURES)) {
    for (const [op, def] of Object.entries(figure.ops)) (docs[op] ??= []).push(`${name}: ${def.doc}`);
  }
  return Object.fromEntries(Object.entries(docs).map(([op, texts]) => [op, texts.join(" | ")]));
}

function opSeconds(name: string): number {
  for (const figure of Object.values(FIGURES)) {
    const def = figure.ops[name];
    if (def) return def.seconds;
  }
  return 0.8;
}

function opOf(state: ShapesState, name: string): OpDef<ShapesState> {
  const def = figureOf(state).ops[name];
  if (!def) {
    const own = Object.keys(figureOf(state).ops).join(", ");
    return fail(`op "${name}" does not fit the "${state.figure}" figure on ${state.objectId}; this figure knows: ${own}`);
  }
  return def;
}

export const lab: LabDef<SpecFields, ShapesState> = {
  id: "shapes",
  title: "Numbers and shapes",
  catalog: {
    summary: "Counting, number lines, fractions, area and right triangles, from a first count to Pythagoras. One object is one figure, chosen by \"figure\"; every number (counts, areas, side lengths) is computed here. Set \"numerals\": false for a small child: every figure then reads from pictures alone.",
    spec: {
      figure: `one of ${FIGURE_NAMES.join(", ")}`,
      numerals: "optional, default true; false draws pictures and groups with no text at all",
      ...Object.fromEntries(Object.entries(FIGURES).map(([name, figure]) => [`figure "${name}"`, Object.entries(figure.spec).map(([field, doc]) => `${field}: ${doc}`).join("; ")])),
    },
    ops: opDocs(),
    example: [
      '{"step":1,"say":"Here is a right triangle with sides three and four. Build the square on the short side, then count it.","scene":{"tri":{"lab":"shapes","figure":"triangle","a":3,"b":4}},"do":[{"cue":"Build the square","op":"square","on":["tri"],"side":"a"},{"cue":"count it","op":"fill","on":["tri"],"side":"a"}]}',
    ],
  },

  init(spec, objectId) {
    const name = spec.figure;
    if (typeof name !== "string" || !(name in FIGURES)) fail(`${objectId}: "figure" must be one of ${FIGURE_NAMES.join(", ")}, got ${JSON.stringify(name)}`);
    const figure = FIGURES[name as ShapesState["figure"]];
    const known = [...Object.keys(figure.spec), "numerals"];
    const unknown = Object.keys(spec).filter((key) => key !== "lab" && key !== "figure" && !known.includes(key));
    if (unknown.length > 0) fail(`${objectId}: figure "${name}" has no field ${unknown.map((key) => `"${key}"`).join(", ")}; its fields are ${known.join(", ")}`);
    const numerals = spec.numerals ?? true;
    if (typeof numerals !== "boolean") fail(`${objectId}: "numerals" must be true or false`);
    return figure.init(spec, objectId, numerals);
  },

  apply: (state, op) => ({ ...opOf(state, op.name).run(state, op) }),

  size: (state) => figureOf(state).size(state),

  draw: (state) => figureOf(state).draw(state),

  duration: (op) => opSeconds(op.name),

  during: (before, after, op, progress) => figureOf(after).ops[op.name]?.during?.(before, after, op, progress) ?? [],
};
