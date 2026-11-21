import { isRole, fail, lerp, type Drawable } from "./lab";
import {
  createObject, findObject, removeObject, requireObject, type SceneObject, type SceneState, upsertObject,
} from "./scene";
import type { ObjectSpec } from "./format";
import { parseRelation } from "./relation";
import type { Selector } from "./selector";

export type Effect =
  | { kind: "pulse" }
  | { kind: "trace" }
  | { kind: "swap"; direction: 1 | -1; distance: number };

export type Geometry = Pick<Drawable, "x" | "y" | "w" | "h" | "r" | "x2" | "y2" | "size" | "points" | "draw">;

export interface Touch {
  objectId: string;
  before: SceneObject | null;
  after: SceneObject | null;
  action: { type: "lab"; name: string; parts: string[]; args: Record<string, unknown> } | { type: "effect"; effect: Effect } | { type: "scene" };
}

export interface ParsedOp {
  index: number;
  cue?: string;
  name: string;
  selectors: Selector[];
  args: Record<string, unknown>;
}

interface VerbResult {
  scene: SceneState;
  touches: Touch[];
}

interface Verb {
  summary: string;
  duration: number;
  run(scene: SceneState, op: ParsedOp): VerbResult;
}

function sceneTouch(objectId: string, before: SceneObject | null, after: SceneObject | null): Touch {
  return { objectId, before, after, action: { type: "scene" } };
}

function ids(op: ParsedOp): string[] {
  return op.selectors.map((selector) => selector.id);
}

function roleArg(op: ParsedOp, fallback: string): string {
  const role = op.args.role ?? fallback;
  if (role !== "none" && !isRole(role)) fail(`op "${op.name}" role "${String(role)}" is not a meaning role: use active, compare, swap, done, ok, warn, fault, accent, highlight or none`);
  return role as string;
}

function setField(scene: SceneState, op: ParsedOp, field: "tint" | "highlight", fallbackRole: string): VerbResult {
  const role = roleArg(op, fallbackRole);
  let next = scene;
  const touches: Touch[] = [];
  for (const id of ids(op)) {
    const before = requireObject(next, id);
    const { [field]: _removed, ...rest } = before;
    const after: SceneObject = role === "none" ? rest : { ...rest, [field]: role };
    next = upsertObject(next, after);
    touches.push(sceneTouch(id, before, after));
  }
  return { scene: next, touches };
}

function effectVerb(kind: "pulse" | "trace"): Verb["run"] {
  return (scene, op) => ({
    scene,
    touches: ids(op).map((id) => {
      const object = requireObject(scene, id);
      return { objectId: id, before: object, after: object, action: { type: "effect", effect: { kind } } };
    }),
  });
}

function specArg(op: ParsedOp, key: string): ObjectSpec {
  const value = op.args[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`op "${op.name}" needs "${key}" as an object spec`);
  return value as ObjectSpec;
}

function requireIds(op: ParsedOp, count: number | "any"): string[] {
  const selected = ids(op);
  if (count === "any" ? selected.length === 0 : selected.length !== count) {
    fail(`op "${op.name}" needs ${count === "any" ? "at least one" : count} object in "on"`);
  }
  return selected;
}

const VERBS: Record<string, Verb> = {
  create: {
    summary: 'create: {"on":["id"],"spec":{...object spec}} adds an object that fades in on its Cue',
    duration: 0.8,
    run(scene, op) {
      const [id] = requireIds(op, 1);
      const object = createObject(id!, specArg(op, "spec"), scene);
      return { scene: upsertObject(scene, object), touches: [sceneTouch(id!, null, object)] };
    },
  },
  remove: {
    summary: 'remove: {"on":["id",...]} fades objects out',
    duration: 0.7,
    run(scene, op) {
      let next = scene;
      const touches = requireIds(op, "any").map((id) => {
        const before = requireObject(next, id);
        next = removeObject(next, id);
        return sceneTouch(id, before, null);
      });
      return { scene: next, touches };
    },
  },
  move: {
    summary: 'move: {"on":["id"],"to":<relation>} moves objects to a new place such as "top" or {"below":"id"}',
    duration: 0.9,
    run(scene, op) {
      if (op.args.to === undefined) fail(`op "move" needs "to" as a relation such as "top" or {"below":"id"}`);
      let next = scene;
      const touches = requireIds(op, "any").map((id) => {
        const before = requireObject(next, id);
        const after = { ...before, at: parseRelation(id, op.args.to) };
        next = upsertObject(next, after);
        return sceneTouch(id, before, after);
      });
      return { scene: next, touches };
    },
  },
  morph: {
    summary: 'morph: {"on":["id"],"into":{...object spec}} turns an object into another spec, animating the difference',
    duration: 1,
    run(scene, op) {
      const [id] = requireIds(op, 1);
      const before = requireObject(scene, id!);
      const after = createObject(id!, { at: before.at, ...specArg(op, "into") }, scene);
      return { scene: upsertObject(scene, after), touches: [sceneTouch(id!, before, after)] };
    },
  },
  highlight: {
    summary: 'highlight: {"on":["id"],"role":"active"} outlines objects by meaning role; role "none" clears',
    duration: 0.5,
    run: (scene, op) => setField(scene, op, "highlight", "highlight"),
  },
  color: {
    summary: 'color: {"on":["id"],"role":"done"} recolors objects by meaning role such as active, done, fault; "none" clears',
    duration: 0.6,
    run: (scene, op) => setField(scene, op, "tint", "active"),
  },
  pulse: { summary: 'pulse: {"on":["id"]} swells an object once', duration: 0.7, run: effectVerb("pulse") },
  trace: { summary: 'trace: {"on":["id"]} draws a line, arrow or path along its length', duration: 1.2, run: effectVerb("trace") },
  swap: {
    summary: 'swap: {"on":["a","b"]} two objects trade places on arcs',
    duration: 0.9,
    run(scene, op) {
      const [firstId, secondId] = requireIds(op, 2);
      const first = requireObject(scene, firstId!);
      const second = requireObject(scene, secondId!);
      const firstIndex = scene.objects.indexOf(first);
      const secondIndex = scene.objects.indexOf(second);
      const movedFirst = { ...first, at: second.at };
      const movedSecond = { ...second, at: first.at };
      const reordered = [...scene.objects];
      reordered[firstIndex] = movedSecond;
      reordered[secondIndex] = movedFirst;
      const distance = Math.abs(firstIndex - secondIndex);
      return {
        scene: { ...scene, objects: reordered },
        touches: [
          { objectId: first.id, before: first, after: movedFirst, action: { type: "effect", effect: { kind: "swap", direction: 1, distance } } },
          { objectId: second.id, before: second, after: movedSecond, action: { type: "effect", effect: { kind: "swap", direction: -1, distance } } },
        ],
      };
    },
  },
  focus: {
    summary: 'focus: {"on":["id"]} zooms and pans the camera onto an object; empty "on" resets the camera',
    duration: 1.1,
    run(scene, op) {
      const selected = ids(op);
      if (selected.length > 1) fail(`op "focus" takes one object in "on", or none to reset`);
      const target = selected[0] ?? null;
      if (target !== null) requireObject(scene, target);
      return { scene: { ...scene, focus: target }, touches: [] };
    },
  },
  connect: {
    summary: 'connect: {"on":["a","b"],"label"?:text} draws an arrow from a to b that follows both objects',
    duration: 0.9,
    run(scene, op) {
      const [from, to] = requireIds(op, 2);
      requireObject(scene, from!);
      requireObject(scene, to!);
      const id = typeof op.args.id === "string" ? op.args.id : `${from}-${to}`;
      const spec: ObjectSpec = { kind: "edge", from, to, directed: true, ...(op.args.label ? { label: op.args.label } : {}) };
      const object = createObject(id, spec, scene);
      return { scene: upsertObject(scene, object), touches: [sceneTouch(id, null, object)] };
    },
  },
  split: {
    summary: 'split: {"on":["id"],"into":{"newId":{...spec},...}} replaces an object with parts laid out in a row',
    duration: 1,
    run(scene, op) {
      const [id] = requireIds(op, 1);
      const original = requireObject(scene, id!);
      const parts = op.args.into as Record<string, ObjectSpec> | undefined;
      if (!parts || typeof parts !== "object" || Object.keys(parts).length < 2) fail(`op "split" needs "into" with at least two new objects`);
      const partIds = Object.keys(parts);
      let next = removeObject(scene, id!);
      const touches: Touch[] = [sceneTouch(id!, original, null)];
      partIds.forEach((partId, index) => {
        const spec: ObjectSpec = index === 0 ? { ...parts[partId]!, at: { row: partIds } } : parts[partId]!;
        const object = createObject(partId, spec, scene);
        if (findObject(next, partId)) fail(`op "split" part "${partId}" already exists`);
        next = upsertObject(next, object);
        touches.push(sceneTouch(partId, null, object));
      });
      return { scene: next, touches };
    },
  },
};

export function findVerb(name: string): Verb | undefined {
  return VERBS[name];
}

export function verbSummaries(): string[] {
  return Object.values(VERBS).map((verb) => verb.summary);
}

export function verbNames(): string[] {
  return Object.keys(VERBS);
}

const ARC_PER_STEP = 40;
const ARC_LIMIT = 150;

export function applyEffect<T extends Geometry>(effect: Effect, items: T[], progress: number, center: { x: number; y: number }): T[] {
  if (effect.kind === "trace") return items.map((item) => (item.draw === undefined ? item : { ...item, draw: progress }));
  if (effect.kind === "swap") {
    const lift = effect.direction * Math.sin(Math.PI * progress) * Math.min(ARC_LIMIT, ARC_PER_STEP * (1 + effect.distance));
    return items.map((item) => ({ ...item, y: item.y - lift, y2: item.y2 === undefined ? undefined : item.y2 - lift }));
  }
  const scale = lerp(1, 1.12, Math.sin(Math.PI * progress));
  const about = (value: number, origin: number) => origin + (value - origin) * scale;
  return items.map((item) => ({
    ...item,
    x: about(item.x, center.x),
    y: about(item.y, center.y),
    w: item.w === undefined ? undefined : item.w * scale,
    h: item.h === undefined ? undefined : item.h * scale,
    r: item.r === undefined ? undefined : item.r * scale,
    size: item.size === undefined ? undefined : item.size * scale,
    x2: item.x2 === undefined ? undefined : about(item.x2, center.x),
    y2: item.y2 === undefined ? undefined : about(item.y2, center.y),
  }));
}
