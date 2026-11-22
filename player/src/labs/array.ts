import { type Drawable, fail, indexPart, type LabDef, type LabOp, lerp, numberArg, type Role, stringArg, STAGE, STAGE_MARGIN, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

interface Cell {
  id: string;
  value: string | number;
}

interface Pointer {
  name: string;
  slot: number;
}

interface Counter {
  name: string;
  value: number;
}

interface ArrayState {
  objectId: string;
  cells: Cell[];
  slotRoles: (Role | null)[];
  pointers: Pointer[];
  window: [number, number] | null;
  counters: Counter[];
}

interface ArraySpec {
  values: unknown;
  counters?: unknown;
  pointers?: unknown;
  sorted?: unknown;
  window?: unknown;
}

function specList(spec: ArraySpec, field: "sorted" | "window", objectId: string, wanted: string): unknown[] | undefined {
  const value = spec[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(`${objectId}: "${field}" is ${wanted}, not ${JSON.stringify(value)}`);
  return value;
}

function specPointers(spec: ArraySpec, objectId: string): Record<string, unknown> {
  const value = spec.pointers ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${objectId}: "pointers" is a map of pointer names to slots, such as {"i": 0}, not ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

const MIN_WIDTH = 480;
const COUNTER_Y = 22;
const COUNTER_BAND = 58;
const WINDOW_BAND = 30;
const WINDOW_RISE = 24;
const MIN_TOP = 20;
const INDEX_BOTTOM = 41;
const BOTTOM_MARGIN = 22;
const POINTER_TIP = 54;
const POINTER_LABEL = 57;
const POINTER_REACH = 67;
const POINTER_LEVEL = 80;
const MAX_ARC = 64;
const TEXT_LABEL_SHARE = 0.3;
const CELL_TEXT_PADDING = 16;

function textFit(state: ArrayState, cell: number, gap: number): { cellWidth: number; labelSize: number | null } {
  const texts = state.cells.map((entry) => entry.value);
  if (texts.every((value) => typeof value === "number")) return { cellWidth: cell, labelSize: null };
  const widest = Math.max(...texts.map((value) => textWidth(String(value), 100, "read"))) / 100;
  const preferred = cell * TEXT_LABEL_SHARE;
  const stageRow = STAGE.w - STAGE_MARGIN * 2;
  const room = Math.max(cell, (stageRow + gap) / state.cells.length - gap);
  const cellWidth = Math.min(room, Math.max(cell, widest * preferred + CELL_TEXT_PADDING * 2));
  return { cellWidth, labelSize: Math.min(preferred, (cellWidth - CELL_TEXT_PADDING * 2) / widest) };
}

function metrics(state: ArrayState) {
  const count = state.cells.length;
  const cell = count <= 6 ? 140 : count <= 8 ? 110 : Math.max(44, Math.floor(1000 / count) - 10);
  const gap = Math.round(cell * 0.13);
  const { cellWidth, labelSize } = textFit(state, cell, gap);
  const rowWidth = count * (cellWidth + gap) - gap;
  const width = Math.max(rowWidth, MIN_WIDTH);
  const top = Math.max(MIN_TOP, (state.counters.length > 0 ? COUNTER_BAND : 0) + (state.window ? WINDOW_BAND : 0));
  const levels = state.pointers.length === 0 ? 0 : Math.max(...state.pointers.map((pointer) => pointerLevel(state, pointer)));
  const below = (state.pointers.length === 0 ? INDEX_BOTTOM : POINTER_TIP + POINTER_REACH + levels * POINTER_LEVEL) + BOTTOM_MARGIN;
  return { cell, cellWidth, labelSize, gap, width, offset: (width - rowWidth) / 2, top, height: top + cell + below };
}

function pointerLevel(state: ArrayState, pointer: Pointer): number {
  return state.pointers.filter((other) => other.slot === pointer.slot).indexOf(pointer);
}

function slotCenterX(state: ArrayState, slot: number): number {
  const { cellWidth, gap, offset } = metrics(state);
  return offset + slot * (cellWidth + gap) + cellWidth / 2;
}

function cellCenterY(state: ArrayState): number {
  const { top, cell } = metrics(state);
  return top + cell / 2;
}

function readValues(values: unknown, objectId: string): Cell[] {
  if (!Array.isArray(values) || values.length === 0) fail(`${objectId}: "values" must be a non-empty list of numbers or text`);
  return values.map((value, index) => {
    if (typeof value !== "number" && typeof value !== "string") fail(`${objectId}: values[${index}] must be a number or text`);
    return { id: `c${index}`, value };
  });
}

function placedSlots(state: ArrayState, slots: number[]): number[] {
  const values = state.cells.map((cell) => cell.value);
  if (!values.every((value) => typeof value === typeof values[0])) return slots;
  const rising = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const falling = [...rising].reverse();
  const placedIn = (order: (string | number)[]) => slots.every((slot) => values[slot] === order[slot]);
  if (placedIn(rising) || placedIn(falling)) return slots;
  const unplaced = slots.filter((slot) => values[slot] !== rising[slot]);
  fail(`${state.objectId}: "sorted" marks cells that hold their final sorted value, and ${unplaced.map((slot) => `index ${slot} holds ${values[slot]} where a full sort puts ${rising[slot]}`).join(", ")}; mark only the cells already in their final place, and show a part that is in order among itself with "window"`);
}

function readCounters(counters: unknown, objectId: string): Counter[] {
  if (counters === undefined) return [];
  if (Array.isArray(counters)) return counters.map((name) => ({ name: String(name), value: 0 }));
  if (typeof counters === "object" && counters !== null) {
    return Object.entries(counters).map(([name, value]) => {
      if (typeof value !== "number") fail(`${objectId}: counter "${name}" must start at a number`);
      return { name, value };
    });
  }
  return fail(`${objectId}: "counters" must be a list of names or a map of name to number`);
}

function checkedSlot(state: ArrayState, slot: unknown): number {
  if (typeof slot !== "number") fail(`${state.objectId}: expected a cell index number`);
  return indexPart(String(slot), state.cells.length, state.objectId);
}

function expandParts(state: ArrayState, parts: string[]): number[] {
  return parts.flatMap((part) => {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (!range) return [indexPart(part, state.cells.length, state.objectId)];
    const from = indexPart(range[1]!, state.cells.length, state.objectId);
    const to = indexPart(range[2]!, state.cells.length, state.objectId);
    return Array.from({ length: Math.abs(to - from) + 1 }, (_, offset) => Math.min(from, to) + offset);
  });
}

function pairOf(state: ArrayState, op: LabOp): [number, number] {
  const slots = expandParts(state, op.parts);
  if (slots.length !== 2) fail(`op "${op.name}" needs exactly two cells in "on", such as ["${state.objectId}[0]","${state.objectId}[1]"]`);
  return [slots[0]!, slots[1]!];
}

function withRoles(state: ArrayState, slots: number[], role: Role | null): ArrayState {
  const slotRoles: (Role | null)[] = state.slotRoles.map((existing) => (existing === "compare" || existing === "swap" ? null : existing));
  slots.forEach((slot) => (slotRoles[slot] = role));
  return { ...state, slotRoles };
}

function withCounted(state: ArrayState, op: LabOp): ArrayState {
  const name = op.args.count;
  if (name === undefined) return state;
  if (typeof name !== "string") fail(`op "${op.name}" arg "count" must be a counter name`);
  return addToCounter(state, name, 1);
}

function addToCounter(state: ArrayState, name: string, amount: number, absolute = false): ArrayState {
  if (!state.counters.some((counter) => counter.name === name)) {
    const known = state.counters.map((counter) => counter.name).join(", ") || "none";
    fail(`${state.objectId} has no counter "${name}"; counters: ${known}; declare it in the object spec as "counters": ["${name}"]`);
  }
  return { ...state, counters: state.counters.map((counter) => (counter.name === name ? { ...counter, value: absolute ? amount : counter.value + amount } : counter)) };
}

const SLOT_STYLE: Record<string, { stroke: Role; fill: Role }> = {
  none: { stroke: "rule", fill: "fill" },
  compare: { stroke: "compare", fill: "fill2" },
  swap: { stroke: "swap", fill: "fill2" },
  done: { stroke: "done", fill: "fill" },
};

function cellDrawables(state: ArrayState, cell: Cell, slot: number, at: { x: number; y: number; scale?: number }): Drawable[] {
  const { cell: size, cellWidth, labelSize } = metrics(state);
  const role = state.slotRoles[slot] ?? "none";
  const style = SLOT_STYLE[role]!;
  const scale = at.scale ?? 1;
  const part = `${state.objectId}[${slot}]`;
  return [
    { id: `cell-${cell.id}`, kind: "rect", x: at.x, y: at.y, w: cellWidth * scale, h: size * scale, fill: style.fill, stroke: style.stroke, strokeWidth: role === "none" ? 1 : 1.8, radius: 1, z: 1, part },
    textDrawable(`value-${cell.id}`, String(cell.value), at, { size: (labelSize ?? size * (String(cell.value).length > 3 ? 0.3 : 0.42)) * scale, fill: role === "done" ? "done" : "ink", z: 2, part }),
  ];
}

const COUNTER_LABEL_SIZE = 24;
const COUNTER_VALUE_SIZE = 38;
const COUNTER_LABEL_GAP = 22;
const COUNTER_SPACING = 70;

function counterLayout(state: ArrayState, values: Map<string, string>): { counter: Counter; labelEnd: number; valueText: string }[] {
  let x = 0;
  return state.counters.map((counter) => {
    const valueText = values.get(counter.name) ?? String(counter.value);
    const labelEnd = x + textWidth(counter.name, COUNTER_LABEL_SIZE, "read");
    x = labelEnd + COUNTER_LABEL_GAP + textWidth(valueText, COUNTER_VALUE_SIZE, "read") + COUNTER_SPACING;
    return { counter, labelEnd, valueText };
  });
}

function counterDrawables(state: ArrayState, values: Map<string, string>): Drawable[] {
  return counterLayout(state, values).flatMap(({ counter, labelEnd, valueText }) => [
    textDrawable(`counter-${counter.name}-label`, counter.name, { x: labelEnd, y: COUNTER_Y }, { size: COUNTER_LABEL_SIZE, anchor: "end", fill: "muted" }),
    textDrawable(`counter-${counter.name}-value`, valueText, { x: labelEnd + COUNTER_LABEL_GAP, y: COUNTER_Y }, { size: COUNTER_VALUE_SIZE, anchor: "start" }),
  ]);
}

function pointerDrawables(state: ArrayState): Drawable[] {
  const { top, cell } = metrics(state);
  const bottom = top + cell;
  return state.pointers.flatMap((pointer) => {
    const x = slotCenterX(state, pointer.slot);
    const tip = bottom + POINTER_TIP + pointerLevel(state, pointer) * POINTER_LEVEL;
    return [
      { id: `pointer-${pointer.name}`, kind: "path" as const, x, y: tip, points: [x, tip, x - 13, tip + 22, x + 13, tip + 22], closed: true, fill: "active" as const, stroke: "none" as const, z: 3 },
      textDrawable(`pointer-${pointer.name}-label`, pointer.name, { x, y: tip + POINTER_LABEL }, { size: 32, fill: "active", z: 3 }),
    ];
  });
}

function windowDrawable(state: ArrayState): Drawable[] {
  if (!state.window) return [];
  const { top, cellWidth } = metrics(state);
  const left = slotCenterX(state, state.window[0]) - cellWidth / 2;
  const right = slotCenterX(state, state.window[1]) + cellWidth / 2;
  const y = top - WINDOW_RISE;
  return [{ id: "window", kind: "path", x: left, y, points: [left, y + 14, left, y, right, y, right, y + 14], fill: "none", stroke: "accent", strokeWidth: 2.4, z: 3 }];
}

function swappedSlots(before: ArrayState, after: ArrayState): { cell: Cell; from: number; to: number }[] {
  return before.cells.flatMap((cell, from) => {
    const to = after.cells.findIndex((candidate) => candidate.id === cell.id);
    return to === from ? [] : [{ cell, from, to }];
  });
}

function tickingCounters(before: ArrayState, after: ArrayState, progress: number): Drawable[] {
  const ticking = new Map<string, string>();
  after.counters.forEach((counter, index) => {
    const previous = before.counters[index]?.value ?? counter.value;
    if (previous !== counter.value) ticking.set(counter.name, String(Math.round(lerp(previous, counter.value, progress))));
  });
  return ticking.size > 0 ? counterDrawables(after, ticking) : [];
}

function swapArcs(before: ArrayState, after: ArrayState, progress: number): Drawable[] {
  const y = cellCenterY(after);
  const lift = Math.sin(Math.PI * progress);
  return swappedSlots(before, after).flatMap(({ cell, from, to }) => {
    const distance = Math.abs(slotCenterX(after, to) - slotCenterX(after, from));
    const arc = Math.min(MAX_ARC, distance * 0.42) * lift * (to > from ? -1 : 1);
    return cellDrawables(after, cell, to, { x: lerp(slotCenterX(after, from), slotCenterX(after, to), progress), y: y + arc, scale: 1 + 0.08 * lift }).map((drawable) => ({ ...drawable, z: (drawable.z ?? 0) + (to > from ? 10 : 0) }));
  });
}

function compareLift(after: ArrayState, op: LabOp, progress: number): Drawable[] {
  const y = cellCenterY(after);
  const lift = Math.sin(Math.PI * progress);
  return expandParts(after, op.parts).flatMap((slot) => cellDrawables(after, after.cells[slot]!, slot, { x: slotCenterX(after, slot), y, scale: 1 + 0.07 * lift }));
}

export const lab: LabDef<ArraySpec, ArrayState> = {
  id: "array",
  title: "Array",
  reading: "required",
  catalog: {
    summary: "A row of cells with pointers, a window bracket and counters. Cell parts are slot indices: arr[3].",
    spec: {
      values: "list of numbers or text, the cells in order",
      counters: 'optional list of counter names, or {"name": start}',
      pointers: 'optional {"i": slot} named pointers under cells',
      sorted: "optional slot indices already holding their final sorted value",
      window: "optional [from, to] bracket over cells",
    },
    example: [
      '{"step":1,"say":"Compare the first pair. Four and three swap.","scene":{"arr":{"lab":"array","values":[4,3,2,1],"counters":["comparisons"]}},"do":[{"cue":"Compare","op":"compare","on":["arr[0]","arr[1]"],"count":"comparisons"},{"cue":"swap","op":"swap","on":["arr[0]","arr[1]"]}]}',
    ],
  },

  init(spec, objectId) {
    const cells = readValues(spec.values, objectId);
    const state: ArrayState = {
      objectId,
      cells,
      slotRoles: cells.map(() => null),
      pointers: [],
      window: null,
      counters: readCounters(spec.counters, objectId),
    };
    const pointers = Object.entries(specPointers(spec, objectId)).map(([name, slot]) => ({ name, slot: checkedSlot(state, slot) }));
    const sorted = placedSlots(state, (specList(spec, "sorted", objectId, "a list of slot indices, such as [3]") ?? []).map((slot) => checkedSlot(state, slot)));
    const bounds = specList(spec, "window", objectId, "a list of the first and last slot, such as [0, 2]");
    if (bounds && bounds.length !== 2) fail(`${objectId}: "window" is a list of the first and last slot, such as [0, 2]`);
    const window = bounds ? ([checkedSlot(state, bounds[0]), checkedSlot(state, bounds[1])] as [number, number]) : null;
    return { ...state, pointers, window, slotRoles: state.slotRoles.map((_, slot) => (sorted.includes(slot) ? "done" : null)) };
  },

  ops: {
    compare: {
      doc: 'on two cells; both become the active pair; optional "count": "<counter>" adds one to that counter',
      seconds: 0.6,
      apply: (state, op) => withCounted(withRoles(state, pairOf(state, op), "compare"), op),
      during: (before, after, op, progress) => [...tickingCounters(before, after, progress), ...compareLift(after, op, progress)],
    },
    swap: {
      doc: 'on two cells; they trade places on arcs; optional "count": "<counter>"',
      seconds: 1.0,
      apply(state, op) {
        const [first, second] = pairOf(state, op);
        const cells = [...state.cells];
        [cells[first], cells[second]] = [cells[second]!, cells[first]!];
        return withCounted({ ...withRoles(state, [first, second], "swap"), cells }, op);
      },
      during: (before, after, _op, progress) => [...tickingCounters(before, after, progress), ...swapArcs(before, after, progress)],
    },
    sorted: {
      doc: 'on cells or ranges like arr[5-7], on the whole array, or {"from": index} through the last cell; marks cells that already hold their final sorted value',
      seconds: 0.6,
      apply(state, op) {
        const from = typeof op.args.from === "number" ? checkedSlot(state, op.args.from) : op.parts.length === 0 ? 0 : null;
        const slots = from === null ? expandParts(state, op.parts) : Array.from({ length: state.cells.length - from }, (_, offset) => from + offset);
        placedSlots(state, slots);
        const slotRoles = state.slotRoles.map((role, slot) => (slots.includes(slot) ? "done" : role));
        return { ...state, slotRoles };
      },
    },
    pointer: {
      doc: '{"name": "i", "to": slot or null} or on arr[slot] with "name"; slides a named pointer, null removes it',
      seconds: 0.75,
      apply(state, op) {
        const name = stringArg(op.args, "name", "pointer");
        const target = op.parts.length > 0 ? expandParts(state, op.parts)[0]! : op.args.to;
        const others = state.pointers.filter((pointer) => pointer.name !== name);
        if (target === null || target === undefined) {
          if (op.args.to !== null) fail(`op "pointer" needs a cell in "on" or "to": slot, or "to": null to remove it`);
          return { ...state, pointers: others };
        }
        const slot = checkedSlot(state, target);
        const exists = state.pointers.some((pointer) => pointer.name === name);
        return { ...state, pointers: exists ? state.pointers.map((pointer) => (pointer.name === name ? { name, slot } : pointer)) : [...others, { name, slot }] };
      },
    },
    window: {
      doc: 'on arr[a] and arr[b], or {"from","to"}; no cells clears the bracket',
      seconds: 0.75,
      apply(state, op) {
        if (typeof op.args.from === "number" && typeof op.args.to === "number") return { ...state, window: [checkedSlot(state, op.args.from), checkedSlot(state, op.args.to)] };
        const slots = expandParts(state, op.parts);
        if (slots.length === 0) return { ...state, window: null };
        return { ...state, window: [Math.min(...slots), Math.max(...slots)] };
      },
    },
    counter: {
      doc: '{"name": "comparisons", "add": 1} or {"to": 12}',
      seconds: 0.5,
      apply(state, op) {
        const name = stringArg(op.args, "name", "counter");
        if (typeof op.args.to === "number") return addToCounter(state, name, op.args.to, true);
        return addToCounter(state, name, numberArg(op.args, "add", "counter"));
      },
      during: (before, after, _op, progress) => tickingCounters(before, after, progress),
    },
    set: {
      doc: 'on one cell with {"value": 9} changes its value; {"count": "writes"} adds one to that counter',
      seconds: 0.7,
      apply(state, op) {
        const [slot] = expandParts(state, op.parts);
        if (slot === undefined) fail(`op "set" needs one cell in "on", such as ["${state.objectId}[2]"]`);
        const value = op.args.value;
        if (typeof value !== "number" && typeof value !== "string") fail(`op "set" needs "value" as a number or text`);
        return withCounted({ ...state, cells: state.cells.map((cell, index) => (index === slot ? { ...cell, value } : cell)) }, op);
      },
    },
    clear: {
      doc: '{"what": "roles"|"pointers"|"window"|"all"} default "roles" clears compare and swap highlights',
      seconds: 0.4,
      apply(state, op) {
        const what = op.args.what ?? "roles";
        if (!["roles", "pointers", "window", "all"].includes(what as string)) fail(`op "clear" arg "what" must be roles, pointers, window or all`);
        const clearRoles = what === "roles" || what === "all";
        return {
          ...state,
          slotRoles: clearRoles ? state.slotRoles.map((role) => (role === "compare" || role === "swap" ? null : role)) : state.slotRoles,
          pointers: what === "pointers" || what === "all" ? [] : state.pointers,
          window: what === "window" || what === "all" ? null : state.window,
        };
      },
    },
  },

  size(state) {
    const { width, height } = metrics(state);
    return { w: width, h: height };
  },

  draw(state) {
    const y = cellCenterY(state);
    const { top, cell: cellSize } = metrics(state);
    const cells = state.cells.flatMap((cell, slot) => cellDrawables(state, cell, slot, { x: slotCenterX(state, slot), y }));
    const indices = state.cells.map((_, slot) => textDrawable(`index-${slot}`, String(slot), { x: slotCenterX(state, slot), y: top + cellSize + 26 }, { size: 26, fill: "muted" }));
    return [...cells, ...indices, ...pointerDrawables(state), ...windowDrawable(state), ...counterDrawables(state, new Map())];
  },
};
