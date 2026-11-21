import { type Drawable, fail, type LabDef, type LabOp, labelDrawable, lerp, type Point, type Rect, type Role, segmentDrawable, stringArg } from "../lab";
import { textWidth } from "../text-metrics";

type Status = "ready" | "running" | "blocked" | "waiting";

interface Item {
  id: number;
  value: string | number;
}

interface Thread {
  name: string;
  status: Status;
  on: string | null;
  doing: string;
  carrying: Item | null;
}

interface Lock {
  name: string;
  owner: string | null;
  queue: string[];
}

interface Sleeper {
  thread: string;
  lock: string;
}

interface Cond {
  name: string;
  sleepers: Sleeper[];
}

interface Buffer {
  slots: (Item | null)[];
  head: number;
  tail: number;
}

interface ThreadsState {
  objectId: string;
  threads: Thread[];
  locks: Lock[];
  conds: Cond[];
  buffer: Buffer | null;
  itemsMade: number;
  cycle: string[];
}

interface ThreadsSpec {
  threads?: unknown;
  locks?: unknown;
  conds?: unknown;
  buffer?: { capacity?: unknown };
}

interface Geometry {
  width: number;
  height: number;
  thread(index: number): Rect;
  lock(index: number): Rect;
  cond(index: number): Rect;
  bufferTop: number;
  slot: number;
  slotX(index: number): number;
}

interface Chip {
  thread: string;
  center: Point;
  w: number;
}

interface Connector {
  id: string;
  from: Point;
  to: Point;
  role: Role;
  width: number;
}

const MAX_THREADS = 5;
const MAX_LOCKS = 3;
const MAX_CONDS = 2;
const MAX_CAPACITY = 8;
const MAX_THREAD_NAME = 10;
const MAX_SHARED_NAME = 12;
const MAX_LABEL = 24;
const MAX_ITEM_TEXT = 5;

const CARD = { w: 420, h: 112, gap: 22 };
const BOX = { w: 360, h: 118, gap: 22 };
const ARROW_GAP = 190;
const COLUMN_GAP = 80;
const BUFFER_GAP = 48;
const BUFFER_TITLE = 40;
const BUFFER_MARKERS = 150;
const MARKER_STEP = 70;
const MIN_BUFFER_WIDTH = 700;
const MAX_SLOT = 96;
const SLOT_GAP = 10;
const CHIP_START = 100;
const CHIP_HEIGHT = 40;
const CHIP_GAP = 10;
const CARRIED_SIZE = 50;
const PAD = 20;
const TEXT_Z = 4;
const ITEM_Z = 6;

const STATUS_ROLE: Record<Status, Role> = { running: "active", ready: "muted", blocked: "warn", waiting: "swap" };

function readNames(value: unknown, key: string, limit: number, longest: number, objectId: string): string[] {
  const names = value ?? [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.trim() === "")) {
    fail(`${objectId}: "${key}" must be a list of short names such as ["A","B"]`);
  }
  if (names.length > limit) fail(`${objectId}: "${key}" holds at most ${limit} names to stay readable, got ${names.length}`);
  const tooLong = names.find((name: string) => name.length > longest);
  if (tooLong) fail(`${objectId}: "${key}" name "${tooLong}" is longer than ${longest} characters`);
  return names;
}

function readBuffer(spec: ThreadsSpec, objectId: string): Buffer | null {
  if (spec.buffer === undefined) return null;
  const capacity = spec.buffer?.capacity;
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    fail(`${objectId}: "buffer" must be {"capacity": 1 to ${MAX_CAPACITY}}, such as {"capacity": 3}`);
  }
  return { slots: Array.from({ length: capacity }, () => null), head: 0, tail: 0 };
}

function named<T extends { name: string }>(items: T[], name: string, kind: string, state: ThreadsState): T {
  const found = items.find((item) => item.name === name);
  if (found) return found;
  const known = items.map((item) => item.name).join(", ") || "none";
  return fail(`${state.objectId} has no ${kind} "${name}"; ${kind}s: ${known}; declare it in the object spec as "${kind}s": ["${name}"]`);
}

function optionalText(op: LabOp, key: string, longest: number): string {
  const value = op.args[key];
  if (value === undefined) return "";
  if (typeof value !== "string") fail(`op "${op.name}" needs "${key}" as text`);
  if (value.length > longest) fail(`op "${op.name}" "${key}" is longer than ${longest} characters; shorten "${value}"`);
  return value;
}

function itemArg(op: LabOp): string | number {
  const value = op.args.item;
  if (typeof value === "number" && Number.isFinite(value) && String(value).length <= MAX_ITEM_TEXT) return value;
  if (typeof value === "string" && value.length > 0 && value.length <= MAX_ITEM_TEXT) return value;
  return fail(`op "${op.name}" needs "item" as a number or text of at most ${MAX_ITEM_TEXT} characters`);
}

function requireBuffer(state: ThreadsState): Buffer {
  return state.buffer ?? fail(`${state.objectId} has no buffer; add "buffer": {"capacity": 3} to the object spec`);
}

function actor(state: ThreadsState, op: LabOp): Thread {
  const thread = named(state.threads, stringArg(op.args, "t", op.name), "thread", state);
  if (thread.status === "blocked") {
    fail(`${thread.name} is blocked on lock ${thread.on} and cannot do "${op.name}"; its owner must release ${thread.on} first`);
  }
  if (thread.status === "waiting") {
    fail(`${thread.name} is waiting on ${thread.on} and cannot do "${op.name}"; another thread must signal or broadcast ${thread.on} first`);
  }
  return thread;
}

function lockArg(state: ThreadsState, op: LabOp): Lock {
  return named(state.locks, stringArg(op.args, "lock", op.name), "lock", state);
}

function condArg(state: ThreadsState, op: LabOp): Cond {
  return named(state.conds, stringArg(op.args, "cond", op.name), "cond", state);
}

function takeCpu(state: ThreadsState, thread: Thread, doing: string): void {
  state.threads.forEach((other) => {
    if (other.status === "running") other.status = "ready";
  });
  thread.status = "running";
  thread.on = null;
  thread.doing = doing;
}

function passLock(state: ThreadsState, lock: Lock): void {
  const next = lock.queue.shift() ?? null;
  lock.owner = next;
  if (next === null) return;
  const heir = named(state.threads, next, "thread", state);
  heir.status = "ready";
  heir.on = null;
  heir.doing = `lock(${lock.name})`;
}

function wake(state: ThreadsState, sleeper: Sleeper): void {
  const woken = named(state.threads, sleeper.thread, "thread", state);
  const lock = named(state.locks, sleeper.lock, "lock", state);
  if (lock.owner === null) {
    lock.owner = woken.name;
    woken.status = "ready";
    woken.on = null;
  } else {
    lock.queue.push(woken.name);
    woken.status = "blocked";
    woken.on = lock.name;
  }
  woken.doing = `lock(${lock.name})`;
}

function waitForCycle(state: ThreadsState): string[] {
  const blockers = new Map(state.locks.flatMap((lock) => lock.queue.map((thread): [string, string] => [thread, lock.owner!])));
  for (const start of blockers.keys()) {
    const path: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !path.includes(current)) {
      path.push(current);
      current = blockers.get(current);
    }
    if (current !== undefined) return path.slice(path.indexOf(current));
  }
  return [];
}

interface OpDefinition {
  seconds: number;
  doc: string;
  run(state: ThreadsState, op: LabOp): void;
}

const OPS: Record<string, OpDefinition> = {
  run: {
    seconds: 0.7,
    doc: 'thread "t" is on the CPU; optional "label" (at most 24 characters, such as "count++") shows what it does; consumes an item it took',
    run(state, op) {
      const thread = actor(state, op);
      takeCpu(state, thread, optionalText(op, "label", MAX_LABEL));
      thread.carrying = null;
    },
  },
  acquire: {
    seconds: 0.8,
    doc: '"t" takes a free "lock"; an arrow points from the lock to its owner; fails if the lock is held',
    run(state, op) {
      const thread = actor(state, op);
      const lock = lockArg(state, op);
      if (lock.owner === thread.name) fail(`${thread.name} already holds ${lock.name}; locks are not recursive, so this would be a self deadlock: use "block" to show it`);
      if (lock.owner !== null) fail(`${lock.name} is held by ${lock.owner}; use "block" so ${thread.name} waits in its queue, or release it first`);
      lock.owner = thread.name;
      takeCpu(state, thread, `lock(${lock.name})`);
    },
  },
  block: {
    seconds: 0.9,
    doc: '"t" asks for a "lock" that is held and joins its wait queue as blocked',
    run(state, op) {
      const thread = actor(state, op);
      const lock = lockArg(state, op);
      if (lock.owner === null) fail(`${lock.name} is free, so ${thread.name} would get it: use "acquire"`);
      takeCpu(state, thread, `lock(${lock.name})`);
      thread.status = "blocked";
      thread.on = lock.name;
      lock.queue.push(thread.name);
    },
  },
  release: {
    seconds: 0.9,
    doc: 'the owner "t" frees "lock"; the first waiter in its queue, if any, is handed the lock and becomes ready',
    run(state, op) {
      const thread = actor(state, op);
      const lock = lockArg(state, op);
      if (lock.owner !== thread.name) fail(`${thread.name} cannot release ${lock.name}: ${lock.owner === null ? "it is free" : `it is held by ${lock.owner}`}; only the owner releases`);
      takeCpu(state, thread, `unlock(${lock.name})`);
      passLock(state, lock);
    },
  },
  wait: {
    seconds: 1.0,
    doc: '"t" owns "lock", releases it and sleeps on "cond" (condition variable) until a signal or broadcast',
    run(state, op) {
      const thread = actor(state, op);
      const cond = condArg(state, op);
      const lock = lockArg(state, op);
      if (lock.owner !== thread.name) fail(`${thread.name} must hold ${lock.name} to wait on ${cond.name}; "acquire" it first`);
      takeCpu(state, thread, `wait(${cond.name}, ${lock.name})`);
      passLock(state, lock);
      thread.status = "waiting";
      thread.on = cond.name;
      cond.sleepers.push({ thread: thread.name, lock: lock.name });
    },
  },
  signal: {
    seconds: 0.9,
    doc: '"t" wakes the first sleeper of "cond"; it moves to the queue of the lock it released, or takes that lock if it is free',
    run(state, op) {
      const thread = actor(state, op);
      const cond = condArg(state, op);
      takeCpu(state, thread, `signal(${cond.name})`);
      const sleeper = cond.sleepers.shift();
      if (sleeper) wake(state, sleeper);
    },
  },
  broadcast: {
    seconds: 1.1,
    doc: '"t" wakes every sleeper of "cond", each moving to the queue of the lock it released',
    run(state, op) {
      const thread = actor(state, op);
      const cond = condArg(state, op);
      takeCpu(state, thread, `broadcast(${cond.name})`);
      cond.sleepers.splice(0).forEach((sleeper) => wake(state, sleeper));
    },
  },
  put: {
    seconds: 1.0,
    doc: '"t" puts "item" (number or text up to 5 characters) in the next free slot of the bounded buffer; fails when full',
    run(state, op) {
      const thread = actor(state, op);
      const buffer = requireBuffer(state);
      const value = itemArg(op);
      if (buffer.slots[buffer.tail] !== null) fail(`the buffer is full (${buffer.slots.length} of ${buffer.slots.length}); ${thread.name} must wait for a consumer to "take"`);
      buffer.slots[buffer.tail] = { id: state.itemsMade++, value };
      buffer.tail = (buffer.tail + 1) % buffer.slots.length;
      takeCpu(state, thread, `put(${value})`);
    },
  },
  take: {
    seconds: 1.0,
    doc: '"t" takes the oldest item from the buffer and holds it until its next "run"; fails when empty',
    run(state, op) {
      const thread = actor(state, op);
      const buffer = requireBuffer(state);
      const item = buffer.slots[buffer.head];
      if (!item) fail(`the buffer is empty; ${thread.name} must wait for a producer to "put"`);
      buffer.slots[buffer.head] = null;
      buffer.head = (buffer.head + 1) % buffer.slots.length;
      takeCpu(state, thread, `take() = ${item.value}`);
      thread.carrying = item;
    },
  },
  deadlock: {
    seconds: 1.4,
    doc: "draws the wait-for cycle: every thread blocked in it holds a lock the next one needs; fails if no cycle exists",
    run(state) {
      const cycle = waitForCycle(state);
      if (cycle.length === 0) {
        const blocked = state.threads.filter((thread) => thread.status === "blocked").map((thread) => `${thread.name} on ${thread.on}`).join(", ") || "no thread is blocked";
        fail(`${state.objectId} has no deadlock: no ring of threads each blocked on a lock the next one holds (${blocked}); use "block" until the ring closes`);
      }
      state.cycle = cycle;
    },
  },
};

function columnHeight(count: number): number {
  return count === 0 ? 0 : count * BOX.h + (count - 1) * BOX.gap;
}

function geometryOf(state: ThreadsState): Geometry {
  const middleX = CARD.w + ARROW_GAP;
  const hasLocks = state.locks.length > 0;
  const hasConds = state.conds.length > 0;
  const regionWidth = hasLocks && hasConds ? 2 * BOX.w + COLUMN_GAP : hasLocks || hasConds ? BOX.w : 0;
  const capacity = state.buffer?.slots.length ?? 0;
  const slot = capacity === 0 ? 0 : Math.min(MAX_SLOT, Math.floor((Math.max(regionWidth, MIN_BUFFER_WIDTH) + SLOT_GAP) / capacity) - SLOT_GAP);
  const bufferWidth = capacity === 0 ? 0 : capacity * (slot + SLOT_GAP) - SLOT_GAP;
  const middleHeight = Math.max(columnHeight(state.locks.length), columnHeight(state.conds.length));
  const bufferTop = middleHeight === 0 ? 0 : middleHeight + BUFFER_GAP;
  const bufferHeight = capacity === 0 ? 0 : BUFFER_TITLE + slot + BUFFER_MARKERS;
  const condX = hasLocks ? middleX + BOX.w + COLUMN_GAP : middleX;
  const box = (x: number, index: number): Rect => ({ x, y: index * (BOX.h + BOX.gap), w: BOX.w, h: BOX.h });
  return {
    width: middleX + Math.max(regionWidth, bufferWidth),
    height: Math.max(state.threads.length * (CARD.h + CARD.gap) - CARD.gap, bufferTop + bufferHeight),
    thread: (index) => ({ x: 0, y: index * (CARD.h + CARD.gap), w: CARD.w, h: CARD.h }),
    lock: (index) => box(middleX, index),
    cond: (index) => box(condX, index),
    bufferTop,
    slot,
    slotX: (index) => middleX + index * (slot + SLOT_GAP) + slot / 2,
  };
}

function text(id: string, content: string, at: Point, size: number, fill: Role, anchor: "start" | "middle" | "end", part: string): Drawable {
  return { ...labelDrawable(content, at, size, "read", fill, TEXT_Z), id, anchor, part };
}

function box(id: string, rect: Rect, fill: Role, stroke: Role, strokeWidth: number, part: string): Drawable {
  return { id, kind: "rect", x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: rect.w, h: rect.h, fill, stroke, strokeWidth, radius: 1, z: 1, part };
}

function chipWidth(name: string): number {
  return textWidth(name, 22, "read") + 26;
}

function chipsOf(state: ThreadsState, geometry: Geometry): Chip[] {
  const queues = [
    ...state.locks.map((lock, index) => ({ rect: geometry.lock(index), threads: lock.queue })),
    ...state.conds.map((cond, index) => ({ rect: geometry.cond(index), threads: cond.sleepers.map((sleeper) => sleeper.thread) })),
  ];
  return queues.flatMap(({ rect, threads }) => {
    let x = rect.x + CHIP_START;
    return threads.map((thread) => {
      const w = chipWidth(thread);
      const chip = { thread, w, center: { x: x + w / 2, y: rect.y + 84 } };
      x += w + CHIP_GAP;
      return chip;
    });
  });
}

function chipDrawables(state: ThreadsState, chip: Chip): Drawable[] {
  const status = named(state.threads, chip.thread, "thread", state).status;
  const part = `${state.objectId}[${chip.thread}]`;
  return [
    { id: `place-${chip.thread}`, kind: "rect", x: chip.center.x, y: chip.center.y, w: chip.w, h: CHIP_HEIGHT, fill: "fill2", stroke: STATUS_ROLE[status], strokeWidth: 1.6, radius: 0.6, z: 3, part },
    text(`place-${chip.thread}-name`, chip.thread, chip.center, 22, "ink", "middle", part),
  ];
}

function firstFitting(options: string[], size: number, room: number): string {
  return options.find((option) => textWidth(option, size, "read") <= room) ?? options[options.length - 1]!;
}

function holdsText(state: ThreadsState, thread: Thread): string {
  const held = state.locks.filter((lock) => lock.owner === thread.name).map((lock) => lock.name);
  if (held.length === 0) return "";
  const room = CARD.w - 2 * PAD - textWidth(thread.name, 30, "read") - 24;
  return firstFitting([`holds ${held.join(", ")}`, `holds ${held.length} locks`], 20, room);
}

function ownerText(lock: Lock): string {
  if (lock.owner === null) return "free";
  const room = BOX.w - 2 * PAD - textWidth(lock.name, 28, "read") - 24;
  return firstFitting([`held by ${lock.owner}`, lock.owner], 22, room);
}

function threadState(state: ThreadsState, thread: Thread): { words: string; role: Role } {
  if (thread.status === "running" || thread.status === "ready") return { words: thread.status, role: STATUS_ROLE[thread.status] };
  if (state.cycle.includes(thread.name)) return { words: `deadlocked on ${thread.on}`, role: "fault" };
  return { words: `${thread.status} on ${thread.on}`, role: STATUS_ROLE[thread.status] };
}

function itemDrawables(item: Item, center: Point, size: number): Drawable[] {
  const label = String(item.value);
  const fontSize = Math.min(size * 0.46, ((size - 14) / textWidth(label, 1, "read")));
  return [
    { id: `item-${item.id}`, kind: "rect", x: center.x, y: center.y, w: size, h: size, fill: "fill2", stroke: "accent", strokeWidth: 1.8, radius: 0.6, z: ITEM_Z },
    { ...labelDrawable(label, center, fontSize, "read", "ink", ITEM_Z + 1), id: `item-${item.id}-value` },
  ];
}

function carriedCenter(card: Rect): Point {
  return { x: card.x + card.w - PAD - CARRIED_SIZE / 2, y: card.y + card.h - 10 - CARRIED_SIZE / 2 };
}

function cardStroke(thread: Thread, deadlocked: boolean): Role {
  if (deadlocked) return "fault";
  return thread.status === "ready" ? "rule" : STATUS_ROLE[thread.status];
}

function threadDrawables(state: ThreadsState, geometry: Geometry): Drawable[] {
  return state.threads.flatMap((thread, index) => {
    const card = geometry.thread(index);
    const part = `${state.objectId}[${thread.name}]`;
    const { words, role } = threadState(state, thread);
    const id = `thread-${thread.name}`;
    const deadlocked = state.cycle.includes(thread.name);
    return [
      box(id, card, thread.status === "running" ? "fill2" : "fill", cardStroke(thread, deadlocked), deadlocked ? 2.6 : thread.status === "ready" ? 1 : 1.8, part),
      text(`${id}-name`, thread.name, { x: card.x + PAD, y: card.y + 28 }, 30, "ink", "start", part),
      text(`${id}-holds`, holdsText(state, thread), { x: card.x + card.w - PAD, y: card.y + 28 }, 20, "muted", "end", part),
      text(`${id}-state`, words, { x: card.x + PAD, y: card.y + 62 }, 24, role, "start", part),
      text(`${id}-doing`, thread.doing, { x: card.x + PAD, y: card.y + 92 }, 22, "muted", "start", part),
      ...(thread.carrying ? itemDrawables(thread.carrying, carriedCenter(card), CARRIED_SIZE) : []),
    ];
  });
}

function queueBoxDrawables(id: string, name: string, rect: Rect, status: string, statusRole: Role, queueLabel: string, state: ThreadsState): Drawable[] {
  const part = `${state.objectId}[${name}]`;
  return [
    box(id, rect, "fill", "rule", 1.4, part),
    text(`${id}-name`, name, { x: rect.x + PAD, y: rect.y + 28 }, 28, "ink", "start", part),
    text(`${id}-status`, status, { x: rect.x + rect.w - PAD, y: rect.y + 28 }, 22, statusRole, "end", part),
    text(`${id}-label`, queueLabel, { x: rect.x + PAD, y: rect.y + 84 }, 20, "muted", "start", part),
  ];
}

function boxDrawables(state: ThreadsState, geometry: Geometry): Drawable[] {
  const locks = state.locks.flatMap((lock, index) => queueBoxDrawables(`lock-${lock.name}`, lock.name, geometry.lock(index), ownerText(lock), lockInCycle(state, lock) ? "fault" : lock.owner ? "ok" : "muted", "queue", state));
  const conds = state.conds.flatMap((cond, index) => queueBoxDrawables(`cond-${cond.name}`, cond.name, geometry.cond(index), "", "muted", "asleep", state));
  return [...locks, ...conds, ...chipsOf(state, geometry).flatMap((chip) => chipDrawables(state, chip))];
}

function lockInCycle(state: ThreadsState, lock: Lock): boolean {
  return lock.owner !== null && state.cycle.includes(lock.owner) && lock.queue.some((thread) => state.cycle.includes(thread));
}

function connectorsOf(state: ThreadsState, geometry: Geometry): Connector[] {
  const cycle = new Set(state.cycle);
  const owners = state.locks.flatMap((lock, lockIndex): Connector[] => {
    if (lock.owner === null) return [];
    const ownerIndex = state.threads.findIndex((thread) => thread.name === lock.owner);
    const stagger = state.locks.slice(0, lockIndex).filter((other) => other.owner === lock.owner).length * 16;
    const card = geometry.thread(ownerIndex);
    const rect = geometry.lock(lockIndex);
    const inCycle = lockInCycle(state, lock);
    return [{ id: `owns-${lock.name}`, from: { x: rect.x, y: rect.y + 34 }, to: { x: card.x + card.w + 4, y: card.y + 34 + stagger }, role: inCycle ? "fault" : "ok", width: inCycle ? 2.4 : 1.3 }];
  });
  const waits = state.threads.flatMap((thread, threadIndex): Connector[] => {
    const lockIndex = state.locks.findIndex((lock) => lock.name === thread.on);
    if (thread.status !== "blocked" || lockIndex < 0) return [];
    const card = geometry.thread(threadIndex);
    const rect = geometry.lock(lockIndex);
    const inCycle = cycle.has(thread.name);
    return [{ id: `waits-${thread.name}`, from: { x: card.x + card.w + 4, y: card.y + card.h - 30 }, to: { x: rect.x - 4, y: rect.y + rect.h - 30 }, role: inCycle ? "fault" : "warn", width: inCycle ? 2.4 : 1.3 }];
  });
  return [...owners, ...waits];
}

function connectorDrawable(connector: Connector): Drawable {
  return { ...segmentDrawable("arrow", connector.from, connector.to, connector.role, connector.width, 2), id: connector.id };
}

function bufferDrawables(state: ThreadsState, geometry: Geometry): Drawable[] {
  const buffer = state.buffer;
  if (!buffer) return [];
  const part = `${state.objectId}[buffer]`;
  const top = geometry.bufferTop;
  const slotsTop = top + BUFFER_TITLE;
  const slotCenterY = slotsTop + geometry.slot / 2;
  const left = geometry.slotX(0) - geometry.slot / 2;
  const right = geometry.slotX(buffer.slots.length - 1) + geometry.slot / 2;
  const slots = buffer.slots.flatMap((item, index) => [
    box(`slot-${index}`, { x: geometry.slotX(index) - geometry.slot / 2, y: slotsTop, w: geometry.slot, h: geometry.slot }, "fill", "rule", 1.4, part),
    ...(item ? itemDrawables(item, { x: geometry.slotX(index), y: slotCenterY }, geometry.slot - 16) : []),
  ]);
  const markerBase = slotsTop + geometry.slot + 14;
  const markers = [
    { name: "out", slot: buffer.head, level: 0 },
    { name: "in", slot: buffer.tail, level: buffer.head === buffer.tail ? 1 : 0 },
  ].flatMap(({ name, slot, level }): Drawable[] => {
    const x = geometry.slotX(slot);
    const tip = markerBase + level * MARKER_STEP;
    return [
      { id: `buffer-${name}`, kind: "path", x, y: tip, points: [x, tip, x - 11, tip + 20, x + 11, tip + 20], closed: true, fill: "active", stroke: "none", z: 3, part },
      text(`buffer-${name}-label`, name, { x, y: tip + 40 }, 22, "active", "middle", part),
    ];
  });
  return [
    text("buffer-name", "buffer", { x: left, y: top + 14 }, 28, "ink", "start", part),
    text("buffer-count", `${buffer.slots.filter((slot) => slot !== null).length} of ${buffer.slots.length}`, { x: right, y: top + 14 }, 22, "muted", "end", part),
    ...slots,
    ...markers,
  ];
}

function newlyAppearing(before: ThreadsState, after: ThreadsState): Connector[] {
  const known = new Set(connectorsOf(before, geometryOf(before)).map((connector) => connector.id));
  return connectorsOf(after, geometryOf(after)).filter((connector) => !known.has(connector.id));
}

function putGlide(after: ThreadsState, op: LabOp, progress: number): Drawable[] {
  const buffer = after.buffer;
  const index = after.threads.findIndex((thread) => thread.name === op.args.t);
  if (!buffer || index < 0) return [];
  const geometry = geometryOf(after);
  const slot = (buffer.tail - 1 + buffer.slots.length) % buffer.slots.length;
  const item = buffer.slots[slot];
  if (!item) return [];
  const from = carriedCenter(geometry.thread(index));
  const to = { x: geometry.slotX(slot), y: geometry.bufferTop + BUFFER_TITLE + geometry.slot / 2 };
  const size = lerp(CARRIED_SIZE, geometry.slot - 16, progress);
  return itemDrawables(item, { x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress) }, size);
}

export const lab: LabDef<ThreadsSpec, ThreadsState> = {
  id: "threads",
  title: "Threads and locks",
  catalog: {
    summary: "Threads share one CPU. Locks show owner and wait queue, condition variables show sleepers, and a bounded buffer shows slots with in and out markers. The Lab checks every op is legal and errors with the fix. Put the object alone in \"on\".",
    spec: {
      threads: 'list of 1 to 5 thread names up to 10 characters, such as ["A","B"]',
      locks: 'optional list of up to 3 lock names, such as ["m"]',
      conds: 'optional list of up to 2 condition variable names, such as ["notEmpty"]; needs locks',
      buffer: 'optional {"capacity": 1 to 8} bounded buffer',
    },
    ops: Object.fromEntries(Object.entries(OPS).map(([name, definition]) => [name, definition.doc])),
    example: [
      '{"step":1,"say":"Two threads race for one lock. A takes it, so B has to wait.","scene":{"th":{"lab":"threads","threads":["A","B"],"locks":["m"]}},"do":[{"cue":"A takes","op":"acquire","on":["th"],"t":"A","lock":"m"},{"cue":"B has to wait","op":"block","on":["th"],"t":"B","lock":"m"}]}',
    ],
  },

  init(spec, objectId) {
    const threads = readNames(spec.threads, "threads", MAX_THREADS, MAX_THREAD_NAME, objectId);
    if (threads.length === 0) fail(`${objectId}: "threads" needs at least one name, such as ["A","B"]`);
    const locks = readNames(spec.locks, "locks", MAX_LOCKS, MAX_SHARED_NAME, objectId);
    const conds = readNames(spec.conds, "conds", MAX_CONDS, MAX_SHARED_NAME, objectId);
    if (conds.length > 0 && locks.length === 0) fail(`${objectId}: "conds" need at least one lock, because a wait releases a lock; add "locks": ["m"]`);
    const all = [...threads, ...locks, ...conds];
    const repeated = all.find((name, index) => all.indexOf(name) !== index);
    if (repeated) fail(`${objectId}: the name "${repeated}" is used twice; threads, locks and conds all need different names`);
    return {
      objectId,
      threads: threads.map((name) => ({ name, status: "ready", on: null, doing: "", carrying: null })),
      locks: locks.map((name) => ({ name, owner: null, queue: [] })),
      conds: conds.map((name) => ({ name, sleepers: [] })),
      buffer: readBuffer(spec, objectId),
      itemsMade: 0,
      cycle: [],
    };
  },

  apply(state, op) {
    const definition = OPS[op.name] ?? fail(`threads has no op "${op.name}"; ops: ${Object.keys(OPS).join(", ")}`);
    const next = structuredClone(state);
    if (op.name !== "deadlock") next.cycle = [];
    definition.run(next, op);
    return next;
  },

  size(state) {
    const { width, height } = geometryOf(state);
    return { w: width, h: height };
  },

  draw(state) {
    const geometry = geometryOf(state);
    return [
      ...threadDrawables(state, geometry),
      ...boxDrawables(state, geometry),
      ...bufferDrawables(state, geometry),
      ...connectorsOf(state, geometry).map(connectorDrawable),
    ];
  },

  duration: (op) => OPS[op.name]?.seconds ?? 0.8,

  during(before, after, op, progress) {
    const arrows = newlyAppearing(before, after).map((connector) => ({ ...connectorDrawable(connector), draw: progress }));
    return op.name === "put" ? [...arrows, ...putGlide(after, op, progress)] : arrows;
  },
};
