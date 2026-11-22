import { boxDrawable, clamp01, type Drawable, fail, integerField, type LabDef, type LabOp, lerp, type Point, type Rect, type Role, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

type Kind = "battery" | "resistor" | "lamp" | "switch";
type Quantity = "voltage" | "current";

interface Part {
  name: string;
  kind: Kind;
  slot: number;
  value: number;
  closed: boolean;
}

interface Meter {
  part: string;
  what: Quantity;
}

interface CircuitState {
  objectId: string;
  reading: boolean;
  slots: number;
  parts: Part[];
  wires: boolean[];
  switchAngles: Record<string, number>;
  meters: Meter[];
  flowing: boolean;
  showBreaks: boolean;
}

interface CircuitSpec {
  slots?: unknown;
  parts?: unknown;
  wired?: unknown;
  reading?: unknown;
}

interface Frame {
  center: Point;
  along: Point;
  out: Point;
}

interface Side {
  start: Point;
  along: Point;
  out: Point;
  length: number;
}

interface RatedValue {
  key: string;
  fallback: number;
  min: number;
  max: number;
  unit: string;
}

interface KindRule {
  color: Role;
  rated: RatedValue | null;
  symbol(frame: Frame, part: Part, look: SymbolLook): Drawable[];
}

interface SymbolLook {
  id: string;
  part: string;
  lit: boolean;
  bladeAngle: number;
}

const WIDTH = 1480;
const HEIGHT = 780;
const LOOP: Rect = { x: 150, y: 120, w: 1180, h: 540 };
const PERIMETER = 2 * (LOOP.w + LOOP.h);
const PART_LENGTH = 220;
const PART_DEPTH = 120;
const MAX_SLOTS = 6;
const MIN_SLOTS = 2;
const DEFAULT_SLOTS = 4;

const WIRE_WIDTH = 5;
const GUIDE_WIDTH = 2;
const TERMINAL_RADIUS = 8;
const LEAD_WIDTH = 5;
const SYMBOL_WIDTH = 5;

const BATTERY_PLATE_GAP = 14;
const BATTERY_LONG_PLATE = 80;
const BATTERY_SHORT_PLATE = 50;
const RESISTOR_HALF = 72;
const RESISTOR_TEETH = 6;
const RESISTOR_AMPLITUDE = 26;
const LAMP_RADIUS = 42;
const LAMP_GLOW_RADIUS = 58;
const LAMP_GLOW_OPACITY = 0.45;
const SWITCH_HALF = 50;
const SWITCH_CONTACT_RADIUS = 9;
const SWITCH_OPEN_ANGLE = 0.6;

const LABEL_GAP = 18;
const NAME_SIZE = 32;
const RATING_SIZE = 28;
const LINE_GAP = 16;
const TAG_GAP = 32;
const TAG_SIZE = 30;
const TAG_PADDING = 20;
const TAG_HEIGHT = 56;
const DIAL_WIDTH = 100;
const DIAL_HEIGHT = 64;
const DIAL_RADIUS = 38;
const DIAL_STEPS = 12;

const DOT_COUNT = 38;
const DOT_SPACING = PERIMETER / DOT_COUNT;
const DOT_RADIUS = 9;
const DOT_ADVANCE = 6;
const FRONT_SHARE = 0.55;
const BREAK_RADIUS = 38;
const BREAK_PULSE = 10;
const OPEN_SWITCH_STROKE = 4;

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,11}$/;
const PART_EXAMPLE = '{"name":"lamp","kind":"lamp","ohms":20}';

const SIDES: Side[] = [
  { start: { x: LOOP.x, y: LOOP.y }, along: { x: 1, y: 0 }, out: { x: 0, y: -1 }, length: LOOP.w },
  { start: { x: LOOP.x + LOOP.w, y: LOOP.y }, along: { x: 0, y: 1 }, out: { x: 1, y: 0 }, length: LOOP.h },
  { start: { x: LOOP.x + LOOP.w, y: LOOP.y + LOOP.h }, along: { x: -1, y: 0 }, out: { x: 0, y: 1 }, length: LOOP.w },
  { start: { x: LOOP.x, y: LOOP.y + LOOP.h }, along: { x: 0, y: -1 }, out: { x: -1, y: 0 }, length: LOOP.h },
];

const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;
const THIRD = 1 / 3;

const SLOT_PLACES: Record<number, [side: number, share: number][]> = {
  2: [
    [LEFT, 0.5],
    [RIGHT, 0.5],
  ],
  3: [
    [LEFT, 0.5],
    [TOP, 0.5],
    [RIGHT, 0.5],
  ],
  4: [
    [LEFT, 0.5],
    [TOP, 0.5],
    [RIGHT, 0.5],
    [BOTTOM, 0.5],
  ],
  5: [
    [LEFT, 0.5],
    [TOP, THIRD],
    [TOP, 2 * THIRD],
    [RIGHT, 0.5],
    [BOTTOM, 0.5],
  ],
  6: [
    [LEFT, 0.5],
    [TOP, THIRD],
    [TOP, 2 * THIRD],
    [RIGHT, 0.5],
    [BOTTOM, THIRD],
    [BOTTOM, 2 * THIRD],
  ],
};

function add(a: Point, b: Point, scale = 1): Point {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale };
}

function local(frame: Frame, u: number, v: number): Point {
  return add(add(frame.center, frame.along, u), frame.out, v);
}

function sideStartDistance(side: number): number {
  return SIDES.slice(0, side).reduce((sum, entry) => sum + entry.length, 0);
}

function wrap(distance: number): number {
  return ((distance % PERIMETER) + PERIMETER) % PERIMETER;
}

function sideAt(distance: number): { side: Side; offset: number } {
  let offset = wrap(distance);
  for (const side of SIDES) {
    if (offset < side.length) return { side, offset };
    offset -= side.length;
  }
  return { side: SIDES[0]!, offset: 0 };
}

function pointAt(distance: number): Point {
  const { side, offset } = sideAt(distance);
  return add(side.start, side.along, offset);
}

function slotDistance(state: CircuitState, slot: number): number {
  const [side, share] = SLOT_PLACES[state.slots]![slot]!;
  return sideStartDistance(side) + share * SIDES[side]!.length;
}

function slotFrame(state: CircuitState, slot: number): Frame {
  const distance = slotDistance(state, slot);
  const { side } = sideAt(distance);
  return { center: pointAt(distance), along: side.along, out: side.out };
}

function slotRect(frame: Frame): Rect {
  const w = Math.abs(frame.along.x) * PART_LENGTH + Math.abs(frame.out.x) * PART_DEPTH;
  const h = Math.abs(frame.along.y) * PART_LENGTH + Math.abs(frame.out.y) * PART_DEPTH;
  return { x: frame.center.x - w / 2, y: frame.center.y - h / 2, w, h };
}

function gapSpan(state: CircuitState, gap: number): { from: number; to: number } {
  const from = slotDistance(state, gap) + PART_LENGTH / 2;
  const next = slotDistance(state, (gap + 1) % state.slots) - PART_LENGTH / 2;
  return { from, to: next > from ? next : next + PERIMETER };
}

function pathBetween(from: number, to: number): Point[] {
  const corners = SIDES.flatMap((_, side) => [sideStartDistance(side), sideStartDistance(side) + PERIMETER]).filter((corner) => corner > from && corner < to);
  return [from, ...corners.sort((a, b) => a - b), to].map(pointAt);
}

function pathDrawable(id: string, points: Point[], stroke: Role, strokeWidth: number, z: number): Drawable {
  const first = points[0]!;
  return { id, kind: "path", x: first.x, y: first.y, points: points.flatMap((point) => [point.x, point.y]), closed: false, fill: "none", stroke, strokeWidth, z };
}

function lineDrawable(id: string, from: Point, to: Point, stroke: Role, strokeWidth: number, z: number, part?: string): Drawable {
  return { id, kind: "line", x: from.x, y: from.y, x2: to.x, y2: to.y, stroke, strokeWidth, z, part };
}

function circleDrawable(id: string, at: Point, r: number, look: Partial<Drawable>): Drawable {
  return { id, kind: "circle", x: at.x, y: at.y, r, ...look };
}

function leads(frame: Frame, inner: number, look: SymbolLook): Drawable[] {
  return [
    lineDrawable(`${look.id}-lead-a`, local(frame, -PART_LENGTH / 2, 0), local(frame, -inner, 0), "ink", LEAD_WIDTH, 5, look.part),
    lineDrawable(`${look.id}-lead-b`, local(frame, inner, 0), local(frame, PART_LENGTH / 2, 0), "ink", LEAD_WIDTH, 5, look.part),
  ];
}

function batterySymbol(frame: Frame, part: Part, look: SymbolLook): Drawable[] {
  const color = KINDS[part.kind].color;
  return [
    ...leads(frame, BATTERY_PLATE_GAP, look),
    lineDrawable(`${look.id}-plus`, local(frame, BATTERY_PLATE_GAP, -BATTERY_LONG_PLATE / 2), local(frame, BATTERY_PLATE_GAP, BATTERY_LONG_PLATE / 2), color, SYMBOL_WIDTH, 5, look.part),
    lineDrawable(`${look.id}-minus`, local(frame, -BATTERY_PLATE_GAP, -BATTERY_SHORT_PLATE / 2), local(frame, -BATTERY_PLATE_GAP, BATTERY_SHORT_PLATE / 2), color, SYMBOL_WIDTH * 2, 5, look.part),
  ];
}

function resistorSymbol(frame: Frame, part: Part, look: SymbolLook): Drawable[] {
  const step = (RESISTOR_HALF * 2) / (RESISTOR_TEETH * 2);
  const teeth = Array.from({ length: RESISTOR_TEETH * 2 - 1 }, (_, index) => local(frame, -RESISTOR_HALF + step * (index + 1), index % 2 === 0 ? RESISTOR_AMPLITUDE : -RESISTOR_AMPLITUDE));
  const zigzag = [local(frame, -RESISTOR_HALF, 0), ...teeth, local(frame, RESISTOR_HALF, 0)];
  return [...leads(frame, RESISTOR_HALF, look), { ...pathDrawable(`${look.id}-zigzag`, zigzag, KINDS[part.kind].color, SYMBOL_WIDTH, 5), part: look.part }];
}

function lampSymbol(frame: Frame, part: Part, look: SymbolLook): Drawable[] {
  const reach = LAMP_RADIUS / Math.SQRT2;
  const bulb = circleDrawable(`${look.id}-bulb`, frame.center, LAMP_RADIUS, {
    fill: look.lit ? "highlight" : "fill",
    stroke: look.lit ? "active" : KINDS[part.kind].color,
    strokeWidth: SYMBOL_WIDTH,
    z: 5,
    part: look.part,
  });
  const glow = circleDrawable(`${look.id}-glow`, frame.center, LAMP_GLOW_RADIUS, { fill: "highlight", stroke: "none", opacity: look.lit ? LAMP_GLOW_OPACITY : 0, z: 4 });
  return [
    ...leads(frame, LAMP_RADIUS, look),
    glow,
    bulb,
    lineDrawable(`${look.id}-cross-a`, local(frame, -reach, -reach), local(frame, reach, reach), "ink", 3, 6, look.part),
    lineDrawable(`${look.id}-cross-b`, local(frame, -reach, reach), local(frame, reach, -reach), "ink", 3, 6, look.part),
  ];
}

function switchSymbol(frame: Frame, part: Part, look: SymbolLook): Drawable[] {
  const color = KINDS[part.kind].color;
  const hinge = local(frame, -SWITCH_HALF, 0);
  const reach = SWITCH_HALF * 2 - SWITCH_CONTACT_RADIUS;
  const tip = add(add(hinge, frame.along, reach * Math.cos(look.bladeAngle)), frame.out, reach * Math.sin(look.bladeAngle));
  return [
    ...leads(frame, SWITCH_HALF, look),
    lineDrawable(`${look.id}-blade`, hinge, tip, color, SYMBOL_WIDTH, 6, look.part),
    circleDrawable(`${look.id}-hinge`, hinge, SWITCH_CONTACT_RADIUS, { fill: color, stroke: "none", z: 7, part: look.part }),
    circleDrawable(`${look.id}-contact`, local(frame, SWITCH_HALF, 0), SWITCH_CONTACT_RADIUS, { fill: "fill", stroke: color, strokeWidth: 3, z: 7, part: look.part }),
  ];
}

const KINDS: Record<Kind, KindRule> = {
  battery: { color: "series1", rated: { key: "volts", fallback: 9, min: 0.5, max: 1000, unit: "V" }, symbol: batterySymbol },
  resistor: { color: "series2", rated: { key: "ohms", fallback: 100, min: 0.1, max: 1e6, unit: "Ω" }, symbol: resistorSymbol },
  lamp: { color: "series3", rated: { key: "ohms", fallback: 20, min: 0.1, max: 1e6, unit: "Ω" }, symbol: lampSymbol },
  switch: { color: "series4", rated: null, symbol: switchSymbol },
};

const KIND_NAMES = Object.keys(KINDS).join(", ");
const QUANTITY_UNITS: Record<Quantity, string> = { voltage: "V", current: "A" };

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && Object.hasOwn(KINDS, value);
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean, where: string): boolean {
  const value = raw[key] ?? fallback;
  if (typeof value !== "boolean") fail(`${where}: "${key}" must be true or false`);
  return value;
}

function readRated(raw: Record<string, unknown>, rated: RatedValue, where: string): number {
  const value = raw[rated.key] ?? rated.fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < rated.min || value > rated.max) {
    fail(`${where}: "${rated.key}" must be a number from ${rated.min} to ${rated.max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function readPart(raw: unknown, slot: number, where: string): Part {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${where} must be an object such as ${PART_EXAMPLE}`);
  const entry = raw as Record<string, unknown>;
  const { name, kind } = entry;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) fail(`${where} needs a "name" of 1 to 12 letters or digits starting with a letter, such as "lamp" or "R1"`);
  if (!isKind(kind)) fail(`${where}: "kind" must be one of ${KIND_NAMES}, got ${JSON.stringify(kind)}`);
  const rated = KINDS[kind].rated;
  return {
    name,
    kind,
    slot,
    value: rated ? readRated(entry, rated, where) : 0,
    closed: kind === "switch" ? readBoolean(entry, "closed", false, where) : true,
  };
}

function freeSlot(state: CircuitState, wanted: unknown, where: string): number {
  const taken = state.parts.map((part) => part.slot);
  if (wanted === undefined) {
    const slot = Array.from({ length: state.slots }, (_, index) => index).find((index) => !taken.includes(index));
    if (slot === undefined) fail(`${where}: every one of the ${state.slots} slots of ${state.objectId} is full; set "slots" higher in the object spec`);
    return slot;
  }
  if (typeof wanted !== "number" || !Number.isInteger(wanted) || wanted < 0 || wanted >= state.slots) fail(`${where}: "slot" must be a whole number from 0 to ${state.slots - 1}`);
  const holder = state.parts.find((part) => part.slot === wanted);
  if (holder) fail(`${where}: slot ${wanted} already holds "${holder.name}"; pick an empty slot or leave "slot" out`);
  return wanted;
}

function withPart(state: CircuitState, raw: unknown, where: string): CircuitState {
  const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const part = readPart(raw, freeSlot(state, entry.slot, where), where);
  if (state.parts.some((other) => other.name === part.name)) fail(`${where}: ${state.objectId} already has a part named "${part.name}"; give it another name`);
  const switchAngles = part.kind === "switch" ? { ...state.switchAngles, [part.name]: bladeAngle(part.closed) } : state.switchAngles;
  return { ...state, parts: [...state.parts, part], switchAngles };
}

function bladeAngle(closed: boolean): number {
  return closed ? 0 : SWITCH_OPEN_ANGLE;
}

function readReading(spec: CircuitSpec, objectId: string): boolean {
  if (spec.reading !== undefined && typeof spec.reading !== "boolean") fail(`${objectId}: "reading" must be true or false`);
  return spec.reading !== false;
}

function partList(spec: CircuitSpec, objectId: string): unknown[] {
  if (spec.parts === undefined) return [];
  if (!Array.isArray(spec.parts)) fail(`${objectId}: "parts" must be a list such as [${PART_EXAMPLE}]`);
  return spec.parts;
}

function partNamed(state: CircuitState, raw: string, opName: string): Part {
  const match = new RegExp(`^${state.objectId}(?:\\[(.+)\\]|\\.(.+))$`).exec(raw);
  const name = match?.[1] ?? match?.[2] ?? raw;
  const part = state.parts.find((entry) => entry.name === name);
  if (!part) {
    const known = state.parts.map((entry) => `${state.objectId}[${entry.name}]`).join(", ") || "none yet; place one first";
    fail(`op "${opName}": ${raw} is not a part of ${state.objectId}; parts are ${known}`);
  }
  return part;
}

function partsOf(state: CircuitState, op: LabOp): Part[] {
  return op.parts.filter((raw) => raw !== state.objectId).map((raw) => partNamed(state, raw, op.name));
}

function onePart(state: CircuitState, op: LabOp, example: string): Part {
  const parts = partsOf(state, op);
  if (parts.length !== 1) fail(`op "${op.name}" needs exactly one part in "on", such as ["${state.objectId}[${example}]"]`);
  return parts[0]!;
}

function partInSlot(state: CircuitState, slot: number): Part | undefined {
  return state.parts.find((part) => part.slot === slot);
}

function gapIsJoinable(state: CircuitState, gap: number): boolean {
  return Boolean(partInSlot(state, gap) && partInSlot(state, (gap + 1) % state.slots));
}

function gapsBetween(state: CircuitState, first: Part, second: Part): number[] {
  return state.wires
    .map((_, gap) => gap)
    .filter((gap) => {
      const ends = [gap, (gap + 1) % state.slots];
      return ends.includes(first.slot) && ends.includes(second.slot) && first.slot !== second.slot;
    });
}

function wireGaps(state: CircuitState, op: LabOp): number[] {
  const parts = partsOf(state, op);
  if (parts.length === 0) {
    const open = state.wires.map((_, gap) => gap).filter((gap) => !state.wires[gap] && gapIsJoinable(state, gap));
    if (open.length === 0) fail(`op "wire": ${state.objectId} has no two neighbouring parts left to join; place more parts first`);
    return open;
  }
  if (parts.length !== 2) fail(`op "wire" needs two neighbouring parts in "on", such as ["${state.objectId}[battery]","${state.objectId}[lamp]"], or only "${state.objectId}" to join every neighbour`);
  const [first, second] = parts as [Part, Part];
  const gaps = gapsBetween(state, first, second);
  if (gaps.length === 0) fail(`op "wire": ${first.name} (slot ${first.slot}) and ${second.name} (slot ${second.slot}) are not neighbours on the loop; wire each part to the one in the next slot`);
  const gap = gaps.find((candidate) => !state.wires[candidate]);
  if (gap === undefined) fail(`op "wire": ${first.name} and ${second.name} are already wired`);
  return [gap];
}

function withWires(state: CircuitState, gaps: number[]): CircuitState {
  return { ...state, wires: state.wires.map((wired, gap) => wired || gaps.includes(gap)) };
}

interface Break {
  id: string;
  at: Point;
  part?: string;
}

function breaksOf(state: CircuitState): Break[] {
  const empty = Array.from({ length: state.slots }, (_, slot) => slot)
    .filter((slot) => !partInSlot(state, slot))
    .map((slot) => ({ id: `break-slot-${slot}`, at: slotFrame(state, slot).center }));
  const unwired = state.wires.flatMap((wired, gap) => {
    if (wired) return [];
    const { from, to } = gapSpan(state, gap);
    return [{ id: `break-gap-${gap}`, at: pointAt((from + to) / 2) }];
  });
  const open = state.parts.filter((part) => !part.closed).map((part) => ({ id: `break-${part.name}`, at: slotFrame(state, part.slot).center, part: part.name }));
  return [...empty, ...unwired, ...open];
}

function totalOf(state: CircuitState, kinds: Kind[]): number {
  return state.parts.filter((part) => kinds.includes(part.kind)).reduce((sum, part) => sum + part.value, 0);
}

function currentOf(state: CircuitState): number {
  if (!state.flowing) return 0;
  return totalOf(state, ["battery"]) / totalOf(state, ["resistor", "lamp"]);
}

function voltageOf(state: CircuitState, part: Part): number {
  if (part.kind === "battery") return part.value;
  if (part.kind === "switch") {
    const breaks = breaksOf(state);
    return breaks.length === 1 && breaks[0]!.id === `break-${part.name}` ? totalOf(state, ["battery"]) : 0;
  }
  return currentOf(state) * part.value;
}

function readingOf(state: CircuitState, meter: Meter, part: Part): number {
  return meter.what === "voltage" ? voltageOf(state, part) : currentOf(state);
}

function fullScale(state: CircuitState, what: Quantity): number {
  if (what === "voltage") return totalOf(state, ["battery"]);
  const resistance = totalOf(state, ["resistor", "lamp"]);
  return resistance > 0 ? totalOf(state, ["battery"]) / resistance : 0;
}

function formatNumber(value: number): string {
  return String(Number(value.toPrecision(3)));
}

function formatReading(value: number, what: Quantity): string {
  if (what === "current" && value > 0 && value < 1) return `${formatNumber(value * 1000)} mA`;
  return `${formatNumber(value)} ${QUANTITY_UNITS[what]}`;
}

function ratingText(part: Part): string {
  const rated = KINDS[part.kind].rated;
  if (!rated) return part.closed ? "closed" : "open";
  return `${formatNumber(part.value)} ${rated.unit}`;
}

function inwardBox(frame: Frame, offset: number, w: number, h: number): Rect {
  const inward = { x: -frame.out.x, y: -frame.out.y };
  const extent = Math.abs(inward.x) * w + Math.abs(inward.y) * h;
  const center = add(frame.center, inward, PART_DEPTH / 2 + offset + extent / 2);
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}

function inwardExtent(frame: Frame, rect: Rect): number {
  return Math.abs(frame.out.x) * rect.w + Math.abs(frame.out.y) * rect.h;
}

function labelBox(frame: Frame, part: Part): Rect {
  const w = Math.max(textWidth(part.name, NAME_SIZE, "mark"), textWidth(ratingText(part), RATING_SIZE, "read"));
  return inwardBox(frame, LABEL_GAP, w, NAME_SIZE + LINE_GAP + RATING_SIZE);
}

function nearEdge(frame: Frame, box: Rect): { x: number; anchor: "start" | "middle" | "end" } {
  if (frame.out.x < 0) return { x: box.x, anchor: "start" };
  if (frame.out.x > 0) return { x: box.x + box.w, anchor: "end" };
  return { x: box.x + box.w / 2, anchor: "middle" };
}

function labelDrawables(state: CircuitState, frame: Frame, part: Part): Drawable[] {
  if (!state.reading) return [];
  const box = labelBox(frame, part);
  const { x, anchor } = nearEdge(frame, box);
  const look = { z: 6, anchor, part: `${state.objectId}[${part.name}]` };
  return [
    textDrawable(`label-${part.name}-name`, part.name, { x, y: box.y + NAME_SIZE / 2 }, { size: NAME_SIZE, font: "mark", ...look }),
    textDrawable(`label-${part.name}-rating`, ratingText(part), { x, y: box.y + box.h - RATING_SIZE / 2 }, { size: RATING_SIZE, fill: "muted", ...look }),
  ];
}

function tagBox(frame: Frame, part: Part, w: number): Rect {
  const label = labelBox(frame, part);
  if (frame.along.x === 0) {
    const edge = nearEdge(frame, label);
    const x = edge.anchor === "start" ? edge.x : edge.x - w;
    return { x, y: label.y + label.h + TAG_GAP, w, h: TAG_HEIGHT };
  }
  return inwardBox(frame, LABEL_GAP + inwardExtent(frame, label) + TAG_GAP, w, TAG_HEIGHT);
}

function tagDrawables(state: CircuitState, frame: Frame, part: Part, meter: Meter): Drawable[] {
  const text = formatReading(readingOf(state, meter, part), meter.what);
  const box = tagBox(frame, part, textWidth(text, TAG_SIZE, "read") + TAG_PADDING * 2);
  return [
    boxDrawable(`meter-${part.name}-box`, box, { fill: "fill2", stroke: "accent", strokeWidth: 3, radius: 1, z: 6 }),
    textDrawable(`meter-${part.name}-value`, text, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, { size: TAG_SIZE, z: 7 }),
  ];
}

function dialDrawables(state: CircuitState, frame: Frame, part: Part, meter: Meter): Drawable[] {
  const box = inwardBox(frame, LABEL_GAP, DIAL_WIDTH, DIAL_HEIGHT);
  const pivot = { x: box.x + box.w / 2, y: box.y + box.h - (box.h - DIAL_RADIUS) / 2 };
  const scale = fullScale(state, meter.what);
  const share = scale > 0 ? clamp01(readingOf(state, meter, part) / scale) : 0;
  const onArc = (fraction: number, radius: number) => ({ x: pivot.x - radius * Math.cos(Math.PI * fraction), y: pivot.y - radius * Math.sin(Math.PI * fraction) });
  const arc = Array.from({ length: DIAL_STEPS + 1 }, (_, step) => onArc(step / DIAL_STEPS, DIAL_RADIUS));
  return [
    boxDrawable(`meter-${part.name}-box`, box, { fill: "fill2", stroke: "accent", strokeWidth: 3, radius: 1, z: 6 }),
    pathDrawable(`meter-${part.name}-arc`, arc, "accent", 3, 7),
    lineDrawable(`meter-${part.name}-needle`, pivot, onArc(share, DIAL_RADIUS - 6), "ink", 4, 8),
  ];
}

function meterDrawables(state: CircuitState): Drawable[] {
  return state.meters.flatMap((meter) => {
    const part = state.parts.find((entry) => entry.name === meter.part)!;
    const frame = slotFrame(state, part.slot);
    return state.reading ? tagDrawables(state, frame, part, meter) : dialDrawables(state, frame, part, meter);
  });
}

function bodyLook(state: CircuitState, part: Part): Partial<Drawable> {
  if (state.showBreaks && !part.closed) return { stroke: "fault", strokeWidth: OPEN_SWITCH_STROKE };
  return { stroke: "rule", strokeWidth: 1.5 };
}

function symbolDrawables(state: CircuitState, part: Part, look: Partial<SymbolLook> = {}): Drawable[] {
  const frame = slotFrame(state, part.slot);
  const id = `part-${part.name}`;
  const symbolLook: SymbolLook = { id, part: `${state.objectId}[${part.name}]`, lit: state.flowing, bladeAngle: state.switchAngles[part.name] ?? 0, ...look };
  return [
    boxDrawable(`${id}-body`, slotRect(frame), { fill: "fill2", radius: 1, z: 3, part: symbolLook.part, ...bodyLook(state, part) }),
    ...KINDS[part.kind].symbol(frame, part, symbolLook),
    circleDrawable(`${id}-terminal-a`, local(frame, -PART_LENGTH / 2, 0), TERMINAL_RADIUS, { fill: "ink", stroke: "none", z: 6 }),
    circleDrawable(`${id}-terminal-b`, local(frame, PART_LENGTH / 2, 0), TERMINAL_RADIUS, { fill: "ink", stroke: "none", z: 6 }),
  ];
}

function partDrawables(state: CircuitState, part: Part): Drawable[] {
  return [...symbolDrawables(state, part), ...labelDrawables(state, slotFrame(state, part.slot), part)];
}

function wireDrawables(state: CircuitState, grown: Record<number, number> = {}): Drawable[] {
  return state.wires.flatMap((wired, gap) => {
    const { from, to } = gapSpan(state, gap);
    const guide = pathDrawable(`guide-${gap}`, pathBetween(from, to), "rule", GUIDE_WIDTH, 1);
    if (!wired) return [guide];
    const end = lerp(from, to, grown[gap] ?? 1);
    return [guide, pathDrawable(`wire-${gap}`, pathBetween(from, end), "ink", WIRE_WIDTH, 2)];
  });
}

function breakDrawables(state: CircuitState, pulse = 0): Drawable[] {
  if (!state.showBreaks) return [];
  return breaksOf(state)
    .filter((entry) => !entry.part)
    .map((entry) => circleDrawable(entry.id, entry.at, BREAK_RADIUS + pulse * BREAK_PULSE, { fill: "none", stroke: "fault", strokeWidth: 4, z: 8 }));
}

function sourceDistance(state: CircuitState): number {
  const battery = state.parts.find((part) => part.kind === "battery")!;
  return slotDistance(state, battery.slot);
}

function dotDrawables(state: CircuitState, shift = 0, reach = PERIMETER): Drawable[] {
  if (!state.flowing) return [];
  const start = sourceDistance(state);
  const bodies = state.parts.map((part) => slotRect(slotFrame(state, part.slot)));
  return Array.from({ length: DOT_COUNT }, (_, index) => wrap(index * DOT_SPACING + shift)).flatMap((travelled, index) => {
    const at = pointAt(start + travelled);
    if (travelled > reach || bodies.some((body) => nearRect(body, at, DOT_RADIUS))) return [];
    return [circleDrawable(`dot-${index}`, at, DOT_RADIUS, { fill: "accent", stroke: "none", z: 7 })];
  });
}

function nearRect(rect: Rect, at: Point, margin: number): boolean {
  return at.x > rect.x - margin && at.x < rect.x + rect.w + margin && at.y > rect.y - margin && at.y < rect.y + rect.h + margin;
}

function boardDrawable(): Drawable {
  return boxDrawable("board", { x: 0, y: 0, w: WIDTH, h: HEIGHT }, { fill: "fill", stroke: "rule", strokeWidth: 2, radius: 1, z: 0 });
}

function place(state: CircuitState, op: LabOp): CircuitState {
  return withPart(state, op.args, `op "place"`);
}

function wire(state: CircuitState, op: LabOp): CircuitState {
  return withWires(state, wireGaps(state, op));
}

function flipSwitch(state: CircuitState, op: LabOp): CircuitState {
  const target = onePart(state, op, "switch");
  if (target.kind !== "switch") fail(`op "switch": ${target.name} is a ${target.kind}; only a switch opens and closes`);
  const closed = readBoolean(op.args, "closed", !target.closed, `op "switch"`);
  const parts = state.parts.map((part) => (part === target ? { ...part, closed } : part));
  const stopped = state.flowing && !closed;
  return {
    ...state,
    parts,
    switchAngles: { ...state.switchAngles, [target.name]: bladeAngle(closed) },
    flowing: closed && state.flowing,
    showBreaks: state.showBreaks || stopped,
  };
}

function flow(state: CircuitState): CircuitState {
  if (!state.parts.some((part) => part.kind === "battery")) fail(`op "flow": ${state.objectId} has no battery; place one with {"op":"place","kind":"battery","name":"battery"}`);
  const closed = breaksOf(state).length === 0;
  if (closed && totalOf(state, ["resistor", "lamp"]) === 0) fail(`op "flow": the loop of ${state.objectId} is a short circuit with nothing to resist the current; place a resistor or a lamp in it`);
  return { ...state, flowing: closed, showBreaks: !closed };
}

function measure(state: CircuitState, op: LabOp): CircuitState {
  const part = onePart(state, op, "lamp");
  const what = op.args.what ?? "voltage";
  const others = state.meters.filter((meter) => meter.part !== part.name);
  if (what === "none") return { ...state, meters: others };
  if (what !== "voltage" && what !== "current") fail(`op "measure": "what" must be "voltage", "current" or "none", got ${JSON.stringify(what)}`);
  return { ...state, meters: [...others, { part: part.name, what }] };
}

function wireDuring(before: CircuitState, after: CircuitState, _op: LabOp, progress: number): Drawable[] {
  const grown = Object.fromEntries(after.wires.flatMap((wired, gap) => (wired && !before.wires[gap] ? [[gap, clamp01(progress)]] : [])));
  return wireDrawables(after, grown);
}

function switchDuring(before: CircuitState, after: CircuitState, op: LabOp, progress: number): Drawable[] {
  const target = onePart(after, op, "switch");
  const angle = lerp(before.switchAngles[target.name] ?? 0, after.switchAngles[target.name] ?? 0, clamp01(progress));
  const shown = progress >= 1 ? after : { ...after, showBreaks: before.showBreaks };
  return symbolDrawables(shown, target, { bladeAngle: angle, lit: before.flowing && after.flowing });
}

function distanceFromSource(state: CircuitState, part: Part): number {
  return wrap(slotDistance(state, part.slot) - sourceDistance(state));
}

function flowDuring(_before: CircuitState, after: CircuitState, _op: LabOp, progress: number): Drawable[] {
  if (!after.flowing) return breakDrawables(after, Math.sin(Math.PI * clamp01(progress)));
  const reach = clamp01(progress / FRONT_SHARE) * PERIMETER;
  const lamps = after.parts.filter((part) => part.kind === "lamp").flatMap((part) => symbolDrawables(after, part, { lit: distanceFromSource(after, part) <= reach }));
  return [...lamps, ...dotDrawables(after, progress * DOT_SPACING * DOT_ADVANCE, reach)];
}

export const lab: LabDef<CircuitSpec, CircuitState> = {
  id: "circuit",
  title: "Circuit",
  reading: "optional",
  catalog: {
    summary:
      "A simple series circuit on a board: up to 6 parts (battery, resistor, lamp, switch) sit in slots around one loop, wires join each part to the next, and current flows as moving dots only when the loop is closed, lighting every lamp it reaches. Teaches parts, closed versus open loops, switches, and measuring volts and amps. Parts are named: c[lamp].",
    spec: {
      slots:
        "optional number of places around the loop, 2 to 6, default 4 (or the number of parts when more); slot 0 is on the left, and the slots run clockwise over the top, down the right and back along the bottom",
      parts:
        'optional list of parts already on the board, filling slots in order: {"name":"battery","kind":"battery","volts":9}; kind is battery (volts, default 9), resistor (ohms, default 100), lamp (ohms, default 20) or switch ("closed": true or false, default false); name is 1 to 12 letters or digits, such as "lamp" or "R1"; optional "slot" picks a free slot',
      wired: "optional true or false, default false; true starts with a wire between every pair of neighbouring parts",
      reading: "optional, default true; false draws no names, values or units, for a child who cannot read: a meter becomes a dial whose needle swings with the reading",
    },
    example: [
      '{"step":1,"say":"Here is a battery, a lamp and a switch, joined by wires. Close the switch and current flows around the loop, so the lamp lights.","scene":{"c":{"lab":"circuit","slots":3,"wired":true,"parts":[{"name":"battery","kind":"battery","volts":9},{"name":"lamp","kind":"lamp","ohms":30},{"name":"switch","kind":"switch"}]}},"do":[{"cue":"Close the switch","op":"switch","on":["c[switch]"],"closed":true},{"cue":"current flows","op":"flow","on":["c"]},{"cue":"lamp lights","op":"measure","on":["c[lamp]"],"what":"current"}]}',
    ],
  },

  init(spec, objectId) {
    const raw = partList(spec, objectId);
    const slots = integerField(spec as Record<string, unknown>, "slots", Math.max(DEFAULT_SLOTS, Math.min(MAX_SLOTS, raw.length)), MIN_SLOTS, MAX_SLOTS, objectId);
    if (raw.length > slots) fail(`${objectId}: ${raw.length} parts do not fit in ${slots} slots; set "slots" to at least ${raw.length} (at most ${MAX_SLOTS})`);
    const empty: CircuitState = {
      objectId,
      reading: readReading(spec, objectId),
      slots,
      parts: [],
      wires: Array.from({ length: slots }, () => false),
      switchAngles: {},
      meters: [],
      flowing: false,
      showBreaks: false,
    };
    const placed = raw.reduce((state: CircuitState, entry, index) => withPart(state, entry, `${objectId}: parts[${index}]`), empty);
    if (!readBoolean(spec as Record<string, unknown>, "wired", false, objectId)) return placed;
    return withWires(
      placed,
      placed.wires.map((_, gap) => gap).filter((gap) => gapIsJoinable(placed, gap)),
    );
  },

  ops: {
    place: {
      doc: '{"name": "lamp", "kind": "lamp", "ohms": 20, "slot": 1}; puts a new part in a slot of the loop; kind is battery (volts), resistor (ohms), lamp (ohms) or switch ("closed", default false); slot defaults to the first empty one',
      seconds: 0.8,
      apply: place,
    },
    wire: {
      doc: 'on two neighbouring parts, such as ["c[battery]","c[lamp]"], draws a wire between their terminals; on only "c", wires every pair of neighbouring parts not yet joined',
      seconds: 1.0,
      apply: wire,
      during: wireDuring,
    },
    switch: {
      doc: 'on one switch part, such as ["c[switch]"], with {"closed": true} to close it or {"closed": false} to open it; leaving "closed" out flips it; opening it stops any flow and rings the break',
      seconds: 0.7,
      apply: flipSwitch,
      during: switchDuring,
    },
    flow: {
      doc: 'on "c", no args; on a closed loop, current leaves the battery as dots that run around the whole loop and keep flowing, and each lamp lights as the dots reach it; on an open loop nothing flows and every break (an empty slot, a missing wire, an open switch) is ringed in the fault color',
      seconds: 3.2,
      apply: flow,
      during: flowDuring,
    },
    measure: {
      doc: 'on one part, such as ["c[lamp]"], with {"what": "voltage"} (default) or {"what": "current"}; shows a meter beside it with the value and unit (V, A or mA) worked out from the loop, which updates as the circuit changes; "none" removes it',
      seconds: 0.6,
      apply: measure,
    },
  },

  size() {
    return { w: WIDTH, h: HEIGHT };
  },

  draw(state) {
    return [
      boardDrawable(),
      ...wireDrawables(state),
      ...state.parts.flatMap((part) => partDrawables(state, part)),
      ...meterDrawables(state),
      ...breakDrawables(state),
      ...dotDrawables(state),
    ];
  },
};
