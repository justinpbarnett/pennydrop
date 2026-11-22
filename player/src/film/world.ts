import { fail } from "../lab";
import { definitionOf, type SceneObject, type SceneState } from "../scene";
import { frameAround } from "./screen";

export interface Placement {
  id: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

export const PLANE_GAP = 380;
export const PLANE_DEPTH = 900;
const PEEK = 0.08;
const PEEK_CLEARANCE = 60;

const SIDES = ["next", "right of", "left of", "above", "below", "behind", "in front of"] as const;
type Side = (typeof SIDES)[number];

export const WORLD_RELATIONS = SIDES;

function relationOf(object: SceneObject): { side: Side; target: string } | null {
  const at = object.at;
  if (at === undefined || typeof at === "string") return null;
  const [side, target] = Object.entries(at)[0] ?? [];
  if (!(SIDES as readonly string[]).includes(side as string) || typeof target !== "string") {
    return fail(`${object.id}: "at" must be one of ${SIDES.map((name) => `{"${name}": "id"}`).join(", ")}; the first piece needs none`);
  }
  return { side: side as Side, target };
}

type Size = { w: number; h: number };

function gapBetween(target: Size, size: Size, axis: "w" | "h"): number {
  const room = (piece: Size) => (frameAround(piece, "fit")[axis] - piece[axis]) / 2;
  return Math.max(PLANE_GAP, room(target) + PEEK_CLEARANCE, room(size) + PEEK_CLEARANCE);
}

function spotFor(side: Side, target: Placement, size: Size): { x: number; y: number; z: number } {
  const across = gapBetween(target, size, "w");
  const down = gapBetween(target, size, "h");
  const centerX = target.x + target.w / 2 - size.w / 2;
  const centerY = target.y + target.h / 2 - size.h / 2;
  switch (side) {
    case "next":
    case "right of": return { x: target.x + target.w + across, y: centerY, z: target.z };
    case "left of": return { x: target.x - size.w - across, y: centerY, z: target.z };
    case "above": return { x: centerX, y: target.y - size.h - down, z: target.z };
    case "below": return { x: centerX, y: target.y + target.h + down, z: target.z };
    case "behind": return { x: centerX + target.w * PEEK, y: centerY - target.h * PEEK, z: target.z - PLANE_DEPTH };
    case "in front of": return { x: centerX - target.w * PEEK, y: centerY + target.h * PEEK, z: target.z + PLANE_DEPTH };
  }
}

const worlds = new WeakMap<SceneState, ReadonlyMap<string, Placement>>();

export function layoutWorld(scene: SceneState): ReadonlyMap<string, Placement> {
  const cached = worlds.get(scene);
  if (cached) return cached;
  const objects = new Map(scene.objects.filter((object) => !definitionOf(object).overlay).map((object) => [object.id, object]));
  const placed = new Map<string, Placement>();
  const resolve = (object: SceneObject, trail: string[]): Placement => {
    const known = placed.get(object.id);
    if (known) return known;
    if (trail.includes(object.id)) fail(`placement loop between ${[...trail, object.id].join(" -> ")}: break the cycle in "at"`);
    const size = definitionOf(object).size(object.state);
    const relation = relationOf(object);
    let spot = { x: 0, y: 0, z: 0 };
    if (relation) {
      const anchor = objects.get(relation.target);
      if (!anchor) return fail(`${object.id} is placed ${relation.side} "${relation.target}", which is not in the Scene`);
      spot = spotFor(relation.side, resolve(anchor, [...trail, object.id]), size);
    }
    const placement = { id: object.id, ...spot, ...size };
    placed.set(object.id, placement);
    return placement;
  };
  objects.forEach((object) => resolve(object, []));
  const roots = [...objects.values()].filter((object) => relationOf(object) === null);
  if (roots.length > 1) fail(`${roots.map((object) => object.id).join(" and ")} all have no "at" and would share the origin; place all but the first relative to another piece`);
  worlds.set(scene, placed);
  return placed;
}

export function centerOf(placement: Placement): { x: number; y: number; z: number } {
  return { x: placement.x + placement.w / 2, y: placement.y + placement.h / 2, z: placement.z };
}

export function focusedOn(placement: Placement, focus: { x: number; y: number; zoom: number }): Placement {
  const w = placement.w / focus.zoom;
  const h = (w * 9) / 16;
  return { ...placement, x: placement.x + focus.x * placement.w - w / 2, y: placement.y + focus.y * placement.h - h / 2, w, h };
}
