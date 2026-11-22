import { definitionByKey, definitionIfRegistered, definitionKeyForSpec, specText, wordlessKeys } from "./registry";
import type { LessonHeader, ObjectSpec } from "./format";
import { type AnyLabDef, fail, isRole, type Role } from "./lab";
import { shareRadius } from "./primitives/node";
import { parseRelation, type Relation } from "./relation";

export interface SceneObject {
  id: string;
  defKey: string;
  state: unknown;
  at?: Relation;
  tint?: Role;
  highlight?: Role;
}

export interface SceneState {
  objects: readonly SceneObject[];
  focus: string | null;
  reading?: boolean;
}

export interface SceneSnapshot {
  objects: { id: string; defKey: string; state: unknown; at?: Relation; tint?: Role; highlight?: Role }[];
  focus: string | null;
}

export const EMPTY_SCENE: SceneState = { objects: [], focus: null };

export function snapshotOf(scene: SceneState): SceneSnapshot {
  return {
    objects: scene.objects.map(({ id, defKey, state, at, tint, highlight }) => ({ id, defKey, state, at, tint, highlight })),
    focus: scene.focus,
  };
}

function snapshotObject(value: unknown, index: number): SceneObject {
  const where = `scene.objects[${index}]`;
  if (typeof value !== "object" || value === null) return fail(`${where} must be an object with "id", "defKey" and "state"`);
  const { id, defKey, state, at, tint, highlight } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id) return fail(`${where} needs an "id" as text`);
  if (typeof defKey !== "string" || !definitionIfRegistered(defKey)) return fail(`${where} (${id}) has defKey ${JSON.stringify(defKey)}, which is not a registered Lab or primitive`);
  if (state === undefined || state === null) return fail(`${where} (${id}) needs a "state"`);
  for (const [name, role] of [["tint", tint], ["highlight", highlight]] as const) {
    if (role !== undefined && !isRole(role)) fail(`${where} (${id}) has ${name} ${JSON.stringify(role)}, which is not a role`);
  }
  return { id, defKey, state, ...(at == null ? {} : { at: parseRelation(id, at) }), ...(tint === undefined ? {} : { tint: tint as Role }), ...(highlight === undefined ? {} : { highlight: highlight as Role }) };
}

export function sceneFromSnapshot(value: unknown): SceneState {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { objects?: unknown }).objects)) {
    return fail('a scene snapshot must be an object with an "objects" list and a "focus"');
  }
  const { objects, focus } = value as { objects: unknown[]; focus?: unknown };
  if (focus !== undefined && focus !== null && typeof focus !== "string") return fail('a scene snapshot "focus" must be an object id or null');
  const parsed = objects.map(snapshotObject);
  const duplicate = parsed.find((object, index) => parsed.findIndex((other) => other.id === object.id) !== index);
  if (duplicate) return fail(`scene snapshot lists "${duplicate.id}" twice`);
  return { objects: parsed, focus: focus ?? null };
}

export function definitionOf(object: SceneObject): AnyLabDef {
  return definitionByKey(object.defKey);
}

export function startSceneOf(header: LessonHeader): SceneState {
  return { ...(header.start_scene === undefined ? EMPTY_SCENE : sceneFromSnapshot(header.start_scene)), reading: header.reading !== false };
}

export function createObject(id: string, spec: ObjectSpec, scene: SceneState): SceneObject {
  const defKey = definitionKeyForSpec(id, spec);
  const def = definitionByKey(defKey);
  const reading = scene.reading !== false;
  if (!reading && def.reading === "required") {
    fail(`${id}: ${specText(defKey)} needs reading, and this Lesson has "reading": false, for a child who cannot read; use a Lab or kind that works without words (${wordlessKeys().join(", ")})`);
  }
  const { at, ...fields } = spec;
  const state = def.init({ ...fields, reading }, id);
  return at === undefined ? { id, defKey, state } : { id, defKey, state, at: parseRelation(id, at) };
}

export function findObject(scene: SceneState, id: string): SceneObject | undefined {
  return scene.objects.find((object) => object.id === id);
}

export function requireObject(scene: SceneState, id: string): SceneObject {
  const object = findObject(scene, id);
  if (object) return object;
  const present = scene.objects.map((entry) => entry.id).join(", ") || "none yet";
  return fail(`unknown object "${id}"; objects in the Scene: ${present}`);
}

export function upsertObject(scene: SceneState, object: SceneObject): SceneState {
  const exists = scene.objects.some((entry) => entry.id === object.id);
  const objects = exists
    ? scene.objects.map((entry) => (entry.id === object.id ? object : entry))
    : [...scene.objects, object];
  return { ...scene, objects: shareRadius(objects) };
}

export function removeObject(scene: SceneState, id: string): SceneState {
  if (!findObject(scene, id)) fail(`"${id}": null takes an object off the stage, and "${id}" is not on stage (on stage: ${scene.objects.map((entry) => entry.id).join(", ") || "none yet"}); leave "${id}" out of "scene", or give its full spec there to bring it in`);
  const focus = scene.focus === id ? null : scene.focus;
  return { ...scene, objects: scene.objects.filter((entry) => entry.id !== id), focus };
}

export function applySceneSpecs(scene: SceneState, specs: Record<string, ObjectSpec | null>): SceneState {
  let next = scene;
  for (const [id, spec] of Object.entries(specs)) {
    if (spec === null) {
      next = removeObject(next, id);
      continue;
    }
    const created = createObject(id, spec, next);
    if (!alreadyOnStage(findObject(next, id), created)) next = upsertObject(next, created);
  }
  return next;
}

function alreadyOnStage(existing: SceneObject | undefined, created: SceneObject): boolean {
  return existing !== undefined && !existing.tint && !existing.highlight && existing.defKey === created.defKey && sameValue(existing.at, created.at) && sameValue(existing.state, created.state);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
