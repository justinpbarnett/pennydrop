import {
  boxDrawable,
  type BoxLook,
  clamp01,
  type Drawable,
  fail,
  fitText,
  integerArg,
  integerField,
  type LabDef,
  type LabOp,
  lerp,
  lerpRect,
  type Point,
  readsWords,
  type Rect,
  type Role,
  type Size,
  stringField,
  textDrawable,
} from "../lab";
import { textWidth } from "../text-metrics";

type Strategy = "chaining" | "probing";

type HashSpec = {
  capacity?: unknown;
  strategy?: unknown;
  keys?: unknown;
  incoming?: unknown;
  reading?: unknown;
};

interface Visitor {
  key: number;
  bucket: number;
}

interface HashState {
  objectId: string;
  reading: boolean;
  strategy: Strategy;
  capacity: number;
  keys: number[];
  tray: number[];
  waiting: number[];
  placed: number[];
  buckets: number[][];
  visitor: Visitor | null;
  note: string;
}

interface StrategyRule {
  collision: Role;
  resolveOp: string;
  rehashBucket(buckets: number[][], home: number): number;
  cells(state: HashState): number;
  resolveNote(key: number, bucket: number, capacity: number): string;
  turnAway(layout: TableLayout, bucket: number, role: Role): Drawable[];
}

interface PillLook extends Size {
  text: number;
}

interface KeyPlace {
  rect: Rect;
  text: number;
  stroke: Role;
}

interface RowMetrics {
  rowHeight: number;
  rowPad: number;
  gap: number;
  indexSize: number;
  labelRight: number;
  openLeft: number;
  pillHeight: number;
  keyText: number;
  slotPad: number;
  markHalf: number;
  tileWidth: number;
  arrivalHeight: number;
  arrivalText: number;
  arrivalTile: number;
}

interface Lanes {
  arrivalLeft: number;
  arrivalWidth: number;
  markX: number;
  laneRight: number;
  slotRight: number;
}

type TableLayout = RowMetrics & Lanes;

interface Rehash {
  moved: boolean;
  from: KeyPlace;
  to: KeyPlace;
  fadeOut: number;
  fadeIn: number;
}

type SideBlock = "note" | "load" | "bar" | "title" | "grid";

const SERIES: Role[] = ["series1", "series2", "series3", "series4", "series5", "series6"];
const STRATEGY_NAMES: Record<string, Strategy> = { chaining: "chaining", probing: "probing", open: "probing" };
const MIN_CAPACITY = 2;
const MAX_CAPACITY = 12;
const DEFAULT_CAPACITY = 4;
const MAX_KEYS = 12;
const MAX_KEY = 999;

const WIDTH = 1480;
const HEIGHT = 780;
const SIDE_WIDTH = 440;
const PANEL_GAP = 24;
const TABLE_LEFT = SIDE_WIDTH + PANEL_GAP;
const SIDE_PAD = 28;
const SIDE_ROOM = SIDE_WIDTH - 2 * SIDE_PAD;
const STACK_GAP = 18;

const MIN_TEXT = 28;
const NOTE_MAX = 60;
const LOAD_TEXT = 36;
const TITLE_TEXT = 34;
const LOAD_BAR_HEIGHT = 40;
const TRACK_STROKE = 1.5;
const FILL_INSET = 5;

const CHIP_HEIGHT = 84;
const CHIP_TEXT = 42;
const CHIP_ASPECT = 1.15;
const GRID_GAP = 32;

const ROW_GAP = 12;
const ROW_PAD_SHARE = 0.1;
const ROW_PAD_MIN = 4;
const ROW_PAD_MAX = 28;
const SLOT_PAD_SHARE = 0.15;
const SLOT_PAD_MIN = 4;
const SLOT_PAD_MAX = 28;
const GAP_SHARE = 0.16;
const GAP_MIN = 20;
const GAP_MAX = 48;
const INDEX_TEXT_SHARE = 0.36;
const INDEX_TEXT_MAX = 64;
const SLOT_STROKE = 1.5;

const PILL_MAX_HEIGHT = 170;
const ARRIVAL_ASPECT = 1.25;
const ARRIVAL_MAX_HEIGHT = 104;
const KEY_TEXT_SHARE = 0.46;
const KEY_TEXT_MAX = 72;
const PILL_PAD_MIN = 16;
const KEY_STROKE = 4;
const COMPACT_KEY_STROKE = 2;
const COMPACT_PILL = 56;
const STROKE_RAMP = 24;
const COMPACT_KEY_TEXT = 34;
const COMPACT_TEXT_SHARE = 0.7;

const MARK_SHARE = 0.16;
const MARK_MIN = 10;
const MARK_MAX = 22;
const MARK_SHOW = 0.75;
const MARK_STROKE = 5;
const LINK_GAP = 120;
const ARROW_CLEAR = 16;
const LINK_STROKE = 3.5;
const SAME_PLACE = 0.5;

const KEY_Z = 3;
const FLIGHT_Z = 10;
const EXIT_SHARE = 0.3;
const TRAY_HOLD = 0.15;
const SLIDE_SHARE = 0.4;
const LINK_SHOW = 0.85;
const PROBE_HOLD = 0.3;
const RESIZE_BASE_SECONDS = 1.4;
const REFLOW_END = 0.3;
const ROWS_IN_END = 0.4;
const SWAP_FADE = 0.2;
const SWAP_END = 0.75;
const ENTER_FADE = 0.1;
const RESIZE_SECONDS_PER_KEY = 0.35;

function firstFreeBucket(buckets: number[][], home: number): number {
  const offset = buckets.findIndex((_, step) => buckets[(home + step) % buckets.length]!.length === 0);
  return (home + offset) % buckets.length;
}

function sharedBucketCount(state: HashState): number {
  const residues = state.keys.map((key) => key % state.capacity);
  return Math.max(0, ...residues.map((residue) => residues.filter((other) => other === residue).length));
}

const STRATEGIES: Record<Strategy, StrategyRule> = {
  chaining: {
    collision: "warn",
    resolveOp: "chain",
    rehashBucket: (_buckets, home) => home,
    cells: sharedBucketCount,
    resolveNote: (key, bucket) => `${key} joins bucket ${bucket}`,
    turnAway: collisionCross,
  },
  probing: {
    collision: "fault",
    resolveOp: "probe",
    rehashBucket: firstFreeBucket,
    cells: () => 1,
    resolveNote: (_key, bucket, capacity) => `(${bucket} + 1) mod ${capacity} = ${(bucket + 1) % capacity}`,
    turnAway: collisionCross,
  },
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function formulaNote(capacity: number): string {
  return `h(k) = k mod ${capacity}`;
}

function modNote(key: number, capacity: number, bucket: number): string {
  return `${key} mod ${capacity} = ${bucket}`;
}

function readStrategy(spec: HashSpec, objectId: string): Strategy {
  const strategy = stringField(spec, "strategy", objectId, "chaining");
  if (!Object.hasOwn(STRATEGY_NAMES, strategy)) fail(`${objectId}: "strategy" must be "chaining" or "probing" ("open" also means probing), got ${JSON.stringify(strategy)}`);
  return STRATEGY_NAMES[strategy]!;
}

function isKey(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_KEY;
}

function readKeyList(spec: HashSpec, field: "keys" | "incoming", objectId: string): number[] {
  const raw = spec[field] ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_KEYS) fail(`${objectId}: "${field}" must be a list of 0 to ${MAX_KEYS} whole numbers, such as "${field}": [12, 7, 3]`);
  raw.forEach((key, index) => {
    if (!isKey(key)) fail(`${objectId}: ${field}[${index}] must be a whole number from 0 to ${MAX_KEY}, got ${JSON.stringify(key)}`);
  });
  return raw as number[];
}

function readAllKeys(spec: HashSpec, objectId: string): { stored: number[]; incoming: number[] } {
  const stored = readKeyList(spec, "keys", objectId);
  const incoming = readKeyList(spec, "incoming", objectId);
  const all = [...stored, ...incoming];
  if (all.length > MAX_KEYS) fail(`${objectId}: "keys" and "incoming" hold ${all.length} keys together; use at most ${MAX_KEYS}`);
  all.forEach((key, index) => {
    if (all.indexOf(key) !== index) fail(`${objectId}: key ${key} appears twice in "keys" and "incoming"; a hash table stores each key once`);
  });
  return { stored, incoming };
}

function emptyBuckets(capacity: number): number[][] {
  return Array.from({ length: capacity }, () => []);
}

function storeAll(keys: number[], capacity: number, strategy: Strategy): number[][] {
  const rule = STRATEGIES[strategy];
  const buckets = emptyBuckets(capacity);
  keys.forEach((key) => buckets[rule.rehashBucket(buckets, key % capacity)]!.push(key));
  return buckets;
}

function bucketOf(state: HashState, key: number): number {
  return state.buckets.findIndex((chain) => chain.includes(key));
}

function keyColor(state: HashState, key: number): Role {
  return SERIES[state.keys.indexOf(key) % SERIES.length]!;
}

function widestKey(state: HashState, size: number): number {
  return Math.max(...[0, ...state.keys].map((key) => textWidth(String(key), size, "mark")));
}

function keyTextSize(pillHeight: number): number {
  const floor = Math.min(COMPACT_KEY_TEXT, pillHeight * COMPACT_TEXT_SHARE);
  return Math.max(MIN_TEXT, clamp(pillHeight * KEY_TEXT_SHARE, floor, KEY_TEXT_MAX));
}

function keyStroke(pillHeight: number): number {
  return lerp(COMPACT_KEY_STROKE, KEY_STROKE, clamp01((pillHeight - COMPACT_PILL) / STROKE_RAMP));
}

function rowMetrics(state: HashState): RowMetrics {
  const rowHeight = (HEIGHT - (state.capacity - 1) * ROW_GAP) / state.capacity;
  const rowPad = clamp(rowHeight * ROW_PAD_SHARE, ROW_PAD_MIN, ROW_PAD_MAX);
  const slotHeight = rowHeight - 2 * rowPad;
  const slotPad = clamp(slotHeight * SLOT_PAD_SHARE, SLOT_PAD_MIN, SLOT_PAD_MAX);
  const pillHeight = Math.min(PILL_MAX_HEIGHT, slotHeight - 2 * slotPad);
  const keyText = keyTextSize(pillHeight);
  const gap = clamp(rowHeight * GAP_SHARE, GAP_MIN, GAP_MAX);
  const indexSize = clamp(rowHeight * INDEX_TEXT_SHARE, MIN_TEXT, INDEX_TEXT_MAX);
  const labelWidth = state.reading ? gap + textWidth(String(state.capacity - 1), indexSize, "mark") : 0;
  const arrivalHeight = Math.min(pillHeight, ARRIVAL_MAX_HEIGHT);
  const arrivalText = keyTextSize(arrivalHeight);
  return {
    rowHeight,
    rowPad,
    gap,
    indexSize,
    labelRight: TABLE_LEFT + labelWidth,
    openLeft: TABLE_LEFT + (state.reading ? labelWidth + gap : rowPad),
    pillHeight,
    keyText,
    slotPad,
    markHalf: clamp(pillHeight * MARK_SHARE, MARK_MIN, MARK_MAX),
    tileWidth: widestKey(state, keyText) + 2 * PILL_PAD_MIN,
    arrivalHeight,
    arrivalText,
    arrivalTile: widestKey(state, arrivalText) + 2 * PILL_PAD_MIN,
  };
}

function rowLanes(rows: RowMetrics): Lanes {
  const slotRight = WIDTH - rows.rowPad;
  const arrivalWidth = Math.max(rows.arrivalHeight * ARRIVAL_ASPECT, rows.arrivalTile);
  const arrivalLeft = slotRight - arrivalWidth;
  const markX = arrivalLeft - rows.gap - rows.markHalf;
  return { arrivalLeft, arrivalWidth, markX, laneRight: markX - rows.markHalf - rows.gap, slotRight };
}

function tableLayout(state: HashState): TableLayout {
  const rows = rowMetrics(state);
  return { ...rows, ...rowLanes(rows) };
}

function rowTop(layout: TableLayout, bucket: number): number {
  return bucket * (layout.rowHeight + ROW_GAP);
}

function rowRect(layout: TableLayout, bucket: number): Rect {
  return { x: TABLE_LEFT, y: rowTop(layout, bucket), w: WIDTH - TABLE_LEFT, h: layout.rowHeight };
}

function rowCenterY(layout: TableLayout, bucket: number): number {
  return rowTop(layout, bucket) + layout.rowHeight / 2;
}

function laneOpen(state: HashState, bucket: number): boolean {
  return state.visitor?.bucket === bucket;
}

function slotRect(layout: TableLayout, bucket: number, lane: boolean): Rect {
  const right = lane ? layout.laneRight : layout.slotRight;
  return { x: layout.openLeft, y: rowTop(layout, bucket) + layout.rowPad, w: right - layout.openLeft, h: layout.rowHeight - 2 * layout.rowPad };
}

function insetRect(rect: Rect, inset: number): Rect {
  return { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2 * inset, h: rect.h - 2 * inset };
}

function arrivalRect(layout: TableLayout, bucket: number): Rect {
  const h = layout.arrivalHeight;
  return { x: layout.arrivalLeft, y: rowCenterY(layout, bucket) - h / 2, w: layout.arrivalWidth, h };
}

function cellWidth(layout: TableLayout, bucket: number, length: number, lane: boolean): number {
  const inner = slotRect(layout, bucket, lane).w - 2 * layout.slotPad;
  const count = Math.max(1, length);
  return (inner - (count - 1) * LINK_GAP) / count;
}

function chainRect(layout: TableLayout, bucket: number, position: number, length: number, lane: boolean): Rect {
  const slot = slotRect(layout, bucket, lane);
  const w = cellWidth(layout, bucket, length, lane);
  const h = layout.pillHeight;
  return { x: slot.x + layout.slotPad + position * (w + LINK_GAP), y: rowCenterY(layout, bucket) - h / 2, w, h };
}

function chainsFit(state: HashState): boolean {
  const layout = tableLayout(state);
  return cellWidth(layout, 0, STRATEGIES[state.strategy].cells(state), true) >= widestKey(state, layout.keyText) + 2 * PILL_PAD_MIN;
}

function chipLook(state: HashState): PillLook {
  return { h: CHIP_HEIGHT, text: CHIP_TEXT, w: Math.max(CHIP_HEIGHT * CHIP_ASPECT, widestKey(state, CHIP_TEXT) + 2 * PILL_PAD_MIN) };
}

function gridColumns(state: HashState): number {
  return Math.max(1, Math.floor((SIDE_ROOM + GRID_GAP) / (chipLook(state).w + GRID_GAP)));
}

function gridHeight(state: HashState): number {
  const rows = Math.ceil(state.tray.length / gridColumns(state));
  return rows * CHIP_HEIGHT + (rows - 1) * GRID_GAP;
}

function noteSamples(state: HashState): string[] {
  const last = state.capacity - 1;
  return [formulaNote(state.capacity), modNote(MAX_KEY, state.capacity, last), STRATEGIES[state.strategy].resolveNote(MAX_KEY, last, state.capacity)];
}

function noteSize(state: HashState): number {
  return Math.max(MIN_TEXT, Math.min(...noteSamples(state).map((sample) => fitText(sample, NOTE_MAX, SIDE_ROOM, "read"))));
}

function sideGroups(state: HashState): [SideBlock, number][][] {
  const bar: [SideBlock, number] = ["bar", LOAD_BAR_HEIGHT];
  const grid: [SideBlock, number] = ["grid", gridHeight(state)];
  const title: [SideBlock, number] = ["title", TITLE_TEXT];
  const hasTray = state.tray.length > 0;
  if (!state.reading) return hasTray ? [[bar], [grid]] : [[bar]];
  const groups: [SideBlock, number][][] = [[["note", noteSize(state)]], [["load", LOAD_TEXT], bar]];
  return hasTray ? [...groups, [title, grid]] : groups;
}

function groupHeight(group: [SideBlock, number][]): number {
  return group.reduce((sum, [, height]) => sum + height, 0) + (group.length - 1) * STACK_GAP;
}

function sideTops(state: HashState): Partial<Record<SideBlock, number>> {
  const groups = sideGroups(state);
  const total = groups.reduce((sum, group) => sum + groupHeight(group), 0);
  const space = (HEIGHT - total) / (groups.length + 1);
  const tops: Partial<Record<SideBlock, number>> = {};
  let top = space;
  groups.forEach((group) => {
    group.forEach(([name, height]) => {
      tops[name] = top;
      top += height + STACK_GAP;
    });
    top += space - STACK_GAP;
  });
  return tops;
}

function waitingRect(state: HashState, index: number): Rect {
  const { w, h } = chipLook(state);
  const columns = gridColumns(state);
  const row = Math.floor(index / columns);
  const column = index % columns;
  const inRow = Math.min(columns, state.waiting.length - row * columns);
  const rowWidth = inRow * w + (inRow - 1) * GRID_GAP;
  const left = (SIDE_WIDTH - rowWidth) / 2;
  const top = sideTops(state).grid! + row * (h + GRID_GAP);
  return { x: left + (inRow - 1 - column) * (w + GRID_GAP), y: top, w, h };
}

function keyPlace(state: HashState, layout: TableLayout, key: number): KeyPlace {
  const waiting = state.waiting.indexOf(key);
  if (waiting >= 0) return { rect: waitingRect(state, waiting), text: CHIP_TEXT, stroke: keyColor(state, key) };
  if (state.visitor?.key === key) return { rect: arrivalRect(layout, state.visitor.bucket), text: layout.arrivalText, stroke: STRATEGIES[state.strategy].collision };
  const bucket = bucketOf(state, key);
  const chain = state.buckets[bucket]!;
  return { rect: chainRect(layout, bucket, chain.indexOf(key), chain.length, laneOpen(state, bucket)), text: layout.keyText, stroke: keyColor(state, key) };
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function keyDrawables(state: HashState, key: number, place: KeyPlace, z: number): Drawable[] {
  const id = `key-${key}`;
  const pill = boxDrawable(id, place.rect, { fill: "ground", stroke: place.stroke, strokeWidth: keyStroke(place.rect.h), radius: 1, z });
  if (!state.reading) return [pill];
  return [pill, textDrawable(`${id}-label`, String(key), center(place.rect), { size: place.text, font: "mark", z: z + 1 })];
}

function loadFraction(state: HashState): number {
  return state.placed.length / state.capacity;
}

function loadTrack(state: HashState): Rect {
  return { x: SIDE_PAD, y: sideTops(state).bar!, w: SIDE_ROOM, h: LOAD_BAR_HEIGHT };
}

function loadFill(state: HashState, fraction: number): Drawable[] {
  if (fraction <= 0) return [];
  const track = loadTrack(state);
  const inner: Rect = { ...insetRect(track, FILL_INSET), w: (track.w - 2 * FILL_INSET) * Math.min(1, fraction) };
  return [boxDrawable("load-fill", inner, { fill: "active", stroke: "none", radius: 0.5, z: 2 })];
}

function loadLabel(state: HashState): Drawable[] {
  if (!state.reading) return [];
  const at = { x: SIDE_WIDTH / 2, y: sideTops(state).load! + LOAD_TEXT / 2 };
  const text = `load ${state.placed.length} / ${state.capacity}`;
  return [textDrawable(`load-label-${text}`, text, at, { size: LOAD_TEXT, fill: "muted", z: 1 })];
}

function noteLabel(state: HashState): Drawable[] {
  if (!state.reading) return [];
  const size = noteSize(state);
  const at = { x: SIDE_WIDTH / 2, y: sideTops(state).note! + size / 2 };
  return [textDrawable(`note-${state.note}`, state.note, at, { size, z: 1 })];
}

function swappedText(label: (state: HashState) => Drawable[], before: HashState, after: HashState, showAfter: boolean): Drawable[] {
  const shown = label(showAfter ? after : before);
  const shownIds = new Set(shown.map((drawable) => drawable.id));
  const hidden = label(showAfter ? before : after).filter((drawable) => !shownIds.has(drawable.id));
  return [...shown, ...hidden.map((drawable) => ({ ...drawable, opacity: 0 }))];
}

function sideTextsBetween(before: HashState, after: HashState, noteAfter: boolean, loadAfter: boolean): Drawable[] {
  return [...swappedText(noteLabel, before, after, noteAfter), ...swappedText(loadLabel, before, after, loadAfter)];
}

function waitingTitle(state: HashState): Drawable[] {
  if (!state.reading || state.tray.length === 0) return [];
  const text = state.waiting.length > 0 ? "keys to insert" : "all keys placed";
  const at = { x: SIDE_WIDTH / 2, y: sideTops(state).title! + TITLE_TEXT / 2 };
  return [textDrawable(`waiting-title-${text}`, text, at, { size: TITLE_TEXT, fill: "muted", z: 1 })];
}

function sideDrawables(state: HashState): Drawable[] {
  const out: Drawable[] = [
    boxDrawable("panel", { x: 0, y: 0, w: SIDE_WIDTH, h: HEIGHT }, { fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1, z: 0 }),
    boxDrawable("load-track", loadTrack(state), { fill: "ground", stroke: "rule", strokeWidth: TRACK_STROKE, radius: 0.5, z: 1 }),
    ...loadFill(state, loadFraction(state)),
    ...loadLabel(state),
  ];
  return [...out, ...noteLabel(state), ...waitingTitle(state)];
}

const SLOT_LOOK: BoxLook = { fill: "fill2", stroke: "edge", strokeWidth: SLOT_STROKE, radius: 1, z: 1 };

function bucketDrawables(state: HashState, layout: TableLayout, bucket: number): Drawable[] {
  const out: Drawable[] = [
    boxDrawable(`row-${bucket}`, rowRect(layout, bucket), { fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1, z: 0 }),
    boxDrawable(`slot-${bucket}`, slotRect(layout, bucket, laneOpen(state, bucket)), SLOT_LOOK),
  ];
  if (!state.reading) return out;
  const at = { x: (TABLE_LEFT + layout.gap + layout.labelRight) / 2, y: rowCenterY(layout, bucket) };
  return [...out, textDrawable(`index-${bucket}`, String(bucket), at, { size: layout.indexSize, font: "mark", fill: "muted", z: 1 })];
}

function rowDrawables(state: HashState, layout: TableLayout): Drawable[] {
  return state.buckets.flatMap((_, bucket) => bucketDrawables(state, layout, bucket));
}

function linkBetween(key: number, from: Rect, to: Rect): Drawable {
  const y = from.y + from.h / 2;
  return { id: `link-${key}`, kind: "arrow", x: from.x + from.w + ARROW_CLEAR, y, x2: to.x - ARROW_CLEAR, y2: y, stroke: "ink", strokeWidth: LINK_STROKE, z: 2 };
}

function chainLinks(chain: number[], rects: Rect[]): Drawable[] {
  return chain.slice(1).map((key, position) => linkBetween(key, rects[position]!, rects[position + 1]!));
}

function linkDrawables(state: HashState, layout: TableLayout): Drawable[] {
  return state.buckets.flatMap((chain, bucket) =>
    chainLinks(
      chain,
      chain.map((_, position) => chainRect(layout, bucket, position, chain.length, laneOpen(state, bucket))),
    ),
  );
}

function collisionCross(layout: TableLayout, bucket: number, role: Role): Drawable[] {
  const x = layout.markX;
  const y = rowCenterY(layout, bucket);
  const half = layout.markHalf;
  const stroke = (id: string, rise: number): Drawable => ({ id, kind: "line", x: x - half, y: y - rise, x2: x + half, y2: y + rise, stroke: role, strokeWidth: MARK_STROKE, z: 6 });
  return [stroke("collide-a", half), stroke("collide-b", -half)];
}

function collisionDrawables(state: HashState, layout: TableLayout): Drawable[] {
  if (!state.visitor) return [];
  const rule = STRATEGIES[state.strategy];
  return rule.turnAway(layout, state.visitor.bucket, rule.collision);
}

function placeKey(state: HashState, key: number, bucket: number): HashState {
  const buckets = state.buckets.map((chain, index) => (index === bucket ? [...chain, key] : chain));
  return { ...state, buckets, placed: [...state.placed, key], visitor: null };
}

function land(state: HashState, key: number, bucket: number): HashState {
  if (state.buckets[bucket]!.length === 0) return placeKey(state, key, bucket);
  return { ...state, visitor: { key, bucket } };
}

function requireDrawable(state: HashState, where: string): HashState {
  if (!chainsFit(state)) {
    fail(
      `${where}: ${sharedBucketCount(state)} keys share one bucket at capacity ${state.capacity} and their chain does not fit across the table; use fewer keys that share a bucket, or a larger capacity`,
    );
  }
  return state;
}

function requireNoVisitor(state: HashState, opName: string): void {
  const visitor = state.visitor;
  if (visitor) fail(`op "${opName}" on ${state.objectId}: key ${visitor.key} still waits outside bucket ${visitor.bucket} after a collision; use "${STRATEGIES[state.strategy].resolveOp}" first`);
}

function requireVisitor(state: HashState, opName: string, strategy: Strategy): Visitor {
  if (state.strategy !== strategy)
    fail(`op "${opName}" on ${state.objectId}: "${opName}" is for "strategy": "${strategy}", but this table uses ${state.strategy}; use "${STRATEGIES[state.strategy].resolveOp}" instead`);
  if (!state.visitor) fail(`op "${opName}" on ${state.objectId}: no key is waiting on a collision; "${opName}" follows a hash that landed on a taken bucket`);
  return state.visitor;
}

function chosenKey(state: HashState, op: LabOp): number {
  const where = `op "hash" on ${state.objectId}`;
  const key = op.args.key ?? state.waiting[0];
  if (key === undefined) fail(`${where}: no key waits in "incoming"; name the key to insert, such as {"key": 5}`);
  if (!isKey(key)) fail(`${where}: "key" must be a whole number from 0 to ${MAX_KEY}, got ${JSON.stringify(key)}`);
  if (state.placed.includes(key)) fail(`${where}: key ${key} is already in the table; hash a key that is not stored yet`);
  if (!state.keys.includes(key) && state.keys.length >= MAX_KEYS) fail(`${where}: the table shows at most ${MAX_KEYS} keys; hash one of the waiting keys instead`);
  return key;
}

function hash(state: HashState, op: LabOp): HashState {
  requireNoVisitor(state, "hash");
  const key = chosenKey(state, op);
  if (state.strategy === "probing" && state.placed.length >= state.capacity) fail(`op "hash" on ${state.objectId}: all ${state.capacity} buckets are full; use "resize" first`);
  const bucket = key % state.capacity;
  const keys = state.keys.includes(key) ? state.keys : [...state.keys, key];
  const waiting = state.waiting.filter((other) => other !== key);
  const landed = land({ ...state, keys, waiting, note: modNote(key, state.capacity, bucket) }, key, bucket);
  return requireDrawable(landed, `op "hash" on ${state.objectId}`);
}

function probe(state: HashState): HashState {
  const { key, bucket } = requireVisitor(state, "probe", "probing");
  const next = (bucket + 1) % state.capacity;
  return land({ ...state, visitor: null, note: STRATEGIES.probing.resolveNote(key, bucket, state.capacity) }, key, next);
}

function chain(state: HashState): HashState {
  const { key, bucket } = requireVisitor(state, "chain", "chaining");
  return placeKey({ ...state, note: STRATEGIES.chaining.resolveNote(key, bucket, state.capacity) }, key, bucket);
}

function rehashedKeys(state: HashState): number[] {
  return state.visitor ? [...state.placed, state.visitor.key] : state.placed;
}

function resize(state: HashState, op: LabOp): HashState {
  if (state.capacity >= MAX_CAPACITY) fail(`op "resize" on ${state.objectId}: the table already has ${MAX_CAPACITY} buckets, the most that fit on screen`);
  const capacity = integerArg(op.args, "capacity", "resize", state.capacity + 1, MAX_CAPACITY, Math.min(MAX_CAPACITY, state.capacity * 2));
  const placed = rehashedKeys(state);
  if (state.strategy === "probing" && placed.length > capacity)
    fail(`op "resize" on ${state.objectId}: ${placed.length} keys do not fit in ${capacity} buckets with probing; use a "capacity" of at least ${placed.length}`);
  const buckets = storeAll(placed, capacity, state.strategy);
  return requireDrawable({ ...state, capacity, buckets, placed, visitor: null, note: formulaNote(capacity) }, `op "resize" on ${state.objectId}`);
}

function insertedKey(after: HashState): number {
  return after.visitor?.key ?? after.placed[after.placed.length - 1]!;
}

function holdsKey(state: HashState, key: number): boolean {
  return state.waiting.includes(key) || state.placed.includes(key) || state.visitor?.key === key;
}

function placeBetween(before: HashState, after: HashState, key: number, travel: number): KeyPlace {
  const to = keyPlace(after, tableLayout(after), key);
  const from = holdsKey(before, key) ? keyPlace(before, tableLayout(before), key) : to;
  return { rect: lerpRect(from.rect, to.rect, travel), text: lerp(from.text, to.text, travel), stroke: travel >= MARK_SHOW ? to.stroke : from.stroke };
}

function arrivingMarks(after: HashState, progress: number): Drawable[] {
  const opacity = clamp01((progress - MARK_SHOW) / (1 - MARK_SHOW));
  return collisionDrawables(after, tableLayout(after)).map((mark) => ({ ...mark, opacity }));
}

function enteringTable(after: HashState, key: number, eased: number, start: number): Drawable[] {
  const progress = clamp01(eased);
  const to = keyPlace(after, tableLayout(after), key);
  const place = { ...to, stroke: progress >= MARK_SHOW ? to.stroke : keyColor(after, key) };
  const opacity = clamp01((progress - start) / ENTER_FADE);
  return keyDrawables(after, key, place, FLIGHT_Z).map((drawable) => ({ ...drawable, opacity }));
}

function leavingTray(before: HashState, after: HashState, key: number, eased: number): Drawable[] {
  const progress = clamp01(eased);
  if (progress >= EXIT_SHARE) return enteringTable(after, key, progress, EXIT_SHARE);
  const from = keyPlace(before, tableLayout(before), key);
  const opacity = 1 - clamp01((progress - TRAY_HOLD) / (EXIT_SHARE - TRAY_HOLD));
  return keyDrawables(after, key, from, FLIGHT_Z).map((drawable) => ({ ...drawable, opacity }));
}

function laneOpeningBeforeVisitorShows(before: HashState, after: HashState, progress: number, end: number): Drawable[] {
  if (!after.visitor) return [];
  const bucket = after.visitor.bucket;
  const open = clamp01(progress / end);
  const from = slotRect(tableLayout(before), bucket, laneOpen(before, bucket));
  const slot = boxDrawable(`slot-${bucket}`, lerpRect(from, slotRect(tableLayout(after), bucket, true), open), SLOT_LOOK);
  const chain = after.buckets[bucket]!;
  const places = chain.map((member) => placeBetween(before, after, member, open));
  const pills = chain.flatMap((member, position) => keyDrawables(after, member, places[position]!, KEY_Z));
  return [
    slot,
    ...pills,
    ...chainLinks(
      chain,
      places.map((place) => place.rect),
    ),
  ];
}

function hashFlight(before: HashState, after: HashState, _op: LabOp, progress: number): Drawable[] {
  const key = insertedKey(after);
  const slide = clamp01((progress - EXIT_SHARE) / SLIDE_SHARE);
  const queue = after.waiting.flatMap((other) => keyDrawables(after, other, placeBetween(before, after, other, slide), KEY_Z));
  const enterAt = after.visitor ? EXIT_SHARE : 0;
  const flying = before.waiting.includes(key) ? leavingTray(before, after, key, progress) : enteringTable(after, key, progress, enterAt);
  const landed = progress >= MARK_SHOW;
  const title = swappedText(waitingTitle, before, after, progress >= EXIT_SHARE);
  const lane = laneOpeningBeforeVisitorShows(before, after, progress, EXIT_SHARE);
  return [...lane, ...flying, ...queue, ...arrivingMarks(after, progress), ...title, ...sideTextsBetween(before, after, true, landed)];
}

function leavingMarks(before: HashState, progress: number): Drawable[] {
  const opacity = 1 - clamp01(progress / PROBE_HOLD);
  return collisionDrawables(before, tableLayout(before)).map((mark) => ({ ...mark, opacity }));
}

function probeStep(before: HashState, after: HashState, _op: LabOp, progress: number): Drawable[] {
  const key = insertedKey(after);
  const travel = clamp01((progress - PROBE_HOLD) / (1 - PROBE_HOLD));
  const place = placeBetween(before, after, key, travel);
  const marks = after.visitor && progress >= PROBE_HOLD ? arrivingMarks(after, travel) : leavingMarks(before, progress);
  const lane = after.visitor && after.visitor.bucket !== before.visitor?.bucket ? laneOpeningBeforeVisitorShows(before, after, progress, PROBE_HOLD) : [];
  return [...lane, ...keyDrawables(after, key, place, FLIGHT_Z), ...marks, ...sideTextsBetween(before, after, true, travel >= MARK_SHOW)];
}

function joinChain(before: HashState, after: HashState, _op: LabOp, progress: number): Drawable[] {
  const key = insertedKey(after);
  const bucket = bucketOf(after, key);
  const travel = clamp01(progress / LINK_SHOW);
  const chain = after.buckets[bucket]!;
  const places = chain.map((member) => placeBetween(before, after, member, travel));
  const pills = chain.flatMap((member, position) => keyDrawables(after, member, places[position]!, member === key ? FLIGHT_Z : KEY_Z));
  const links = chainLinks(
    chain,
    places.map((place) => place.rect),
  ).map((link) => (link.id === `link-${key}` && travel < 1 ? { ...link, opacity: 0 } : link));
  return [...pills, ...links, ...sideTextsBetween(before, after, true, travel >= 1)];
}

function lerpLayout(from: TableLayout, to: TableLayout, t: number): TableLayout {
  const fields = Object.keys(from) as (keyof TableLayout)[];
  return Object.fromEntries(fields.map((field) => [field, lerp(from[field], to[field], t)])) as unknown as TableLayout;
}

function resizePhases(progress: number): { reflow: number; rowsIn: number; swap: number } {
  const share = (start: number, end: number) => clamp01((progress - start) / (end - start));
  return { reflow: share(0, REFLOW_END), rowsIn: share(REFLOW_END, ROWS_IN_END), swap: share(ROWS_IN_END, SWAP_END) };
}

function swapOpacities(swap: number, order: number, count: number): { fadeOut: number; fadeIn: number } {
  const local = swap * count - order;
  return { fadeOut: 1 - clamp01(local / SWAP_FADE), fadeIn: clamp01((local - SWAP_FADE) / SWAP_FADE) };
}

function samePlace(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h) < SAME_PLACE;
}

function rehashPlan(before: HashState, after: HashState, moving: TableLayout, swap: number): Map<number, Rehash> {
  const settled = tableLayout(after);
  const movers = after.placed.filter((key) => !samePlace(keyPlace(before, settled, key).rect, keyPlace(after, settled, key).rect));
  const plan = new Map<number, Rehash>();
  after.placed.forEach((key) => {
    const moved = movers.includes(key);
    const opacities = moved ? swapOpacities(swap, movers.indexOf(key), movers.length) : { fadeOut: 1, fadeIn: 1 };
    plan.set(key, {
      moved,
      from: keyPlace(before, moving, key),
      to: keyPlace(after, settled, key),
      ...opacities,
    });
  });
  return plan;
}

function resizedRows(before: HashState, after: HashState, moving: TableLayout, rowsIn: number): Drawable[] {
  return after.buckets.flatMap((_, bucket) =>
    bucket < before.capacity ? bucketDrawables(after, moving, bucket) : bucketDrawables(after, tableLayout(after), bucket).map((drawable) => ({ ...drawable, opacity: rowsIn })),
  );
}

function fadedLinks(buckets: number[][], plan: Map<number, Rehash>, side: "from" | "to"): Drawable[] {
  const fade = side === "from" ? "fadeOut" : "fadeIn";
  return buckets.flatMap((chain) =>
    chainLinks(
      chain,
      chain.map((key) => plan.get(key)![side].rect),
    ).map((link, index) => ({ ...link, opacity: Math.min(plan.get(chain[index]!)![fade], plan.get(chain[index + 1]!)![fade]) })),
  );
}

function resizedLinks(before: HashState, after: HashState, plan: Map<number, Rehash>): Drawable[] {
  const links = new Map<string, Drawable>();
  fadedLinks(before.buckets, plan, "from").forEach((link) => links.set(link.id, link));
  fadedLinks(after.buckets, plan, "to").forEach((link) => {
    if ((link.opacity ?? 1) > (links.get(link.id)?.opacity ?? 0)) links.set(link.id, link);
  });
  return [...links.values()];
}

function rehashedKey(after: HashState, key: number, step: Rehash): Drawable[] {
  const showing = step.moved && step.fadeOut <= 0 ? { place: step.to, opacity: step.fadeIn } : { place: step.from, opacity: step.fadeOut };
  return keyDrawables(after, key, showing.place, KEY_Z).map((drawable) => ({ ...drawable, opacity: showing.opacity }));
}

function resizedSide(before: HashState, after: HashState, rowsIn: number, grown: boolean): Drawable[] {
  const fraction = lerp(loadFraction(before), loadFraction(after), rowsIn);
  return [...loadFill(after, fraction), ...sideTextsBetween(before, after, grown, grown)];
}

function rehashFlights(before: HashState, after: HashState, _op: LabOp, progress: number): Drawable[] {
  const { reflow, rowsIn, swap } = resizePhases(clamp01(progress));
  const moving = lerpLayout(tableLayout(before), tableLayout(after), reflow);
  const plan = rehashPlan(before, after, moving, swap);
  const keys = after.placed.flatMap((key) => rehashedKey(after, key, plan.get(key)!));
  return [...resizedRows(before, after, moving, rowsIn), ...resizedLinks(before, after, plan), ...keys, ...leavingMarks(before, progress), ...resizedSide(before, after, rowsIn, rowsIn > 0)];
}

export const lab: LabDef<HashSpec, HashState> = {
  id: "hash",
  title: "Hash table",
  reading: "optional",
  catalog: {
    summary:
      'A hash table: hash turns a key into a bucket index (key mod capacity), a collision is resolved by chaining or by linear probing, and resize grows the table and rehashes every key. A side panel shows the last calculation, a load bar of keys over buckets, and any keys waiting to be inserted. Put the object alone in "on"; parts are not used.',
    spec: {
      capacity: "whole number of buckets, 2 to 12, default 4",
      strategy: '"chaining" (default): a bucket holds a chain of keys; "probing" (or "open"): open addressing, one key per bucket, and a collision steps on to the next bucket',
      keys: "list of 0 to 12 different whole numbers from 0 to 999 already stored in the table at the start, inserted in this order; default []",
      incoming:
        'optional list of different whole numbers from 0 to 999 waiting in the side panel; a "hash" with no "key" takes the next one; default []; "keys" and "incoming" hold at most 12 together',
      reading: "optional boolean, default true; false draws keys as colored pills with no numbers",
    },
    example: [
      '{"step":1,"say":"One already sits in bucket one. Five mod four is also one, so five is turned away and probes the next bucket, two.","scene":{"table":{"lab":"hash","capacity":4,"strategy":"probing","keys":[1]}},"do":[{"cue":"Five mod four","op":"hash","on":["table"],"key":5},{"cue":"probes","op":"probe","on":["table"]}]}',
      '{"step":1,"say":"Five lands in bucket one, then nine lands there too and joins its chain.","scene":{"table":{"lab":"hash","capacity":4,"incoming":[5,9]}},"do":[{"cue":"Five lands","op":"hash","on":["table"]},{"cue":"nine lands","op":"hash","on":["table"]},{"cue":"joins","op":"chain","on":["table"]}]}',
    ],
  },

  init(spec, objectId) {
    const capacity = integerField(spec, "capacity", DEFAULT_CAPACITY, MIN_CAPACITY, MAX_CAPACITY, objectId);
    const strategy = readStrategy(spec, objectId);
    const { stored, incoming } = readAllKeys(spec, objectId);
    if (strategy === "probing" && stored.length > capacity) fail(`${objectId}: ${stored.length} "keys" do not fit in ${capacity} buckets with probing; raise "capacity" or move keys to "incoming"`);
    if (spec.reading !== undefined && typeof spec.reading !== "boolean") fail(`${objectId}: "reading" must be true or false`);
    const state: HashState = {
      objectId,
      reading: readsWords(spec),
      strategy,
      capacity,
      keys: [...stored, ...incoming],
      tray: incoming,
      waiting: incoming,
      placed: stored,
      buckets: storeAll(stored, capacity, strategy),
      visitor: null,
      note: formulaNote(capacity),
    };
    return requireDrawable(state, objectId);
  },

  ops: {
    hash: {
      doc: '{"key": 3}, or no "key" to take the next "incoming" key; any key not yet stored may be named; shows "3 mod 4 = 3" and sends the key to that bucket; an empty bucket takes it; a taken bucket turns it away: it waits outside the bucket with a collision mark until probe (probing) or chain (chaining)',
      seconds: 1.1,
      apply: hash,
      during: hashFlight,
    },
    probe: {
      doc: '"strategy": "probing" only, after a collision: the key that was turned away steps to the next bucket, (b + 1) mod capacity, and settles if it is empty or collides again',
      seconds: 0.9,
      apply: probe,
      during: probeStep,
    },
    chain: {
      doc: '"strategy": "chaining" only, after a hash that landed on a taken bucket: the waiting key moves to the end of its bucket\'s chain and an arrow links it to the key before it',
      seconds: 0.9,
      apply: chain,
      during: joinChain,
    },
    resize: {
      doc: 'optional {"capacity": 8}, default double, at most 12; grows the table and rehashes every stored key one by one, in the order they went in; a key still waiting on a collision is rehashed last, along with them',
      seconds: (_op, state) => RESIZE_BASE_SECONDS + RESIZE_SECONDS_PER_KEY * rehashedKeys(state).length,
      apply: resize,
      during: rehashFlights,
    },
  },

  size() {
    return { w: WIDTH, h: HEIGHT };
  },

  draw(state) {
    const layout = tableLayout(state);
    return [
      ...sideDrawables(state),
      ...rowDrawables(state, layout),
      ...linkDrawables(state, layout),
      ...state.keys.flatMap((key) => keyDrawables(state, key, keyPlace(state, layout, key), KEY_Z)),
      ...collisionDrawables(state, layout),
    ];
  },
};
