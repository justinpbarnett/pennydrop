import { type Drawable, fail, indexPart, type LabDef, type LabOp, lerp, numberArg, type Role, stringArg } from "../lab";
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
  pointers?: Record<string, number>;
  sorted?: number[];
  window?: [number, number];
}

const BAND_ABOVE = 104;
const BAND_BELOW = 150;
const WINDOW_Y = 84;
const COUNTER_Y = 24;
const MIN_WIDTH = 480;

function metrics(count: number) {
  const cell = count <= 6 ? 140 : count <= 8 ? 110 : Math.max(44, Math.floor(1000 / count) - 10);
  const gap = Math.round(cell * 0.13);
  const rowWidth = count * (cell + gap) - gap;
  const width = Math.max(rowWidth, MIN_WIDTH);
  return { cell, gap, width, offset: (width - rowWidth) / 2, height: BAND_ABOVE + cell + BAND_BELOW };
}

function slotCenterX(state: ArrayState, slot: number): number {
  const { cell, gap, offset } = metrics(state.cells.length);
  return offset + slot * (cell + gap) + cell / 2;
}

function cellCenterY(state: ArrayState): number {
  return BAND_ABOVE + metrics(state.cells.length).cell / 2;
}

function readValues(values: unknown, objectId: string): Cell[] {
  if (!Array.isArray(values) || values.length === 0) fail(`${objectId}: "values" must be a non-empty list of numbers or text`);
  return values.map((value, index) => {
    if (typeof value !== "number" && typeof value !== "string") fail(`${objectId}: values[${index}] must be a number or text`);
    return { id: `c${index}`, value };
  });
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
  const { cell: size } = metrics(state.cells.length);
  const role = state.slotRoles[slot] ?? "none";
  const style = SLOT_STYLE[role]!;
  const scale = at.scale ?? 1;
  const part = `${state.objectId}[${slot}]`;
  return [
    { id: `cell-${cell.id}`, kind: "rect", x: at.x, y: at.y, w: size * scale, h: size * scale, fill: style.fill, stroke: style.stroke, strokeWidth: role === "none" ? 1 : 1.8, radius: 1, z: 1, part },
    { id: `value-${cell.id}`, kind: "text", x: at.x, y: at.y, text: String(cell.value), size: size * (String(cell.value).length > 3 ? 0.3 : 0.42) * scale, font: "read", fill: role === "done" ? "done" : "ink", z: 2, part },
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
    { id: `counter-${counter.name}-label`, kind: "text" as const, x: labelEnd, y: COUNTER_Y, text: counter.name, size: COUNTER_LABEL_SIZE, font: "read" as const, anchor: "end" as const, fill: "muted" as const },
    { id: `counter-${counter.name}-value`, kind: "text" as const, x: labelEnd + COUNTER_LABEL_GAP, y: COUNTER_Y, text: valueText, size: COUNTER_VALUE_SIZE, font: "read" as const, anchor: "start" as const, fill: "ink" as const },
  ]);
}

function pointerDrawables(state: ArrayState): Drawable[] {
  const { cell } = metrics(state.cells.length);
  const bottom = BAND_ABOVE + cell;
  const stackIndex = new Map<number, number>();
  return state.pointers.flatMap((pointer) => {
    const level = stackIndex.get(pointer.slot) ?? 0;
    stackIndex.set(pointer.slot, level + 1);
    const x = slotCenterX(state, pointer.slot);
    const tip = bottom + 44 + level * 52;
    return [
      { id: `pointer-${pointer.name}`, kind: "path" as const, x, y: tip, points: [x, tip, x - 13, tip + 22, x + 13, tip + 22], closed: true, fill: "active" as const, stroke: "none" as const, z: 3 },
      { id: `pointer-${pointer.name}-label`, kind: "text" as const, x, y: tip + 46, text: pointer.name, size: 32, font: "read" as const, fill: "active" as const, z: 3 },
    ];
  });
}

function windowDrawable(state: ArrayState): Drawable[] {
  if (!state.window) return [];
  const { cell } = metrics(state.cells.length);
  const left = slotCenterX(state, state.window[0]) - cell / 2;
  const right = slotCenterX(state, state.window[1]) + cell / 2;
  return [{ id: "window", kind: "path", x: left, y: WINDOW_Y, points: [left, WINDOW_Y + 14, left, WINDOW_Y, right, WINDOW_Y, right, WINDOW_Y + 14], fill: "none", stroke: "accent", strokeWidth: 2.4, z: 3 }];
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
    const arc = Math.min(90, distance * 0.42) * lift * (to > from ? -1 : 1);
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
      sorted: "optional slot indices already marked sorted",
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
    const pointers = Object.entries(spec.pointers ?? {}).map(([name, slot]) => ({ name, slot: checkedSlot(state, slot) }));
    const sorted = (spec.sorted ?? []).map((slot) => checkedSlot(state, slot));
    const window = spec.window ? ([checkedSlot(state, spec.window[0]), checkedSlot(state, spec.window[1])] as [number, number]) : null;
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
      doc: 'on cells or ranges like arr[5-7], or {"from": index} through the last cell; marks them done',
      seconds: 0.6,
      apply(state, op) {
        const from = op.args.from;
        const slots = typeof from === "number" ? Array.from({ length: state.cells.length - checkedSlot(state, from) }, (_, offset) => from + offset) : expandParts(state, op.parts);
        if (slots.length === 0) fail(`op "sorted" needs cells in "on" or a "from" index`);
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
      doc: 'on one cell with {"value": 9} changes its value',
      seconds: 0.7,
      apply(state, op) {
        const [slot] = expandParts(state, op.parts);
        if (slot === undefined) fail(`op "set" needs one cell in "on", such as ["${state.objectId}[2]"]`);
        const value = op.args.value;
        if (typeof value !== "number" && typeof value !== "string") fail(`op "set" needs "value" as a number or text`);
        return { ...state, cells: state.cells.map((cell, index) => (index === slot ? { ...cell, value } : cell)) };
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
    const { width, height } = metrics(state.cells.length);
    return { w: width, h: height };
  },

  draw(state) {
    const y = cellCenterY(state);
    const cells = state.cells.flatMap((cell, slot) => cellDrawables(state, cell, slot, { x: slotCenterX(state, slot), y }));
    const indices = state.cells.map((_, slot): Drawable => ({
      id: `index-${slot}`, kind: "text", x: slotCenterX(state, slot), y: BAND_ABOVE + metrics(state.cells.length).cell + 24,
      text: String(slot), size: 22, font: "read", fill: "muted",
    }));
    return [...cells, ...indices, ...pointerDrawables(state), ...windowDrawable(state), ...counterDrawables(state, new Map())];
  },
};
