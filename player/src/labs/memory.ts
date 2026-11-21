import { boxDrawable, type Drawable, fail, integerArg, type LabDef, type LabOp, lerp, type Point, type Rect, readsWords, type Role, stringArg, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

interface Byte {
  char: string | null;
  fault: boolean;
}

interface DataVariable {
  kind: "data";
  name: string;
  bytes: Byte[];
}

interface Target {
  block: string;
  at: number;
}

interface PointerVariable {
  kind: "pointer";
  name: string;
  target: Target | null;
  corrupt: boolean;
}

type Variable = DataVariable | PointerVariable;

interface Frame {
  name: string;
  vars: Variable[];
}

interface Block {
  name: string;
  bytes: Byte[];
  freed: boolean;
}

interface MemoryState {
  objectId: string;
  reading: boolean;
  frames: Frame[];
  heap: Block[];
}

type MemorySpec = {
  frames?: unknown;
  reading?: unknown;
};

type Area = "stack" | "heap";

interface Region {
  name: string;
  size: number;
}

interface Spot {
  region: string;
  offset: number;
}

interface WritePlan {
  start: string;
  text: string[];
  spots: Spot[];
}

interface RowPlace {
  variable: Variable;
  label: Point;
  cells: Point;
}

interface FramePlace {
  frame: Frame;
  rect: Rect;
  title: Point;
  rows: RowPlace[];
}

interface BlockPlace {
  block: Block;
  cells: Point;
  label: Point;
}

interface Layout {
  cell: number;
  frames: FramePlace[];
  blocks: BlockPlace[];
}

type PointerStatus = "null" | "aimed" | "dangling" | "corrupt";

interface PointerLook {
  outline: Role | "own";
  ink: Role | "own";
  word: string | null;
  arrow: boolean;
}

const SERIES: Role[] = ["series1", "series2", "series3", "series4", "series5", "series6"];
const MAX_FRAMES = 3;
const MAX_ROWS = 6;
const MAX_VARS = 4;
const MAX_BYTES = 8;
const MAX_BLOCKS = 4;
const MAX_POINTERS = SERIES.length;
const MAX_NAME = 8;
const POINTER_BYTES = 8;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const WIDTH = 1480;
const HEIGHT = 760;
const GUTTER = 190;
const PANEL_WIDTH = (WIDTH - GUTTER) / 2;
const HEAP_LEFT = PANEL_WIDTH + GUTTER;
const PANEL_PAD = 28;
const CONTENT_TOP = 76;
const ROOM = { w: PANEL_WIDTH - 2 * PANEL_PAD, h: HEIGHT - CONTENT_TOP - PANEL_PAD };
const TITLE_Y = 40;
const TITLE_SIZE = 30;

const MAX_CELL = 140;
const MIN_CELL = 48;
const CELL_STEP = 4;
const CELL_SIZES = Array.from({ length: (MAX_CELL - MIN_CELL) / CELL_STEP + 1 }, (_, index) => MAX_CELL - index * CELL_STEP);
const BYTE_TEXT_SHARE = 0.56;
const MAX_BYTE_TEXT = 40;
const DOT_SHARE = 0.14;
const CELL_STROKE = 1.5;
const FAULT_INSET_SHARE = 0.2;
const FAULT_STROKE = 3;

const LABEL_SIZE = 34;
const LABEL_GAP = 28;
const FRAME_HEAD = 62;
const FRAME_NAME_Y = 30;
const FRAME_PAD = 44;
const ROW_GAP = 32;
const FRAME_GAP = 32;

const POINTER_BOX_CELLS = 3;
const BOX_TEXT_PAD = 16;
const BOX_STROKE = 2.5;
const ROUTE_STROKE = 3;
const ARROW_GAP = 12;
const DOT_CLEARANCE = 12;
const DOT_INSET_RADII = 2;
const ARROW_LENGTH = 72;
const LEVEL_STEP = 14;
const MAX_LEVEL = 1;
const APPROACH = ARROW_GAP + ARROW_LENGTH + MAX_LEVEL * LEVEL_STEP + 12;

const FREED_WORD = "(freed)";
const CAPTION_GAP = 44;
const BLOCK_LABEL_BAND = CAPTION_GAP + LABEL_SIZE;
const FREED_STROKE = 3;
const DASHES_PER_SIDE = 4;
const DASH_SHARE = 0.5;

const WRITE_BASE_SECONDS = 0.4;
const WRITE_BYTE_SECONDS = 0.12;
const MAX_WRITE_SECONDS = 2.4;

const POINTER_LOOKS: Record<PointerStatus, PointerLook> = {
  null: { outline: "own", ink: "muted", word: "NULL", arrow: false },
  aimed: { outline: "own", ink: "own", word: null, arrow: true },
  dangling: { outline: "fault", ink: "fault", word: null, arrow: true },
  corrupt: { outline: "fault", ink: "fault", word: "??", arrow: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characters(text: string): string[] {
  return Array.from(text);
}

function readName(raw: unknown, subject: string, key: string): string {
  if (typeof raw !== "string" || !NAME_PATTERN.test(raw) || raw.length > MAX_NAME) {
    fail(`${subject} needs "${key}" as a C name of up to ${MAX_NAME} letters, digits or underscores, such as "buf", got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function readByteCount(raw: unknown, subject: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_BYTES) {
    fail(`${subject} needs "bytes" as a whole number from 1 to ${MAX_BYTES}, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function emptyBytes(count: number): Byte[] {
  return Array.from({ length: count }, () => ({ char: null, fault: false }));
}

function readVariable(raw: unknown, subject: string): Variable {
  if (!isRecord(raw)) fail(`${subject} must be an object such as {"name":"buf","bytes":8} or {"name":"p","pointer":true}`);
  const name = readName(raw.name, subject, "name");
  if (raw.pointer === true) {
    if (raw.bytes !== undefined || raw.text !== undefined) fail(`${subject} is a pointer, so drop "bytes" and "text"; aim it with the pointer-arrow op`);
    return { kind: "pointer", name, target: null, corrupt: false };
  }
  if (raw.pointer !== undefined && raw.pointer !== false) fail(`${subject} "pointer" must be true or left out`);
  const count = readByteCount(raw.bytes, subject);
  const text = raw.text ?? "";
  if (typeof text !== "string" || characters(text).length > count) fail(`${subject} "text" must be text of at most ${count} characters, one per byte`);
  const bytes = emptyBytes(count).map((byte, index) => ({ ...byte, char: characters(text)[index] ?? null }));
  return { kind: "data", name, bytes };
}

function readFrame(raw: unknown, subject: string): Frame {
  if (!isRecord(raw)) fail(`${subject} must be an object such as {"name":"main","vars":[{"name":"buf","bytes":8}]}`);
  const name = readName(raw.name, subject, "name");
  const { vars } = raw;
  if (!Array.isArray(vars) || vars.length === 0 || vars.length > MAX_VARS) {
    fail(`${subject} needs "vars", a list of 1 to ${MAX_VARS} variables such as [{"name":"buf","bytes":8},{"name":"p","pointer":true}]`);
  }
  return { name, vars: vars.map((entry, index) => readVariable(entry, `${subject} vars[${index}]`)) };
}

function readFrames(raw: unknown, objectId: string): Frame[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${objectId}: "frames" must be a list such as [{"name":"main","vars":[{"name":"buf","bytes":8}]}]`);
  return raw.map((entry, index) => readFrame(entry, `${objectId}: frames[${index}]`)).reverse();
}

function allVariables(state: MemoryState): Variable[] {
  return state.frames.flatMap((frame) => frame.vars);
}

function pointerNames(state: MemoryState): string[] {
  return [...state.frames].reverse().flatMap((frame) => frame.vars.filter((variable) => variable.kind === "pointer").map((variable) => variable.name));
}

function pointerColor(state: MemoryState, name: string): Role {
  return SERIES[pointerNames(state).indexOf(name)]!;
}

function checked(state: MemoryState, subject: string): MemoryState {
  const variables = allVariables(state);
  if (state.frames.length > MAX_FRAMES) fail(`${subject}: the stack holds at most ${MAX_FRAMES} frames; start a new scene for a deeper call chain`);
  if (variables.length > MAX_ROWS) fail(`${subject}: the stack holds at most ${MAX_ROWS} variables across all frames, got ${variables.length}; drop some`);
  if (pointerNames(state).length > MAX_POINTERS) fail(`${subject}: at most ${MAX_POINTERS} pointer variables fit; drop some`);
  if (state.heap.length > MAX_BLOCKS) fail(`${subject}: the heap holds at most ${MAX_BLOCKS} blocks, freed ones included; start a new scene for more`);
  const names = [...variables.map((variable) => variable.name), ...state.heap.map((block) => block.name)];
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) fail(`${subject}: the name "${repeated}" is used twice; every variable and heap block needs its own name`);
  return state;
}

function withVariable(state: MemoryState, name: string, change: (variable: Variable) => Variable): MemoryState {
  return {
    ...state,
    frames: state.frames.map((frame) => ({ ...frame, vars: frame.vars.map((variable) => (variable.name === name ? change(variable) : variable)) })),
  };
}

function withBlock(state: MemoryState, name: string, change: (block: Block) => Block): MemoryState {
  return { ...state, heap: state.heap.map((block) => (block.name === name ? change(block) : block)) };
}

function aim(state: MemoryState, pointer: string, target: Target | null): MemoryState {
  return withVariable(state, pointer, (variable) => (variable.kind === "pointer" ? { ...variable, target, corrupt: false } : variable));
}

function listed(names: string[], none: string): string {
  return names.length > 0 ? names.join(", ") : none;
}

function pointerArg(state: MemoryState, op: LabOp, key: string): PointerVariable {
  const name = stringArg(op.args, key, op.name);
  const found = allVariables(state).find((variable) => variable.name === name);
  if (found?.kind !== "pointer") {
    fail(`op "${op.name}": "${key}" must name a pointer variable, got "${name}"; pointers are ${listed(pointerNames(state), 'none (declare one as {"name":"p","pointer":true})')}`);
  }
  return found;
}

function blockArg(state: MemoryState, op: LabOp): Block {
  const name = stringArg(op.args, "block", op.name);
  const found = state.heap.find((block) => block.name === name);
  if (!found)
    fail(
      `op "${op.name}": the heap has no block "${name}"; blocks are ${listed(
        state.heap.map((block) => block.name),
        "none yet (use malloc)",
      )}`,
    );
  return found;
}

function pointerStatus(state: MemoryState, pointer: PointerVariable): PointerStatus {
  if (pointer.corrupt) return "corrupt";
  if (pointer.target === null) return "null";
  const target = pointer.target.block;
  return state.heap.some((block) => block.name === target && block.freed) ? "dangling" : "aimed";
}

function pushFrame(state: MemoryState, op: LabOp): MemoryState {
  const subject = 'op "push-frame"';
  return checked({ ...state, frames: [readFrame(op.args, subject), ...state.frames] }, subject);
}

function malloc(state: MemoryState, op: LabOp): MemoryState {
  const subject = 'op "malloc"';
  const name = readName(op.args.block, subject, "block");
  const block: Block = { name, bytes: emptyBytes(readByteCount(op.args.bytes, subject)), freed: false };
  const grown = checked({ ...state, heap: [...state.heap, block] }, subject);
  if (op.args.pointer === undefined) return grown;
  return aim(grown, pointerArg(grown, op, "pointer").name, { block: name, at: 0 });
}

function free(state: MemoryState, op: LabOp): MemoryState {
  const block = blockArg(state, op);
  if (block.freed) fail(`op "free": block "${block.name}" is already freed, and freeing it again is a double free; free a live block instead`);
  return withBlock(state, block.name, (entry) => ({ ...entry, freed: true }));
}

function pointerArrow(state: MemoryState, op: LabOp): MemoryState {
  const pointer = pointerArg(state, op, "pointer");
  if (op.args.block === null) return aim(state, pointer.name, null);
  const block = blockArg(state, op);
  const at = integerArg(op.args, "at", op.name, 0, block.bytes.length - 1, 0);
  return aim(state, pointer.name, { block: block.name, at });
}

function regionsOf(state: MemoryState, area: Area): Region[] {
  if (area === "heap") return state.heap.map((block) => ({ name: block.name, size: block.bytes.length }));
  return allVariables(state).map((variable) => ({ name: variable.name, size: variable.kind === "data" ? variable.bytes.length : POINTER_BYTES }));
}

function writeStart(state: MemoryState, op: LabOp): { area: Area; region: Region; offset: number } {
  if (op.args.through !== undefined) {
    const pointer = pointerArg(state, op, "through");
    const status = pointerStatus(state, pointer);
    if (status === "null") fail(`op "write-bytes": ${pointer.name} is NULL, so writing through it would crash; aim it with pointer-arrow or malloc first`);
    if (status === "corrupt") fail(`op "write-bytes": ${pointer.name} was overwritten and holds garbage; aim it again with pointer-arrow first`);
    const target = pointer.target!;
    return { area: "heap", region: regionsOf(state, "heap").find((region) => region.name === target.block)!, offset: target.at };
  }
  const name = stringArg(op.args, "into", op.name);
  const pointer = allVariables(state).find((variable) => variable.name === name && variable.kind === "pointer");
  if (pointer) fail(`op "write-bytes": ${name} is a pointer; write to where it points with "through": "${name}" instead of "into"`);
  const area: Area = state.heap.some((block) => block.name === name) ? "heap" : "stack";
  const region = regionsOf(state, area).find((entry) => entry.name === name);
  if (!region) {
    const known = [
      ...allVariables(state)
        .filter((variable) => variable.kind === "data")
        .map((variable) => variable.name),
      ...state.heap.map((block) => block.name),
    ];
    fail(`op "write-bytes": "into" must name a variable or heap block, got "${name}"; names are ${listed(known, "none yet")}`);
  }
  return { area, region, offset: integerArg(op.args, "at", op.name, 0, region.size - 1, 0) };
}

function writePlan(state: MemoryState, op: LabOp): WritePlan {
  const text = characters(stringArg(op.args, "text", op.name));
  if (text.length === 0) fail(`op "write-bytes" needs "text" with at least one character, one per byte`);
  const { area, region, offset } = writeStart(state, op);
  const bytes = regionsOf(state, area).flatMap((entry) => Array.from({ length: entry.size }, (_, index): Spot => ({ region: entry.name, offset: index })));
  const first = bytes.findIndex((spot) => spot.region === region.name && spot.offset === offset);
  const spots = bytes.slice(first, first + text.length);
  if (spots.length < text.length) {
    fail(`op "write-bytes": the text is ${text.length} bytes but only ${spots.length} fit from ${region.name}[${offset}] to the end of the ${area}; shorten the text`);
  }
  return { start: region.name, text, spots };
}

function replaced(bytes: Byte[], offset: number, byte: Byte): Byte[] {
  return bytes.map((existing, index) => (index === offset ? byte : existing));
}

function storeByte(state: MemoryState, spot: Spot, char: string, spilled: boolean): MemoryState {
  if (state.heap.some((block) => block.name === spot.region)) {
    return withBlock(state, spot.region, (block) => ({ ...block, bytes: replaced(block.bytes, spot.offset, { char, fault: spilled || block.freed }) }));
  }
  return withVariable(state, spot.region, (variable) =>
    variable.kind === "pointer" ? { ...variable, corrupt: true } : { ...variable, bytes: replaced(variable.bytes, spot.offset, { char, fault: spilled }) },
  );
}

function writeBytes(state: MemoryState, op: LabOp): MemoryState {
  const { start, text, spots } = writePlan(state, op);
  return spots.reduce((next, spot, index) => storeByte(next, spot, text[index]!, spot.region !== start), state);
}

function writeSeconds(op: LabOp): number {
  const { text } = op.args;
  const length = typeof text === "string" ? characters(text).length : 1;
  return Math.min(MAX_WRITE_SECONDS, WRITE_BASE_SECONDS + WRITE_BYTE_SECONDS * length);
}

function wordWidth(state: MemoryState, text: string, size: number, font: "code" | "read"): number {
  return state.reading ? textWidth(text, size, font) : 0;
}

function byteTextSize(cell: number): number {
  return Math.min(MAX_BYTE_TEXT, cell * BYTE_TEXT_SHARE);
}

function widestDataRow(state: MemoryState, cell: number): number {
  return Math.max(0, ...allVariables(state).map((variable) => (variable.kind === "data" ? variable.bytes.length * cell : 0)));
}

function addressText(target: Target): string {
  return `&${target.block}[${target.at}]`;
}

function pointerWord(state: MemoryState, pointer: PointerVariable): string {
  return POINTER_LOOKS[pointerStatus(state, pointer)].word ?? addressText(pointer.target!);
}

function dotRadius(cell: number): number {
  return cell * DOT_SHARE;
}

function pointerBoxWidth(state: MemoryState, cell: number): number {
  const fixedWords = Object.values(POINTER_LOOKS).flatMap((look) => (look.word ? [look.word] : []));
  const addresses = allVariables(state).flatMap((variable) => (variable.kind === "pointer" && variable.target ? [addressText(variable.target)] : []));
  const widestWord = Math.max(...[...fixedWords, ...addresses].map((word) => wordWidth(state, word, byteTextSize(cell), "code")));
  const dotRoom = (DOT_INSET_RADII + 1) * dotRadius(cell) + DOT_CLEARANCE;
  return Math.max(cell * POINTER_BOX_CELLS, widestDataRow(state, cell), widestWord + 2 * (BOX_TEXT_PAD + dotRoom));
}

function cellsWidth(state: MemoryState, variable: Variable, cell: number): number {
  return variable.kind === "data" ? variable.bytes.length * cell : pointerBoxWidth(state, cell);
}

function rowLabelWidth(state: MemoryState): number {
  return Math.max(...allVariables(state).map((variable) => wordWidth(state, variable.name, LABEL_SIZE, "code")));
}

function frameWidth(state: MemoryState, frame: Frame, cell: number): number {
  const rows = rowLabelWidth(state) + LABEL_GAP + Math.max(...frame.vars.map((variable) => cellsWidth(state, variable, cell)));
  return 2 * FRAME_PAD + Math.max(wordWidth(state, frame.name, LABEL_SIZE, "code"), rows);
}

function frameHeight(frame: Frame, cell: number): number {
  return FRAME_HEAD + frame.vars.length * cell + (frame.vars.length - 1) * ROW_GAP + FRAME_PAD;
}

function stackExtent(state: MemoryState, cell: number): { w: number; h: number } {
  if (state.frames.length === 0) return { w: 0, h: 0 };
  const heights = state.frames.map((frame) => frameHeight(frame, cell));
  return {
    w: Math.max(...state.frames.map((frame) => frameWidth(state, frame, cell))),
    h: heights.reduce((sum, height) => sum + height, 0) + (state.frames.length - 1) * FRAME_GAP,
  };
}

function freedWordGap(state: MemoryState): number {
  return wordWidth(state, " ", LABEL_SIZE, "read");
}

function freedLabelWidth(state: MemoryState, name: string): number {
  return wordWidth(state, name, LABEL_SIZE, "code") + freedWordGap(state) + wordWidth(state, FREED_WORD, LABEL_SIZE, "read");
}

function heapLabelWidth(state: MemoryState): number {
  return Math.max(...state.heap.map((block) => freedLabelWidth(state, block.name)));
}

function widestBlock(state: MemoryState): number {
  return Math.max(...state.heap.map((block) => block.bytes.length));
}

function blockBand(cell: number): number {
  return APPROACH + cell + BLOCK_LABEL_BAND;
}

function heapExtent(state: MemoryState, cell: number): { w: number; h: number } {
  if (state.heap.length === 0) return { w: 0, h: 0 };
  return { w: Math.max(widestBlock(state) * cell, heapLabelWidth(state)), h: state.heap.length * blockBand(cell) };
}

function fitsRoom(extent: { w: number; h: number }): boolean {
  return extent.w <= ROOM.w && extent.h <= ROOM.h;
}

function cellSize(state: MemoryState): number {
  return CELL_SIZES.find((cell) => fitsRoom(stackExtent(state, cell)) && fitsRoom(heapExtent(state, cell))) ?? MIN_CELL;
}

function placeFrames(state: MemoryState, cell: number): FramePlace[] {
  const extent = stackExtent(state, cell);
  const contentWidth = extent.w - 2 * FRAME_PAD;
  let top = CONTENT_TOP + (ROOM.h - extent.h) / 2;
  return state.frames.map((frame) => {
    const rect = { x: PANEL_PAD, y: top, w: ROOM.w, h: frameHeight(frame, cell) };
    top += rect.h + FRAME_GAP;
    const labelLeft = rect.x + (ROOM.w - contentWidth) / 2;
    const cellsLeft = labelLeft + rowLabelWidth(state) + LABEL_GAP;
    const rows = frame.vars.map((variable, index): RowPlace => {
      const rowTop = rect.y + FRAME_HEAD + index * (cell + ROW_GAP);
      return { variable, label: { x: labelLeft, y: rowTop + cell / 2 }, cells: { x: cellsLeft, y: rowTop } };
    });
    return { frame, rect, title: { x: labelLeft, y: rect.y + FRAME_NAME_Y }, rows };
  });
}

function placeBlocks(state: MemoryState, cell: number): BlockPlace[] {
  const extent = heapExtent(state, cell);
  const left = HEAP_LEFT + PANEL_PAD + (ROOM.w - widestBlock(state) * cell) / 2;
  const top = CONTENT_TOP + (ROOM.h - extent.h) / 2;
  return state.heap.map((block, index) => {
    const cellsTop = top + index * blockBand(cell) + APPROACH;
    const label = { x: left + (block.bytes.length * cell) / 2, y: cellsTop + cell + CAPTION_GAP + LABEL_SIZE / 2 };
    return { block, cells: { x: left, y: cellsTop }, label };
  });
}

function layoutOf(state: MemoryState): Layout {
  const cell = cellSize(state);
  return { cell, frames: placeFrames(state, cell), blocks: placeBlocks(state, cell) };
}

function rectSides(rect: Rect): [Point, Point][] {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
  return corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]!]);
}

function dashDrawable(id: string, from: Point, to: Point, index: number): Drawable {
  const step = 1 / DASHES_PER_SIDE;
  const head = index * step + (step * (1 - DASH_SHARE)) / 2;
  const tail = head + step * DASH_SHARE;
  return {
    id: `${id}-${index}`,
    kind: "line",
    x: lerp(from.x, to.x, head),
    y: lerp(from.y, to.y, head),
    x2: lerp(from.x, to.x, tail),
    y2: lerp(from.y, to.y, tail),
    stroke: "ink",
    strokeWidth: FREED_STROKE,
    z: 3,
  };
}

function dashedOutline(id: string, rect: Rect): Drawable[] {
  return rectSides(rect).flatMap(([from, to], side) => Array.from({ length: DASHES_PER_SIDE }, (_, index) => dashDrawable(`${id}-dash-${side}`, from, to, index)));
}

function byteDrawables(state: MemoryState, id: string, byte: Byte, at: Point, cell: number, freed: boolean): Drawable[] {
  const rect = { x: at.x, y: at.y, w: cell, h: cell };
  const center = { x: at.x + cell / 2, y: at.y + cell / 2 };
  const drawn = [boxDrawable(`${id}-cell`, rect, { fill: freed ? "fill" : "fill2", stroke: freed ? "none" : "edge", strokeWidth: CELL_STROKE, z: 2 })];
  if (byte.fault) {
    const inset = cell * FAULT_INSET_SHARE;
    const inner = { x: rect.x + inset, y: rect.y + inset, w: cell - 2 * inset, h: cell - 2 * inset };
    drawn.push(boxDrawable(`${id}-fault`, inner, { fill: "none", stroke: "fault", strokeWidth: FAULT_STROKE, z: 3 }));
  }
  if (freed) drawn.push(...dashedOutline(id, rect));
  if (byte.char === null) return drawn;
  if (state.reading) return [...drawn, textDrawable(`${id}-char`, byte.char, center, { size: byteTextSize(cell), font: "code", fill: "ink", z: 4 })];
  return [...drawn, { id: `${id}-dot`, kind: "circle", x: center.x, y: center.y, r: dotRadius(cell), fill: "ink", z: 4 }];
}

function bytesDrawables(state: MemoryState, name: string, bytes: Byte[], at: Point, cell: number, freed: boolean): Drawable[] {
  return bytes.flatMap((byte, index) => byteDrawables(state, `${name}-${index}`, byte, { x: at.x + index * cell, y: at.y }, cell, freed));
}

function labelDrawables(state: MemoryState, id: string, text: string, at: Point, anchor: "start" | "middle" | "end", fill: Role): Drawable[] {
  return state.reading ? [textDrawable(id, text, at, { size: LABEL_SIZE, font: "code", fill, anchor, z: 2 })] : [];
}

function resolved(state: MemoryState, pointer: PointerVariable, role: Role | "own"): Role {
  return role === "own" ? pointerColor(state, pointer.name) : role;
}

function dotX(box: Rect, cell: number): number {
  return box.x + box.w - DOT_INSET_RADII * dotRadius(cell);
}

function pointerBoxDrawables(state: MemoryState, pointer: PointerVariable, at: Point, cell: number): Drawable[] {
  const look = POINTER_LOOKS[pointerStatus(state, pointer)];
  const rect = { x: at.x, y: at.y, w: pointerBoxWidth(state, cell), h: cell };
  const center = { x: rect.x + rect.w / 2, y: rect.y + cell / 2 };
  const ink = resolved(state, pointer, look.ink);
  const box = boxDrawable(`ptr-${pointer.name}`, rect, { fill: "fill2", stroke: resolved(state, pointer, look.outline), strokeWidth: BOX_STROKE, z: 2 });
  const dot: Drawable[] = look.arrow ? [{ id: `ptr-${pointer.name}-dot`, kind: "circle", x: dotX(rect, cell), y: center.y, r: dotRadius(cell), fill: ink, z: 6 }] : [];
  if (!state.reading) return [box, ...dot];
  return [box, ...dot, textDrawable(`ptr-${pointer.name}-word`, pointerWord(state, pointer), center, { size: byteTextSize(cell), font: "code", fill: ink, z: 4 })];
}

function rowDrawables(state: MemoryState, row: RowPlace, cell: number): Drawable[] {
  const { variable } = row;
  const label = labelDrawables(state, `label-${variable.name}`, variable.name, row.label, "start", "ink");
  if (variable.kind === "pointer") return [...label, ...pointerBoxDrawables(state, variable, row.cells, cell)];
  return [...label, ...bytesDrawables(state, variable.name, variable.bytes, row.cells, cell, false)];
}

function frameDrawables(state: MemoryState, place: FramePlace, cell: number): Drawable[] {
  const name = place.frame.name;
  const id = `frame-${place.rows[0]!.variable.name}`;
  return [
    boxDrawable(id, place.rect, { fill: "fill", stroke: "rule", strokeWidth: CELL_STROKE, radius: 1, z: 1 }),
    ...labelDrawables(state, `${id}-name`, name, place.title, "start", "muted"),
    ...place.rows.flatMap((row) => rowDrawables(state, row, cell)),
  ];
}

function blockDrawables(state: MemoryState, place: BlockPlace, cell: number): Drawable[] {
  const { block } = place;
  return [...bytesDrawables(state, block.name, block.bytes, place.cells, cell, block.freed), ...blockLabelDrawables(state, block, place.label)];
}

function blockLabelDrawables(state: MemoryState, block: Block, center: Point): Drawable[] {
  if (!state.reading) return [];
  if (!block.freed) return labelDrawables(state, `label-${block.name}`, block.name, center, "middle", "ink");
  const left = center.x - freedLabelWidth(state, block.name) / 2;
  const wordLeft = left + wordWidth(state, block.name, LABEL_SIZE, "code") + freedWordGap(state);
  return [
    ...labelDrawables(state, `label-${block.name}`, block.name, { x: left, y: center.y }, "start", "ink"),
    textDrawable(`label-${block.name}-freed`, FREED_WORD, { x: wordLeft, y: center.y }, { size: LABEL_SIZE, font: "read", fill: "ink", anchor: "start", z: 2 }),
  ];
}

function routeDrawables(state: MemoryState, layout: Layout): Drawable[] {
  const { cell } = layout;
  const rows = layout.frames.flatMap((place) => place.rows);
  const aimed = rows.filter((row): row is RowPlace & { variable: PointerVariable } => {
    const { variable } = row;
    return variable.kind === "pointer" && POINTER_LOOKS[pointerStatus(state, variable)].arrow;
  });
  return aimed.flatMap((row, lane) => {
    const pointer = row.variable;
    const target = pointer.target!;
    const block = layout.blocks.find((place) => place.block.name === target.block)!;
    const level = Math.min(MAX_LEVEL, aimed.slice(0, lane).filter((other) => other.variable.target!.block === target.block).length);
    const box = { x: row.cells.x, y: row.cells.y, w: pointerBoxWidth(state, cell), h: cell };
    const start = { x: dotX(box, cell), y: row.label.y };
    const laneX = PANEL_WIDTH + ((lane + 1) * GUTTER) / (aimed.length + 1);
    const tip = { x: block.cells.x + (target.at + 0.5) * cell, y: block.cells.y - ARROW_GAP };
    const approach = tip.y - ARROW_LENGTH - level * LEVEL_STEP;
    const stroke = resolved(state, pointer, POINTER_LOOKS[pointerStatus(state, pointer)].ink);
    return [
      {
        id: `ptr-${pointer.name}-route`,
        kind: "path" as const,
        x: start.x,
        y: start.y,
        points: [start.x, start.y, laneX, start.y, laneX, approach, tip.x, approach],
        closed: false,
        fill: "none" as const,
        stroke,
        strokeWidth: ROUTE_STROKE,
        z: 5,
      },
      { id: `ptr-${pointer.name}-arrow`, kind: "arrow" as const, x: tip.x, y: approach, x2: tip.x, y2: tip.y, stroke, strokeWidth: ROUTE_STROKE, z: 5 },
    ];
  });
}

function panelDrawable(id: string, left: number): Drawable {
  return boxDrawable(id, { x: left, y: 0, w: PANEL_WIDTH, h: HEIGHT }, { fill: "none", stroke: "rule", strokeWidth: CELL_STROKE, z: 0 });
}

function panelDrawables(state: MemoryState): Drawable[] {
  const panels = [panelDrawable("stack-panel", 0), panelDrawable("heap-panel", HEAP_LEFT)];
  if (!state.reading) return panels;
  const title = { size: TITLE_SIZE, font: "mark" as const, fill: "muted" as const, z: 1 };
  return [
    ...panels,
    textDrawable("stack-title", "Stack", { x: PANEL_PAD, y: TITLE_Y }, { ...title, anchor: "start" }),
    textDrawable("heap-title", "Heap", { x: WIDTH - PANEL_PAD, y: TITLE_Y }, { ...title, anchor: "end" }),
  ];
}

function drawMemory(state: MemoryState): Drawable[] {
  const layout = layoutOf(state);
  return [
    ...panelDrawables(state),
    ...layout.frames.flatMap((place) => frameDrawables(state, place, layout.cell)),
    ...layout.blocks.flatMap((place) => blockDrawables(state, place, layout.cell)),
    ...routeDrawables(state, layout),
  ];
}

function byId(drawables: Drawable[]): Map<string, Drawable> {
  return new Map(drawables.map((drawable) => [drawable.id, drawable]));
}

function spotIds(state: MemoryState, spot: Spot): string[] {
  const isPointer = allVariables(state).some((variable) => variable.name === spot.region && variable.kind === "pointer");
  if (isPointer) return ["", "-dot", "-word", "-route", "-arrow"].map((suffix) => `ptr-${spot.region}${suffix}`);
  return ["-char", "-dot", "-fault"].map((suffix) => `${spot.region}-${spot.offset}${suffix}`);
}

function typing(before: MemoryState, after: MemoryState, op: LabOp, progress: number): Drawable[] {
  const { spots } = writePlan(before, op);
  const old = byId(drawMemory(before));
  const next = byId(drawMemory(after));
  const pending = spots.slice(Math.floor(progress * spots.length));
  return pending.flatMap((spot) =>
    spotIds(before, spot).flatMap((id) => {
      const shown = old.get(id);
      if (shown) return [shown];
      const coming = next.get(id);
      return coming ? [{ ...coming, opacity: 0 }] : [];
    }),
  );
}

function polylineShare(points: number[], share: number): number[] {
  const corners = Array.from({ length: points.length / 2 }, (_, index): Point => ({ x: points[2 * index]!, y: points[2 * index + 1]! }));
  const lengths = corners.slice(1).map((corner, index) => Math.hypot(corner.x - corners[index]!.x, corner.y - corners[index]!.y));
  let left = share * lengths.reduce((sum, length) => sum + length, 0);
  const kept = [corners[0]!];
  for (const [index, length] of lengths.entries()) {
    const from = corners[index]!;
    const to = corners[index + 1]!;
    const part = length > 0 ? Math.min(1, left / length) : 1;
    kept.push({ x: lerp(from.x, to.x, part), y: lerp(from.y, to.y, part) });
    left -= length;
    if (left <= 0) break;
  }
  return kept.flatMap((corner) => [corner.x, corner.y]);
}

function revealRoute(after: MemoryState, pointer: unknown, progress: number): Drawable[] {
  if (typeof pointer !== "string") return [];
  const drawn = byId(drawMemory(after));
  const route = drawn.get(`ptr-${pointer}-route`);
  const arrow = drawn.get(`ptr-${pointer}-arrow`);
  if (!route || !arrow) return [];
  const points = polylineShare([...route.points!, arrow.x2!, arrow.y2!], progress);
  return [
    { ...route, points },
    { ...arrow, opacity: 0 },
  ];
}

export const lab: LabDef<MemorySpec, MemoryState> = {
  id: "memory",
  title: "Memory",
  reading: "optional",
  catalog: {
    summary:
      "C memory: a Stack panel of call frames (newest on top) holding variables as rows of byte cells, a Heap panel of malloc'd blocks, pointer arrows from a pointer variable to the heap byte it holds, and bytes written into a buffer that run past its end into the neighbour, outlined in red. Teaches pointers, stack frames, malloc and free, dangling pointers and buffer overflow. Memory order runs top to bottom: within a frame vars are listed from low address to high, and below a frame sits its caller, so an overflow runs down into the next variable, then into the caller's frame; in the heap it runs into the next block. Put the object alone in \"on\"; names of variables and blocks are unique.",
    spec: {
      frames:
        'optional list of frames, oldest (main) first, at most 3, each {"name":"main","vars":[...]}; vars, 1 to 4 per frame and at most 6 in all, are {"name":"buf","bytes":8,"text":"hi"} (1 to 8 bytes; optional text fills the first bytes, one character each) or {"name":"p","pointer":true} (starts NULL; each pointer keeps its own color). Default: an empty stack',
      reading: "optional boolean, default true; false draws no names or characters, written bytes show as dots",
    },
    example: [
      '{"step":1,"say":"main asks malloc for six bytes, and p points at the first one. Writing through p fills the block. Then greet copies six letters into a four byte buffer, and two of them overwrite the return address.","scene":{"mem":{"lab":"memory","frames":[{"name":"main","vars":[{"name":"p","pointer":true}]}]}},"do":[{"cue":"malloc","op":"malloc","on":["mem"],"block":"blk","bytes":6,"pointer":"p"},{"cue":"Writing through p","op":"write-bytes","on":["mem"],"through":"p","text":"hello"},{"cue":"greet","op":"push-frame","on":["mem"],"name":"greet","vars":[{"name":"buf","bytes":4},{"name":"ret","bytes":4,"text":"main"}]},{"cue":"copies six letters","op":"write-bytes","on":["mem"],"into":"buf","text":"AAAAAA"}]}',
    ],
  },

  init(spec, objectId) {
    return checked({ objectId, reading: readsWords(spec), frames: readFrames(spec.frames, objectId), heap: [] }, objectId);
  },

  ops: {
    "push-frame": {
      doc: '{"name":"greet","vars":[{"name":"buf","bytes":4},{"name":"ret","bytes":4,"text":"main"}]}; a call pushes a new frame on top of the stack with its local variables, same var forms as the spec; pointers start NULL',
      seconds: 0.9,
      apply: pushFrame,
    },
    malloc: {
      doc: '{"block":"blk","bytes":6,"pointer":"p"}; adds a heap block of 1 to 8 empty bytes below the others (at most 4 blocks, freed ones included); optional "pointer" names a pointer variable that is aimed at its first byte',
      seconds: 0.9,
      apply: malloc,
      during: (_before, after, op, progress) => revealRoute(after, op.args.pointer, progress),
    },
    free: {
      doc: '{"block":"blk"}; gives a heap block back: it turns hollow and its label reads "blk (freed)", its old bytes stay inside dashed cells, and every pointer still aimed at it turns red as a dangling pointer; freeing it twice is an error',
      seconds: 0.7,
      apply: free,
    },
    "pointer-arrow": {
      doc: '{"pointer":"p","block":"blk","at":2}; aims a pointer variable at byte "at" (default 0) of a heap block and draws its arrow there; {"pointer":"p","block":null} sets it to NULL and removes the arrow',
      seconds: 0.9,
      apply: pointerArrow,
      during: (_before, after, op, progress) => revealRoute(after, op.args.pointer, progress),
    },
    "write-bytes": {
      doc: '{"into":"buf","text":"AAAAAA","at":0} writes one character per byte into a variable or heap block from byte "at" (default 0); {"through":"p","text":"hi"} writes where pointer p points; bytes that run past the end land in the next variable or block and are outlined red, and a pointer they reach (8 bytes) becomes garbage; writing into a freed block is outlined red too',
      seconds: writeSeconds,
      apply: writeBytes,
      during: typing,
    },
  },

  size() {
    return { w: WIDTH, h: HEIGHT };
  },

  draw(state) {
    return drawMemory(state);
  },
};
