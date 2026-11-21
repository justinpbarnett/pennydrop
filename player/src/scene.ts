import { definitionByKey, definitionKeyForSpec, specText, wordlessKeys } from "./registry";
import type { LessonHeader, ObjectSpec } from "./format";
import { type AnyLabDef, fail, type Role } from "./lab";
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

export const EMPTY_SCENE: SceneState = { objects: [], focus: null };

export function definitionOf(object: SceneObject): AnyLabDef {
  return definitionByKey(object.defKey);
}

export function startSceneOf(header: LessonHeader): SceneState {
  return { ...(header.start_scene ?? EMPTY_SCENE), reading: header.reading !== false };
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
  return { ...scene, objects };
}

export function removeObject(scene: SceneState, id: string): SceneState {
  requireObject(scene, id);
  const focus = scene.focus === id ? null : scene.focus;
  return { ...scene, objects: scene.objects.filter((entry) => entry.id !== id), focus };
}

export function applySceneSpecs(scene: SceneState, specs: Record<string, ObjectSpec | null>): SceneState {
  let next = scene;
  for (const [id, spec] of Object.entries(specs)) {
    next = spec === null ? removeObject(next, id) : upsertObject(next, createObject(id, spec, next));
  }
  return next;
}
