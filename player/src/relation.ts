import { fail, type Point, type Rect, type Size } from "./lab";

export const RELATION_GAP = 36;

export const REGIONS = ["center", "top", "bottom", "left", "right"] as const;
export const SIDES = ["below", "above", "left of", "right of", "next to"] as const;
export const GROUP_KINDS = ["row", "column", "grid", "ring", "timeline", "tree"] as const;

export type Region = (typeof REGIONS)[number];
export type Side = (typeof SIDES)[number];
export type GroupKind = (typeof GROUP_KINDS)[number];

export type Relation =
  | Region
  | { below: string } | { above: string } | { "left of": string } | { "right of": string } | { "next to": string }
  | { row: string[] } | { column: string[] } | { grid: string[] } | { ring: string[] } | { timeline: string[] }
  | { tree: Record<string, string[]> };

interface RegionEntry {
  doc: string;
}

interface SideEntry {
  doc: string;
  spot(anchor: Rect, size: Size, gap: number): Point;
  clear(spot: Point, occupant: Rect, size: Size, gap: number): Point;
}

interface GroupEntry {
  doc: string;
  form: string;
  valid(value: unknown): boolean;
  ids(value: unknown): string[];
}

const REGION_ENTRIES: Record<Region, RegionEntry> = {
  center: { doc: "the middle of the stage, on its own" },
  top: { doc: "a band along the top edge, centered; several top objects stack downward" },
  bottom: { doc: "a band along the bottom edge, centered; several bottom objects stack upward" },
  left: { doc: "a column on the left of the stage" },
  right: { doc: "a column on the right of the stage" },
};

const centered = (anchor: Rect, size: Size): Point => ({ x: anchor.x + anchor.w / 2 - size.w / 2, y: anchor.y + anchor.h / 2 - size.h / 2 });

const SIDE_ENTRIES: Record<Side, SideEntry> = {
  below: {
    doc: "centered under the named object",
    spot: (anchor, size, gap) => ({ x: centered(anchor, size).x, y: anchor.y + anchor.h + gap }),
    clear: (spot, occupant, _size, gap) => ({ x: spot.x, y: occupant.y + occupant.h + gap }),
  },
  above: {
    doc: "centered over the named object",
    spot: (anchor, size, gap) => ({ x: centered(anchor, size).x, y: anchor.y - size.h - gap }),
    clear: (spot, occupant, size, gap) => ({ x: spot.x, y: occupant.y - size.h - gap }),
  },
  "left of": {
    doc: "vertically centered, to the left of the named object",
    spot: (anchor, size, gap) => ({ x: anchor.x - size.w - gap, y: centered(anchor, size).y }),
    clear: (spot, occupant, size, gap) => ({ x: occupant.x - size.w - gap, y: spot.y }),
  },
  "right of": {
    doc: "vertically centered, to the right of the named object",
    spot: (anchor, size, gap) => ({ x: anchor.x + anchor.w + gap, y: centered(anchor, size).y }),
    clear: (spot, occupant, _size, gap) => ({ x: occupant.x + occupant.w + gap, y: spot.y }),
  },
  "next to": {
    doc: "the same as right of",
    spot: (anchor, size, gap) => ({ x: anchor.x + anchor.w + gap, y: centered(anchor, size).y }),
    clear: (spot, occupant, _size, gap) => ({ x: occupant.x + occupant.w + gap, y: spot.y }),
  },
};

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");

const listEntry = (doc: string): GroupEntry => ({ doc, form: '["id", ...]', valid: isIdList, ids: (value) => value as string[] });

const isTree = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0 && Object.values(value).every((children) => Array.isArray(children) && children.every((child) => typeof child === "string"));

const GROUP_ENTRIES: Record<GroupKind, GroupEntry> = {
  row: listEntry("lays the listed objects, and this one, out left to right and centered on one line"),
  column: listEntry("lays the listed objects out top to bottom and centered"),
  grid: listEntry("lays the listed objects out in a square-ish grid, row by row"),
  ring: listEntry("lays the listed objects out around a circle"),
  timeline: listEntry("a row with wide gaps, for events in order"),
  tree: {
    doc: "lays out a tree from a parent to children map; roots are the objects that are nobody's child",
    form: '{"parent": ["child", ...], ...}',
    valid: isTree,
    ids: (value) => [...new Set(Object.entries(value as Record<string, string[]>).flatMap(([parent, children]) => [parent, ...children]))],
  },
};

const isRegion = (value: unknown): value is Region => typeof value === "string" && (REGIONS as readonly string[]).includes(value);
const isSide = (key: string): key is Side => (SIDES as readonly string[]).includes(key);
const isGroupKind = (key: string): key is GroupKind => (GROUP_KINDS as readonly string[]).includes(key);

const FORMS = [
  ...REGIONS.map((region) => `"${region}"`),
  ...SIDES.map((side) => `{"${side}": "id"}`),
  ...GROUP_KINDS.map((kind) => `{"${kind}": ${GROUP_ENTRIES[kind].form}}`),
].join(", ");

export function parseRelation(id: string, value: unknown): Relation {
  if (isRegion(value)) return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const key = keys[0];
    if (keys.length === 1 && key !== undefined) {
      const entry = (value as Record<string, unknown>)[key];
      if (isSide(key)) {
        if (entry === id) return fail(`${id}: "at" ${JSON.stringify(key)} names the object itself; name another object`);
        if (typeof entry === "string" && entry) return value as Relation;
        return fail(`${id}: "at" ${JSON.stringify(key)} needs the id of another object, as {"${key}": "id"}`);
      }
      if (isGroupKind(key)) {
        if (GROUP_ENTRIES[key].valid(entry)) return value as Relation;
        return fail(`${id}: "at" ${JSON.stringify(key)} needs ${GROUP_ENTRIES[key].form}`);
      }
    }
    const shown = keys.length === 1 ? key : JSON.stringify(value);
    return fail(`${id}: "at" ${JSON.stringify(shown)} is not a relation; use one of ${FORMS}`);
  }
  return fail(`${id}: "at" ${JSON.stringify(value)} is not a relation; use one of ${FORMS}`);
}

export function regionOf(relation: Relation | undefined): Region | "flow" {
  return typeof relation === "string" ? relation : "flow";
}

export function sideOf(relation: Relation | undefined): { side: Side; target: string } | null {
  if (!relation || typeof relation === "string") return null;
  const side = SIDES.find((candidate) => candidate in relation);
  return side ? { side, target: (relation as Record<string, string>)[side]! } : null;
}

export function groupOf(relation: Relation | undefined): { kind: GroupKind; ids: string[] } | null {
  if (!relation || typeof relation === "string") return null;
  const kind = GROUP_KINDS.find((candidate) => candidate in relation);
  return kind ? { kind, ids: GROUP_ENTRIES[kind].ids((relation as Record<string, unknown>)[kind]) } : null;
}

export function relationTargets(relation: Relation | undefined): string[] {
  const side = sideOf(relation);
  if (side) return [side.target];
  return groupOf(relation)?.ids ?? [];
}

export function relationProblems(placed: readonly { id: string; at?: Relation }[], gone: ReadonlySet<string> = new Set()): string[] {
  const ids = new Set(placed.map((object) => object.id));
  const anchors = new Map(placed.flatMap((object) => {
    const side = sideOf(object.at);
    return side ? [[object.id, side.target] as const] : [];
  }));
  const problems: string[] = [];
  for (const object of placed) {
    for (const target of relationTargets(object.at)) {
      if (gone.has(target)) problems.push(`${object.id} still sits relative to "${target}" from an earlier Step, and this Step takes "${target}" off the stage; give ${object.id} a new place in this Step (a "move" op with "to", or its full spec with a new "at" in "scene"), or keep "${target}"`);
      else if (!ids.has(target)) problems.push(`${object.id} is placed relative to "${target}", which is not an object in the Scene; "at" names a whole object, never a node, part or value inside one; objects: ${[...ids].join(", ")}`);
    }
  }
  const cleared = new Set<string>();
  for (const start of anchors.keys()) {
    const trail: string[] = [];
    for (let id: string | undefined = start; id !== undefined && !cleared.has(id); id = anchors.get(id)) {
      const seen = trail.indexOf(id);
      if (seen >= 0) {
        const loop = trail.slice(seen);
        if (loop.length > 1) problems.push(`placement loop between ${[...loop, id].join(" -> ")}: break the cycle in "at"`);
        break;
      }
      trail.push(id);
    }
    trail.forEach((id) => cleared.add(id));
  }
  return problems;
}

export function sideSpot(side: Side, anchor: Rect, size: Size, gap = RELATION_GAP): Point {
  return SIDE_ENTRIES[side].spot(anchor, size, gap);
}

export function sideClear(side: Side, spot: Point, occupant: Rect, size: Size, gap = RELATION_GAP): Point {
  return SIDE_ENTRIES[side].clear(spot, occupant, size, gap);
}

export function relationDocs(): string[] {
  return [
    ...REGIONS.map((region) => `"at": "${region}" - ${REGION_ENTRIES[region].doc}`),
    ...SIDES.map((side) => `"at": {"${side}": "id"} - ${SIDE_ENTRIES[side].doc}; if that spot is taken, it moves outward until it clears`),
    ...GROUP_KINDS.map((kind) => `"at": {"${kind}": ${GROUP_ENTRIES[kind].form}} - ${GROUP_ENTRIES[kind].doc}`),
    "An object with no \"at\" goes into the flow, stacked top to bottom between the top and bottom bands.",
  ];
}
