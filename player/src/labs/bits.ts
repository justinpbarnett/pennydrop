import { boxDrawable, clamp01, type Drawable, fail, fitText, integerArg, type LabDef, type LabOp, lerp, type Role, stringArg, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

type Order = "big" | "little";
type Mode = "ECB" | "CBC" | "CTR";
type SeedName = "iv" | "counter";

interface Byte {
  id: string;
  value: number;
}

interface Field {
  name: string;
  first: number;
  last: number;
  order: Order;
  color: Role;
}

interface RowView {
  kind: "row";
}

interface XorView {
  kind: "xor";
  key: number[];
}

interface ModeView {
  kind: "mode";
  mode: Mode;
  key: number;
  seed: number;
}

type View = RowView | XorView | ModeView;

interface BitsState {
  objectId: string;
  reading: boolean;
  bytes: Byte[];
  order: Order;
  fields: Field[];
  view: View;
}

interface BitsSpec {
  bytes?: unknown;
  order?: unknown;
  reading?: unknown;
}

interface Band {
  key: string;
  height: number;
  stretch: number;
}

interface Placed {
  top: number;
  height: number;
}

interface Stack {
  places: Map<string, Placed>;
  height: number;
}

interface Strip {
  left: number;
  cell: number;
  gap: number;
  count: number;
}

interface CellLook {
  on: Role;
  stroke: Role;
  strokeWidth: number;
}

interface LabelSpot {
  field: Field;
  text: string;
  center: number;
  stem: number;
  width: number;
  level: number;
}

interface ModeRule {
  header(view: ModeView): string;
  boxText(view: ModeView, block: number): string;
  encode(plain: number[], view: ModeView): number[];
  chained: boolean;
  seed: SeedName | null;
}

const SERIES: Role[] = ["series1", "series2", "series3", "series4", "series5", "series6"];
const BITS_PER_BYTE = 8;
const BYTE_MAX = 255;
const MAX_BYTES = 6;
const MAX_FIELDS = SERIES.length;
const PRINTABLE_FIRST = 32;
const PRINTABLE_LAST = 126;

const WIDTH = 1480;
const HEIGHT = 700;
const GAP_MIN = 16;
const GAP_PREFERRED = 28;
const GAP_MAX = 80;

const BYTE_GAP = 20;
const COLUMN_GAP = 64;
const CELL_MIN_HEIGHT = 56;
const CELL_MAX_BASE = 110;
const BIT_TEXT_MIN = 22;
const BIT_TEXT_MAX = 40;
const BIT_TEXT_SHARE = 0.62;
const TEXT_CLEAR = 12;
const CELL_INSET_MIN = 2;
const CELL_INSET_SPARE = 1;

const HEADER_SIZE = 34;
const HEADER_GROWTH = 14;
const HEADER_CLEAR = 24;
const OFFSET_SIZE = 24;
const OFFSET_GROWTH = 8;
const VALUE_SIZE = 30;
const VALUE_GROWTH = 12;
const LABEL_SIZE = 28;
const LABEL_PITCH = LABEL_SIZE + 20;
const LABEL_CLEAR = 16;
const LEADER_CLEAR = 12;

const ORDER_BAND = 26;
const ORDER_STROKE = 2.5;
const BRACKET_DEPTH = 16;
const BRACKET_STROKE = 3;
const BRACKET_INSET = 4;
const FIELD_CELL_STROKE = 2.5;

const XOR_GUTTER = 84;
const XOR_RADIUS = 22;
const SIGN_STROKE = 3;
const EQUALS_HALF = 18;
const EQUALS_SPREAD = 8;
const RULE_BAND = 4;

const ARROW_BAND = 72;
const ARROW_STROKE = 2.5;
const ARROW_START_GAP = 14;
const ARROW_TIP_GAP = 5;
const BOX_HEIGHT = 64;
const BOX_GROWTH = 24;
const BOX_PADDING = 18;
const BOX_SHARE = 0.62;
const BOX_TEXT_MAX = 30;
const IV_WORDLESS_WIDTH = 64;
const IV_ARROW_ROOM = 36;
const STEM_DROP = 22;
const FEEDBACK_STROKE = 3;
const FRAME_STROKE = 3;
const TAP_Z = 8;
const FLIP_ARC = 70;

const CIPHER_ROTATION = 3;
const CIPHER_OFFSET = 101;

const ROW_CELLS: CellLook = { on: "ink", stroke: "rule", strokeWidth: 1.5 };
const RESULT_CELLS: CellLook = { on: "active", stroke: "rule", strokeWidth: 1.5 };

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >> (BITS_PER_BYTE - shift))) & BYTE_MAX;
}

function blockCipher(value: number, key: number): number {
  return (rotateLeft(value ^ key, CIPHER_ROTATION) + CIPHER_OFFSET) & BYTE_MAX;
}

function counterAt(view: ModeView, block: number): number {
  return (view.seed + block) & BYTE_MAX;
}

function encodeCbc(plain: number[], view: ModeView): number[] {
  const cipher: number[] = [];
  plain.forEach((value, block) => cipher.push(blockCipher(value ^ (block === 0 ? view.seed : cipher[block - 1]!), view.key)));
  return cipher;
}

const MODES: Record<Mode, ModeRule> = {
  ECB: {
    header: (view) => `ECB mode, key ${view.key}`,
    boxText: () => "encrypt",
    encode: (plain, view) => plain.map((value) => blockCipher(value, view.key)),
    chained: false,
    seed: null,
  },
  CBC: {
    header: (view) => `CBC mode, key ${view.key}`,
    boxText: () => "encrypt",
    encode: encodeCbc,
    chained: true,
    seed: "iv",
  },
  CTR: {
    header: (view) => `CTR mode, key ${view.key}, counter from ${view.seed}`,
    boxText: (view, block) => `XOR E(${counterAt(view, block)})`,
    encode: (plain, view) => plain.map((value, block) => value ^ blockCipher(counterAt(view, block), view.key)),
    chained: false,
    seed: "counter",
  },
};

const MODE_NAMES = Object.keys(MODES) as Mode[];
const SEED_NAMES: SeedName[] = ["iv", "counter"];

function bitsOf(value: number): number[] {
  return Array.from({ length: BITS_PER_BYTE }, (_, index) => (value >> (BITS_PER_BYTE - 1 - index)) & 1);
}

function byteList(raw: unknown, subject: string): number[] {
  const expected = `${subject} must be a list of 1 to ${MAX_BYTES} whole numbers from 0 to ${BYTE_MAX}, or text of 1 to ${MAX_BYTES} plain characters, such as [72, 105] or "Hi"`;
  if (typeof raw === "string") {
    const codes = [...raw].map((character) => character.charCodeAt(0));
    if (codes.length === 0 || codes.length > MAX_BYTES || codes.some((code) => code < PRINTABLE_FIRST || code > PRINTABLE_LAST)) fail(expected);
    return codes;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BYTES) fail(expected);
  return raw.map((value, index) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > BYTE_MAX) fail(`${subject}[${index}] is ${JSON.stringify(value)}; ${expected}`);
    return value;
  });
}

function orderValue(raw: unknown, subject: string): Order {
  if (raw === undefined) return "big";
  if (raw !== "big" && raw !== "little") fail(`${subject} must be "big" or "little"`);
  return raw;
}

function readingFlag(raw: unknown, objectId: string): boolean {
  if (raw === undefined) return true;
  if (typeof raw !== "boolean") fail(`${objectId}: "reading" must be true or false`);
  return raw;
}

function bitCount(state: BitsState): number {
  return state.bytes.length * BITS_PER_BYTE;
}

function wholeObject(state: BitsState, op: LabOp): void {
  if (op.parts.length > 0) fail(`op "${op.name}" acts on the whole object: write "on": ["${state.objectId}"] and name bytes or fields in the args`);
}

function bitRange(state: BitsState, op: LabOp): [number, number] {
  const { bytes, bits } = op.args;
  if ((bytes === undefined) === (bits === undefined)) fail(`op "field" needs exactly one of "bytes": [first, last] or "bits": [first, last]`);
  const unit = bytes !== undefined ? "bytes" : "bits";
  const count = unit === "bytes" ? state.bytes.length : bitCount(state);
  const raw: unknown = bytes ?? bits;
  const ends = Array.isArray(raw) && raw.length === 2 && raw.every((end) => Number.isInteger(end) && end >= 0 && end < count) ? (raw as [number, number]) : null;
  if (!ends || ends[0] > ends[1]) fail(`op "field" needs "${unit}" as [first, last], two whole numbers from 0 to ${count - 1} with first no more than last, got ${JSON.stringify(raw)}`);
  const [first, last] = ends;
  return unit === "bytes" ? [first * BITS_PER_BYTE, (last + 1) * BITS_PER_BYTE - 1] : [first, last];
}

function byteAligned(field: Field): boolean {
  return field.first % BITS_PER_BYTE === 0 && (field.last + 1) % BITS_PER_BYTE === 0;
}

function fieldBytes(field: Field): number {
  return byteAligned(field) ? (field.last + 1 - field.first) / BITS_PER_BYTE : 0;
}

function allBits(state: BitsState): number[] {
  return state.bytes.flatMap((byte) => bitsOf(byte.value));
}

function readBytes(values: number[], order: Order): number {
  const ordered = order === "big" ? values : [...values].reverse();
  return ordered.reduce((total, value) => total * (BYTE_MAX + 1) + value, 0);
}

function fieldValue(state: BitsState, field: Field): number {
  if (!byteAligned(field))
    return allBits(state)
      .slice(field.first, field.last + 1)
      .reduce((total, bit) => total * 2 + bit, 0);
  const first = field.first / BITS_PER_BYTE;
  return readBytes(
    state.bytes.slice(first, first + fieldBytes(field)).map((byte) => byte.value),
    field.order,
  );
}

function fieldLabel(state: BitsState, field: Field): string {
  const suffix = fieldBytes(field) > 1 ? (field.order === "big" ? " BE" : " LE") : "";
  return `${field.name} = ${fieldValue(state, field)}${suffix}`;
}

function markField(state: BitsState, op: LabOp): BitsState {
  wholeObject(state, op);
  const name = stringArg(op.args, "name", "field");
  if (name.trim() === "") fail(`op "field" needs "name" as a short text such as "port"`);
  if (state.fields.some((field) => field.name === name)) fail(`op "field": ${state.objectId} already has a field "${name}"; give each field its own name`);
  if (state.fields.length >= MAX_FIELDS) fail(`op "field": ${state.objectId} holds at most ${MAX_FIELDS} fields; show the rest in a new object`);
  const [first, last] = bitRange(state, op);
  const overlap = state.fields.find((field) => field.first <= last && first <= field.last);
  if (overlap) fail(`op "field": "${name}" overlaps field "${overlap.name}"; fields must not share bits`);
  const field: Field = { name, first, last, order: state.order, color: SERIES[state.fields.length]! };
  const fields = [...state.fields, field].sort((a, b) => a.first - b.first);
  return { ...state, fields, view: { kind: "row" } };
}

function toggled(order: Order): Order {
  return order === "big" ? "little" : "big";
}

function reversedSpan(bytes: Byte[], first: number, count: number): Byte[] {
  const span = bytes.slice(first, first + count).reverse();
  return bytes.map((byte, slot) => (slot >= first && slot < first + count ? span[slot - first]! : byte));
}

function flipField(state: BitsState, name: string): BitsState {
  const field = state.fields.find((candidate) => candidate.name === name);
  if (!field) fail(`op "flip": ${state.objectId} has no field "${name}"; fields are ${state.fields.map((candidate) => candidate.name).join(", ") || "none yet, mark one with the field op"}`);
  if (fieldBytes(field) < 2) fail(`op "flip": field "${name}" is not two or more whole bytes, so it has no byte order to flip`);
  const bytes = reversedSpan(state.bytes, field.first / BITS_PER_BYTE, fieldBytes(field));
  const fields = state.fields.map((candidate) => (candidate === field ? { ...candidate, order: toggled(candidate.order) } : candidate));
  return { ...state, bytes, fields };
}

function flipRow(state: BitsState): BitsState {
  if (state.bytes.length < 2) fail(`op "flip": ${state.objectId} has one byte, so it has no byte order to flip`);
  const split = state.fields.find((field) => !byteAligned(field));
  if (split) fail(`op "flip": field "${split.name}" splits a byte, and a byte order flip keeps bits inside each byte; flip a whole-byte field with "field": "<name>" instead`);
  const last = bitCount(state) - 1;
  const fields = state.fields.map((field) => ({ ...field, first: last - field.last, last: last - field.first, order: toggled(field.order) })).sort((a, b) => a.first - b.first);
  return { ...state, bytes: [...state.bytes].reverse(), order: toggled(state.order), fields };
}

function flip(state: BitsState, op: LabOp): BitsState {
  wholeObject(state, op);
  const flipped = op.args.field === undefined ? flipRow(state) : flipField(state, stringArg(op.args, "field", "flip"));
  return { ...flipped, view: { kind: "row" } };
}

function xor(state: BitsState, op: LabOp): BitsState {
  wholeObject(state, op);
  const key = byteList(op.args.with, `op "xor" "with"`);
  if (key.length !== state.bytes.length) fail(`op "xor" needs "with" to have ${state.bytes.length} bytes, one under each byte of ${state.objectId}, got ${key.length}`);
  return { ...state, view: { kind: "xor", key } };
}

function encrypt(state: BitsState, op: LabOp): BitsState {
  wholeObject(state, op);
  const mode = op.args.mode as Mode;
  if (!MODE_NAMES.includes(mode)) fail(`op "encrypt" needs "mode" as ${MODE_NAMES.join(", ")}, got ${JSON.stringify(op.args.mode)}`);
  const key = integerArg(op.args, "key", "encrypt", 0, BYTE_MAX, 0);
  const { seed } = MODES[mode];
  const stray = SEED_NAMES.find((name) => name !== seed && op.args[name] !== undefined);
  if (stray) fail(`op "encrypt": ${mode} takes ${seed ? `"${seed}"` : "no iv or counter"}, not "${stray}"; CBC takes "iv" and CTR takes "counter"`);
  const seedValue = seed ? integerArg(op.args, seed, "encrypt", 0, BYTE_MAX, 0) : 0;
  return { ...state, view: { kind: "mode", mode, key, seed: seedValue } };
}

function stackBands(bands: Band[]): Stack {
  const gaps = Math.max(0, bands.length - 1);
  const stretchTotal = bands.reduce((total, band) => total + band.stretch, 0);
  let room = HEIGHT - bands.reduce((total, band) => total + band.height, 0);
  let gap = gaps === 0 ? 0 : Math.min(GAP_PREFERRED, Math.max(GAP_MIN, room / gaps));
  room -= gap * gaps;
  const firstGrowth = Math.max(0, Math.min(room, stretchTotal));
  room -= firstGrowth;
  if (gaps > 0 && room > 0) {
    const widen = Math.min(GAP_MAX - gap, room / gaps);
    gap += widen;
    room -= widen * gaps;
  }
  const growth = firstGrowth + Math.max(0, room);
  const places = new Map<string, Placed>();
  let top = 0;
  bands.forEach((band) => {
    const height = band.height + (stretchTotal > 0 ? (band.stretch / stretchTotal) * growth : 0);
    places.set(band.key, { top, height });
    top += height + gap;
  });
  return { places, height: top - gap };
}

function placeOf(stack: Stack, key: string): Placed {
  return stack.places.get(key)!;
}

function bottomOf(stack: Stack, key: string): number {
  const place = placeOf(stack, key);
  return place.top + place.height;
}

function middleOf(stack: Stack, key: string): number {
  const place = placeOf(stack, key);
  return place.top + place.height / 2;
}

function makeStrip(left: number, count: number, gap: number): Strip {
  return { left, gap, count, cell: (WIDTH - left - (count - 1) * gap) / (count * BITS_PER_BYTE) };
}

function byteWidth(strip: Strip): number {
  return strip.cell * BITS_PER_BYTE;
}

function byteLeft(strip: Strip, slot: number): number {
  return strip.left + slot * (byteWidth(strip) + strip.gap);
}

function byteCenter(strip: Strip, slot: number): number {
  return byteLeft(strip, slot) + byteWidth(strip) / 2;
}

function bitLeft(strip: Strip, bit: number): number {
  return byteLeft(strip, Math.floor(bit / BITS_PER_BYTE)) + (bit % BITS_PER_BYTE) * strip.cell;
}

function edgeX(strip: Strip, edge: number): number {
  const total = strip.count * BITS_PER_BYTE;
  if (edge === 0) return strip.left;
  if (edge === total) return WIDTH;
  if (edge % BITS_PER_BYTE === 0) return byteLeft(strip, edge / BITS_PER_BYTE) - strip.gap / 2;
  return bitLeft(strip, edge);
}

function cellBand(key: string, strip: Strip): Band {
  const height = Math.max(CELL_MIN_HEIGHT, Math.min(CELL_MAX_BASE, strip.cell));
  return { key, height, stretch: height };
}

function valueBand(key: string): Band {
  return { key, height: VALUE_SIZE, stretch: VALUE_GROWTH };
}

function textBand(key: string, size: number, growth = 0): Band {
  return { key, height: size, stretch: growth };
}

function textSizeIn(stack: Stack, key: string, size: number, growth: number): number {
  return Math.min(placeOf(stack, key).height, size + growth);
}

function bitTextSize(strip: Strip, cellHeight: number): number {
  return Math.max(BIT_TEXT_MIN, Math.min(BIT_TEXT_MAX, strip.cell * BIT_TEXT_SHARE, cellHeight / 2));
}

function cellInset(strip: Strip, size: number): number {
  const needed = (textWidth("0", size, "code") + TEXT_CLEAR * 2 - strip.cell) / 2;
  return Math.max(CELL_INSET_MIN, needed + CELL_INSET_SPARE);
}

function cellDrawables(id: string, bit: number, left: number, place: Placed, strip: Strip, look: CellLook, reading: boolean): Drawable[] {
  const size = bitTextSize(strip, place.height);
  const inset = cellInset(strip, size);
  const rect = { x: left + inset, y: place.top, w: strip.cell - inset * 2, h: place.height };
  const cell = boxDrawable(id, rect, { fill: bit ? look.on : "fill", stroke: look.stroke, strokeWidth: look.strokeWidth, radius: 0, z: 1 });
  if (!reading) return [cell];
  const center = { x: left + strip.cell / 2, y: place.top + place.height / 2 };
  return [cell, textDrawable(`${id}-text`, String(bit), center, { size, font: "code", fill: bit ? "ground" : "muted", z: 2 })];
}

function byteDrawables(id: string, value: number, left: number, cells: Placed, values: Placed | undefined, strip: Strip, lookOf: (bit: number) => CellLook, reading: boolean): Drawable[] {
  const bits = bitsOf(value).flatMap((bit, index) => cellDrawables(`${id}-bit${index}`, bit, left + index * strip.cell, cells, strip, lookOf(index), reading));
  if (!values) return bits;
  const center = { x: left + byteWidth(strip) / 2, y: values.top + values.height / 2 };
  return [...bits, textDrawable(`${id}-value`, String(value), center, { size: Math.min(values.height, VALUE_SIZE + VALUE_GROWTH), z: 2 })];
}

function fieldAt(state: BitsState, bit: number): Field | undefined {
  return state.fields.find((field) => field.first <= bit && bit <= field.last);
}

function dataLook(state: BitsState, slot: number): (index: number) => CellLook {
  return (index) => {
    const field = fieldAt(state, slot * BITS_PER_BYTE + index);
    return field ? { on: "ink", stroke: field.color, strokeWidth: FIELD_CELL_STROKE } : ROW_CELLS;
  };
}

function labelFits(spot: LabelSpot, placed: LabelSpot[]): boolean {
  const left = spot.center - spot.width / 2 - LABEL_CLEAR;
  const right = spot.center + spot.width / 2 + LABEL_CLEAR;
  return placed.every((other) => {
    const otherLeft = other.center - other.width / 2;
    const otherRight = other.center + other.width / 2;
    if (other.level === spot.level) return right <= otherLeft || otherRight <= left;
    if (other.level > spot.level) return other.stem <= left || right <= other.stem;
    return spot.stem + LEADER_CLEAR <= otherLeft || otherRight <= spot.stem - LEADER_CLEAR;
  });
}

function labelSpots(state: BitsState, strip: Strip): LabelSpot[] {
  if (!state.reading) return [];
  const placed: LabelSpot[] = [];
  state.fields.forEach((field) => {
    const text = fieldLabel(state, field);
    const width = textWidth(text, LABEL_SIZE, "read");
    const stem = (edgeX(strip, field.first) + edgeX(strip, field.last + 1)) / 2;
    const center = Math.min(WIDTH - width / 2, Math.max(width / 2, stem));
    let level = 0;
    while (!labelFits({ field, text, center, stem, width, level }, placed)) level += 1;
    placed.push({ field, text, center, stem, width, level });
  });
  return placed;
}

function labelLevels(spots: LabelSpot[]): number {
  return spots.length === 0 ? 0 : Math.max(...spots.map((spot) => spot.level)) + 1;
}

function rowStrip(state: BitsState): Strip {
  return makeStrip(0, state.bytes.length, BYTE_GAP);
}

function rowStack(state: BitsState): Stack {
  const strip = rowStrip(state);
  const levels = Math.max(1, labelLevels(labelSpots(state, strip)));
  const bands: Band[] = [
    ...(state.reading ? [textBand("header", HEADER_SIZE, HEADER_GROWTH)] : []),
    textBand("order", ORDER_BAND),
    ...(state.reading ? [textBand("offsets", OFFSET_SIZE, OFFSET_GROWTH)] : []),
    cellBand("cells", strip),
    ...(state.reading ? [valueBand("values")] : []),
    textBand("brackets", BRACKET_DEPTH),
    ...(state.reading ? [textBand("labels", levels * LABEL_PITCH - (LABEL_PITCH - LABEL_SIZE))] : []),
  ];
  return stackBands(bands);
}

function orderArrow(state: BitsState, stack: Stack): Drawable {
  const y = middleOf(stack, "order");
  const [from, to] = state.order === "big" ? [0, WIDTH] : [WIDTH, 0];
  return { id: "order", kind: "arrow", x: from, y, x2: to, y2: y, stroke: "edge", strokeWidth: ORDER_STROKE, z: 1 };
}

function headerText(state: BitsState): string {
  return `read ${state.order} endian: ${readBytes(
    state.bytes.map((byte) => byte.value),
    state.order,
  )}`;
}

function dataRow(state: BitsState, strip: Strip, stack: Stack, lift: (slot: number) => { left: number; dy: number }): Drawable[] {
  const cells = placeOf(stack, "cells");
  const values = state.reading ? placeOf(stack, "values") : undefined;
  return state.bytes.flatMap((byte, slot) => {
    const { left, dy } = lift(slot);
    const shift = (place: Placed): Placed => ({ ...place, top: place.top + dy });
    const reach = values ? values.top + values.height - cells.top : cells.height;
    const tap = boxDrawable(`${byte.id}-tap`, { x: left, y: cells.top + dy, w: byteWidth(strip), h: reach }, { fill: "ground", opacity: 0, z: TAP_Z, part: `${state.objectId}[${slot}]` });
    return [...byteDrawables(byte.id, byte.value, left, shift(cells), values && shift(values), strip, dataLook(state, slot), state.reading), tap];
  });
}

function fieldMarks(state: BitsState, strip: Strip, stack: Stack): Drawable[] {
  if (state.fields.length === 0) return [];
  const top = placeOf(stack, "brackets").top;
  const bottom = top + BRACKET_DEPTH;
  const brackets = state.fields.map((field): Drawable => {
    const left = bitLeft(strip, field.first) + BRACKET_INSET;
    const right = bitLeft(strip, field.last) + strip.cell - BRACKET_INSET;
    return {
      id: `bracket-${field.name}`,
      kind: "path",
      x: left,
      y: top,
      points: [left, top, left, bottom, right, bottom, right, top],
      fill: "none",
      stroke: field.color,
      strokeWidth: BRACKET_STROKE,
      z: 3,
    };
  });
  return [...brackets, ...fieldLabels(state, strip, stack, bottom)];
}

function fieldLabels(state: BitsState, strip: Strip, stack: Stack, bracketBottom: number): Drawable[] {
  const spots = labelSpots(state, strip);
  if (spots.length === 0) return [];
  const top = placeOf(stack, "labels").top;
  return spots.flatMap((spot): Drawable[] => {
    const labelTop = top + spot.level * LABEL_PITCH;
    const label = textDrawable(`label-${spot.field.name}`, spot.text, { x: spot.center, y: labelTop + LABEL_SIZE / 2 }, { size: LABEL_SIZE, z: 3 });
    if (spot.level === 0) return [label];
    const leader: Drawable = {
      id: `leader-${spot.field.name}`,
      kind: "line",
      x: spot.stem,
      y: bracketBottom,
      x2: spot.stem,
      y2: labelTop - LEADER_CLEAR,
      stroke: spot.field.color,
      strokeWidth: BRACKET_STROKE,
      z: 3,
    };
    return [label, leader];
  });
}

function rowLift(strip: Strip): (slot: number) => { left: number; dy: number } {
  return (slot) => ({ left: byteLeft(strip, slot), dy: 0 });
}

function rowDrawables(state: BitsState): Drawable[] {
  const strip = rowStrip(state);
  const stack = rowStack(state);
  const words: Drawable[] = state.reading
    ? [
        textDrawable("header", headerText(state), { x: WIDTH / 2, y: middleOf(stack, "header") }, { size: textSizeIn(stack, "header", HEADER_SIZE, HEADER_GROWTH), z: 2 }),
        ...state.bytes.map((_, slot) =>
          textDrawable(
            `offset-${slot}`,
            `byte ${slot}`,
            { x: byteCenter(strip, slot), y: middleOf(stack, "offsets") },
            { size: textSizeIn(stack, "offsets", OFFSET_SIZE, OFFSET_GROWTH), fill: "muted", z: 2 },
          ),
        ),
      ]
    : [];
  return [...words, orderArrow(state, stack), ...dataRow(state, strip, stack, rowLift(strip)), ...fieldMarks(state, strip, stack)];
}

function xorStrip(state: BitsState): Strip {
  return makeStrip(XOR_GUTTER, state.bytes.length, BYTE_GAP);
}

function xorStack(state: BitsState): Stack {
  const strip = xorStrip(state);
  const row = (name: string): Band[] => [cellBand(`${name}-cells`, strip), ...(state.reading ? [valueBand(`${name}-values`)] : [])];
  return stackBands([...row("data"), ...row("key"), textBand("rule", RULE_BAND), ...row("result")]);
}

function xorSign(id: string, x: number, y: number): Drawable[] {
  const look = { stroke: "ink" as const, strokeWidth: SIGN_STROKE, z: 2 };
  return [
    { id: `${id}-ring`, kind: "circle", x, y, r: XOR_RADIUS, fill: "none", ...look },
    { id: `${id}-across`, kind: "line", x: x - XOR_RADIUS, y, x2: x + XOR_RADIUS, y2: y, ...look },
    { id: `${id}-down`, kind: "line", x, y: y - XOR_RADIUS, x2: x, y2: y + XOR_RADIUS, ...look },
  ];
}

function equalsSign(x: number, y: number): Drawable[] {
  const look = { stroke: "ink" as const, strokeWidth: SIGN_STROKE, z: 2 };
  return [-EQUALS_SPREAD, EQUALS_SPREAD].map((offset, index): Drawable => ({ id: `equals-${index}`, kind: "line", x: x - EQUALS_HALF, y: y + offset, x2: x + EQUALS_HALF, y2: y + offset, ...look }));
}

function rowOf(stack: Stack, reading: boolean, name: string): { cells: Placed; values: Placed | undefined } {
  return { cells: placeOf(stack, `${name}-cells`), values: reading ? placeOf(stack, `${name}-values`) : undefined };
}

function xorResult(state: BitsState, view: XorView): number[] {
  return state.bytes.map((byte, slot) => byte.value ^ view.key[slot]!);
}

function resultDrawables(state: BitsState, view: XorView, strip: Strip, stack: Stack): Drawable[] {
  const { cells, values } = rowOf(stack, state.reading, "result");
  return xorResult(state, view).flatMap((value, slot) => byteDrawables(`result-${slot}`, value, byteLeft(strip, slot), cells, values, strip, () => RESULT_CELLS, state.reading));
}

function xorDrawables(state: BitsState, view: XorView): Drawable[] {
  const strip = xorStrip(state);
  const stack = xorStack(state);
  const data = rowOf(stack, state.reading, "data");
  const key = rowOf(stack, state.reading, "key");
  const sign = XOR_GUTTER / 2;
  const ruleY = middleOf(stack, "rule");
  return [
    ...state.bytes.flatMap((byte, slot) => byteDrawables(byte.id, byte.value, byteLeft(strip, slot), data.cells, data.values, strip, () => ROW_CELLS, state.reading)),
    ...view.key.flatMap((value, slot) => byteDrawables(`key-${slot}`, value, byteLeft(strip, slot), key.cells, key.values, strip, () => ROW_CELLS, state.reading)),
    ...xorSign("xor-sign", sign, middleOf(stack, "key-cells")),
    { id: "rule", kind: "line", x: XOR_GUTTER, y: ruleY, x2: WIDTH, y2: ruleY, stroke: "ink", strokeWidth: SIGN_STROKE, z: 1 },
    ...equalsSign(sign, middleOf(stack, "result-cells")),
    ...resultDrawables(state, view, strip, stack),
  ];
}

function ivText(view: ModeView): string {
  return `IV ${view.seed}`;
}

function ivWidth(state: BitsState, view: ModeView): number {
  return state.reading ? textWidth(ivText(view), BOX_TEXT_MAX, "read") + BOX_PADDING * 2 : IV_WORDLESS_WIDTH;
}

function modeStrip(state: BitsState, view: ModeView): Strip {
  const gutter = MODES[view.mode].chained ? ivWidth(state, view) + IV_ARROW_ROOM : 0;
  return makeStrip(gutter, state.bytes.length, COLUMN_GAP);
}

function modeStack(state: BitsState, view: ModeView): Stack {
  const strip = modeStrip(state, view);
  const chained = MODES[view.mode].chained;
  const arrow = (key: string): Band => ({ key, height: ARROW_BAND, stretch: ARROW_BAND / 2 });
  const values = (key: string): Band[] => (state.reading ? [valueBand(key)] : []);
  return stackBands([
    ...(state.reading ? [textBand("header", HEADER_SIZE, HEADER_GROWTH), textBand("header-clear", HEADER_CLEAR)] : []),
    cellBand("plain-cells", strip),
    ...values("plain-values"),
    arrow("into"),
    ...(chained ? [textBand("mix", XOR_RADIUS * 2), arrow("mixed")] : []),
    { key: "boxes", height: BOX_HEIGHT, stretch: BOX_GROWTH },
    arrow("out"),
    cellBand("cipher-cells", strip),
    ...values("cipher-values"),
    ...(chained && state.bytes.length > 1 ? [textBand("feedback", BRACKET_DEPTH + STEM_DROP)] : []),
  ]);
}

function repeatRoles(values: number[]): (Role | null)[] {
  const repeated = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
  return values.map((value) => {
    const group = repeated.indexOf(value);
    return group < 0 ? null : SERIES[group % SERIES.length]!;
  });
}

function blockFrame(id: string, left: number, cells: Placed, strip: Strip, role: Role | null): Drawable[] {
  if (!role) return [];
  return [boxDrawable(id, { x: left, y: cells.top, w: byteWidth(strip), h: cells.height }, { fill: "none", stroke: role, strokeWidth: FRAME_STROKE, radius: 0, z: 3 })];
}

function verticalArrow(id: string, x: number, from: number, to: number, stroke: Role): Drawable {
  return { id, kind: "arrow", x, y: from, x2: x, y2: to, stroke, strokeWidth: ARROW_STROKE, z: 2 };
}

function modeBox(state: BitsState, view: ModeView, strip: Strip, stack: Stack, block: number): Drawable[] {
  const place = placeOf(stack, "boxes");
  const text = MODES[view.mode].boxText(view, block);
  const room = byteWidth(strip);
  const width = state.reading ? Math.min(room, Math.max(room * BOX_SHARE, textWidth(text, BIT_TEXT_MIN, "read") + BOX_PADDING * 2)) : room * BOX_SHARE;
  const center = byteCenter(strip, block);
  const box = boxDrawable(`box-${block}`, { x: center - width / 2, y: place.top, w: width, h: place.height }, { fill: "fill2", stroke: "edge", strokeWidth: 2, radius: 1, z: 1 });
  if (!state.reading) return [box];
  const size = Math.max(BIT_TEXT_MIN, fitText(text, BOX_TEXT_MAX, width - BOX_PADDING * 2, "read"));
  return [box, textDrawable(`box-${block}-text`, text, { x: center, y: place.top + place.height / 2 }, { size, z: 2 })];
}

function columnDrawables(state: BitsState, view: ModeView, strip: Strip, stack: Stack, cipher: number[], block: number): Drawable[] {
  const x = byteCenter(strip, block);
  const left = byteLeft(strip, block);
  const chained = MODES[view.mode].chained;
  const into = bottomOf(stack, state.reading ? "plain-values" : "plain-cells") + ARROW_START_GAP;
  const target = chained ? placeOf(stack, "mix").top : placeOf(stack, "boxes").top;
  const cells = placeOf(stack, "cipher-cells");
  const values = state.reading ? placeOf(stack, "cipher-values") : undefined;
  const mixing = chained
    ? [...xorSign(`mix-${block}`, x, middleOf(stack, "mix")), verticalArrow(`mixed-${block}`, x, bottomOf(stack, "mix") + ARROW_TIP_GAP, placeOf(stack, "boxes").top - ARROW_TIP_GAP, "edge")]
    : [];
  return [
    verticalArrow(`into-${block}`, x, into, target - ARROW_TIP_GAP, "edge"),
    ...mixing,
    ...modeBox(state, view, strip, stack, block),
    verticalArrow(`out-${block}`, x, bottomOf(stack, "boxes") + ARROW_TIP_GAP, cells.top - ARROW_TIP_GAP, "edge"),
    ...byteDrawables(`cipher-${block}`, cipher[block]!, left, cells, values, strip, () => ROW_CELLS, state.reading),
    ...blockFrame(`cipher-${block}-frame`, left, cells, strip, repeatRoles(cipher)[block]!),
    ...(chained ? chainIn(state, view, strip, stack, block) : []),
  ];
}

function chainIn(state: BitsState, view: ModeView, strip: Strip, stack: Stack, block: number): Drawable[] {
  const mixY = middleOf(stack, "mix");
  const end = byteCenter(strip, block) - XOR_RADIUS - ARROW_TIP_GAP;
  if (block === 0) return ivDrawables(state, view, mixY, end);
  const source = block - 1;
  const top = placeOf(stack, "feedback").top;
  const bracketBottom = top + BRACKET_DEPTH;
  const busY = bottomOf(stack, "feedback");
  const stemX = byteCenter(strip, source);
  const gapX = byteLeft(strip, block) - strip.gap / 2;
  const left = byteLeft(strip, source) + BRACKET_INSET;
  const right = byteLeft(strip, source) + byteWidth(strip) - BRACKET_INSET;
  const look = { stroke: "accent" as const, strokeWidth: FEEDBACK_STROKE, z: 2 };
  return [
    { id: `feed-${block}-bracket`, kind: "path", x: left, y: top, points: [left, top, left, bracketBottom, right, bracketBottom, right, top], fill: "none", ...look },
    { id: `feed-${block}-route`, kind: "path", x: stemX, y: bracketBottom, points: [stemX, bracketBottom, stemX, busY, gapX, busY, gapX, mixY], fill: "none", ...look },
    { id: `feed-${block}-arrow`, kind: "arrow", x: gapX, y: mixY, x2: end, y2: mixY, ...look },
  ];
}

function ivDrawables(state: BitsState, view: ModeView, mixY: number, end: number): Drawable[] {
  const width = ivWidth(state, view);
  const height = XOR_RADIUS * 2;
  const box = boxDrawable("iv", { x: 0, y: mixY - height / 2, w: width, h: height }, { fill: "fill", stroke: "accent", strokeWidth: FEEDBACK_STROKE, radius: 1, z: 1 });
  const arrow: Drawable = { id: "iv-arrow", kind: "arrow", x: width, y: mixY, x2: end, y2: mixY, stroke: "accent", strokeWidth: FEEDBACK_STROKE, z: 2 };
  if (!state.reading) return [box, arrow];
  return [box, arrow, textDrawable("iv-text", ivText(view), { x: width / 2, y: mixY }, { size: fitText(ivText(view), BOX_TEXT_MAX, width - BOX_PADDING, "read"), z: 2 })];
}

function plainDrawables(state: BitsState, view: ModeView): Drawable[] {
  const strip = modeStrip(state, view);
  const stack = modeStack(state, view);
  const cells = placeOf(stack, "plain-cells");
  const values = state.reading ? placeOf(stack, "plain-values") : undefined;
  const roles = repeatRoles(state.bytes.map((byte) => byte.value));
  const header = state.reading
    ? [textDrawable("header", MODES[view.mode].header(view), { x: (strip.left + WIDTH) / 2, y: middleOf(stack, "header") }, { size: textSizeIn(stack, "header", HEADER_SIZE, HEADER_GROWTH), z: 2 })]
    : [];
  return [
    ...header,
    ...state.bytes.flatMap((byte, slot) => [
      ...byteDrawables(byte.id, byte.value, byteLeft(strip, slot), cells, values, strip, () => ROW_CELLS, state.reading),
      ...blockFrame(`${byte.id}-frame`, byteLeft(strip, slot), cells, strip, roles[slot]!),
    ]),
  ];
}

function modeColumns(state: BitsState, view: ModeView): Drawable[][] {
  const strip = modeStrip(state, view);
  const stack = modeStack(state, view);
  const cipher = MODES[view.mode].encode(
    state.bytes.map((byte) => byte.value),
    view,
  );
  return state.bytes.map((_, block) => columnDrawables(state, view, strip, stack, cipher, block));
}

function modeDrawables(state: BitsState, view: ModeView): Drawable[] {
  return [...plainDrawables(state, view), ...modeColumns(state, view).flat()];
}

function faded(drawables: Drawable[], opacity: number): Drawable[] {
  return drawables.map((drawable) => ({ ...drawable, opacity: (drawable.opacity ?? 1) * opacity }));
}

function encryptReveal(_before: BitsState, after: BitsState, _op: LabOp, progress: number): Drawable[] {
  if (after.view.kind !== "mode") return [];
  const columns = modeColumns(after, after.view);
  return columns.flatMap((column, block) => faded(column, clamp01(progress * columns.length - block)));
}

function xorReveal(_before: BitsState, after: BitsState, _op: LabOp, progress: number): Drawable[] {
  if (after.view.kind !== "xor") return [];
  const strip = xorStrip(after);
  const stack = xorStack(after);
  const count = after.bytes.length;
  const result = resultDrawables(after, after.view, strip, stack);
  return after.bytes.flatMap((_, slot) => {
    const own = result.filter((drawable) => drawable.id.startsWith(`result-${slot}-`));
    return faded(own, clamp01(progress * count - slot));
  });
}

function flipArcs(before: BitsState, after: BitsState, _op: LabOp, progress: number): Drawable[] {
  if (before.view.kind !== "row") return [];
  const strip = rowStrip(after);
  const stack = rowStack(after);
  const lift = Math.sin(Math.PI * clamp01(progress));
  return dataRow(after, strip, stack, (slot) => {
    const from = before.bytes.findIndex((byte) => byte.id === after.bytes[slot]!.id);
    const direction = slot > from ? -1 : slot < from ? 1 : 0;
    return { left: lerp(byteLeft(strip, from), byteLeft(strip, slot), progress), dy: direction * FLIP_ARC * lift };
  });
}

const DRAWERS: { [Kind in View["kind"]]: (state: BitsState, view: Extract<View, { kind: Kind }>) => Drawable[] } = {
  row: (state) => rowDrawables(state),
  xor: xorDrawables,
  mode: modeDrawables,
};

const STACKS: { [Kind in View["kind"]]: (state: BitsState, view: Extract<View, { kind: Kind }>) => Stack } = {
  row: (state) => rowStack(state),
  xor: (state) => xorStack(state),
  mode: modeStack,
};

function viewStack(state: BitsState): Stack {
  const build = STACKS[state.view.kind] as (state: BitsState, view: View) => Stack;
  return build(state, state.view);
}

function viewDrawables(state: BitsState): Drawable[] {
  const draw = DRAWERS[state.view.kind] as (state: BitsState, view: View) => Drawable[];
  return draw(state, state.view);
}

export const lab: LabDef<BitsSpec, BitsState> = {
  id: "bits",
  title: "Bytes and bits",
  reading: "optional",
  framed: true,
  catalog: {
    summary:
      "A row of up to 6 bytes drawn as bits (filled cell = 1), for packet parsing and crypto: mark named fields with colored cell outlines and brackets, flip byte order between big and little endian, XOR two byte rows into a result, and encrypt the bytes as one-byte blocks in ECB, CBC or CTR mode with a toy block cipher the Lab computes. Every op targets the whole object; the Lab computes every value. Each byte of the row can be tapped by its address, so a click Challenge can ask which byte, answered as \"n[0]\" for the byte at address 0, the leftmost. With reading false no numbers or words are drawn and the bits, brackets and arrows carry the meaning.",
    spec: {
      bytes: 'list of 1 to 6 whole numbers 0 to 255, such as [1, 187, 0, 80], or text of 1 to 6 plain characters, such as "AAAB", read as their ASCII codes',
      order: 'optional "big" or "little" (default "big"): the byte order the row is read in; the header shows the row read that way, and the arrow points from the most significant byte to the least',
      reading: "optional boolean, default true; false draws no words or numbers",
    },
    example: [
      '{"step":1,"say":"These four bytes start a UDP header. The first two are the source port, the next two the destination port.","scene":{"pkt":{"lab":"bits","bytes":[1,187,0,80]}},"do":[{"cue":"source port","op":"field","on":["pkt"],"name":"src","bytes":[0,1]},{"cue":"destination port","op":"field","on":["pkt"],"name":"dst","bytes":[2,3]}]}',
      '{"step":2,"say":"Stored little endian, the destination port bytes swap places, but the number stays eighty. Then CBC chains each block into the next.","do":[{"cue":"swap places","op":"flip","on":["pkt"],"field":"dst"},{"cue":"CBC","op":"encrypt","on":["pkt"],"mode":"CBC","key":90,"iv":7}]}',
    ],
  },

  init(spec, objectId) {
    const values = byteList(spec.bytes, `${objectId}: "bytes"`);
    return {
      objectId,
      reading: readingFlag(spec.reading, objectId),
      bytes: values.map((value, index) => ({ id: `byte${index}`, value })),
      order: orderValue(spec.order, `${objectId}: "order"`),
      fields: [],
      view: { kind: "row" },
    };
  },

  ops: {
    field: {
      doc: '{"name": "port", "bytes": [2, 3]} or {"name": "version", "bits": [0, 3]}; marks a named field over whole bytes or over bits (bit 0 is the leftmost bit of byte 0) with colored cell outlines, a colored bracket and its value; fields must not overlap, at most 6; shows the byte row',
      seconds: 0.8,
      apply: markField,
    },
    flip: {
      doc: 'no args flips the byte order of the whole row: the bytes reverse, big becomes little endian or back, and the value read stays the same; {"field": "port"} flips only that whole-byte field of two or more bytes, its label switching between BE and LE; shows the byte row',
      seconds: 1.2,
      apply: flip,
      during: flipArcs,
    },
    xor: {
      doc: '{"with": [255, 0, 15, 240]} or {"with": "KEY!"}; draws that many bytes under the row and the bitwise XOR of the two below a line, filled in byte by byte; "with" must have as many bytes as the row',
      seconds: (_op, state) => 0.6 + 0.4 * state.bytes.length,
      apply: xor,
      during: xorReveal,
    },
    encrypt: {
      doc: '{"mode": "ECB"|"CBC"|"CTR", "key": 90}; each byte is a one-byte plaintext block, drawn with its box and ciphertext block below, block by block; CBC takes "iv" (default 0) and XORs each block with the previous ciphertext block, drawn as an arrow from that whole block; CTR takes "counter" (default 0) and XORs block i with E(counter + i); repeated block values share a colored frame, so ECB shows the pattern leak; key, iv and counter are 0 to 255',
      seconds: (_op, state) => 0.6 + 0.8 * state.bytes.length,
      apply: encrypt,
      during: encryptReveal,
    },
  },

  size(state) {
    return { w: WIDTH, h: viewStack(state).height };
  },

  draw(state) {
    return viewDrawables(state);
  },
};
