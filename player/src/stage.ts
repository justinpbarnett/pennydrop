import type { Color, Drawable, Link, Paint, Role } from "./lab";
import { type Box, type Layout, layoutScene, STAGE } from "./layout";
import { captionDrawable, definitionOf, type SceneObject, type SceneState } from "./scene";
import { reachOf } from "./ink";
import { type Theme, THEMES } from "./theme";

export interface PlacedObject {
  id: string;
  box: Box;
  drawables: Drawable[];
}

export interface Camera {
  cx: number;
  cy: number;
  zoom: number;
}

export interface Stage {
  objects: PlacedObject[];
  camera: Camera;
}

export const HOME_CAMERA: Camera = { cx: STAGE.w / 2, cy: STAGE.h / 2, zoom: 1 };
const OVERLAY_BOX: Box = { x: 0, y: 0, w: STAGE.w, h: STAGE.h, scale: 1 };
const KEEP_ROLES: readonly Paint[] = ["ground", "rule", "muted", "none", "edge"];

export function placeDrawables(objectId: string, local: Drawable[], box: Box): Drawable[] {
  const s = box.scale;
  return local.map((drawable) => {
    const placed: Drawable = { ...drawable, id: `${objectId}/${drawable.id}`, x: box.x + drawable.x * s, y: box.y + drawable.y * s };
    for (const key of ["w", "h", "r", "size", "strokeWidth"] as const) {
      if (drawable[key] !== undefined) placed[key] = drawable[key]! * s;
    }
    if (drawable.clip) placed.clip = { x: box.x + drawable.clip.x * s, y: box.y + drawable.clip.y * s, w: drawable.clip.w * s, h: drawable.clip.h * s };
    if (drawable.x2 !== undefined) placed.x2 = box.x + drawable.x2 * s;
    if (drawable.y2 !== undefined) placed.y2 = box.y + drawable.y2 * s;
    if (drawable.layer) placed.layer = { ...drawable.layer, id: `${objectId}/${drawable.layer.id}` };
    if (drawable.points) placed.points = drawable.points.map((value, index) => (index % 2 === 0 ? box.x : box.y) + value * s);
    return placed;
  });
}

function tinted(drawable: Drawable, color: Color): Drawable {
  const recolor = (paint: Paint | undefined) => (paint === undefined || KEEP_ROLES.includes(paint) ? paint : color);
  return {
    ...drawable,
    fill: recolor(drawable.fill),
    stroke: recolor(drawable.stroke),
    spans: drawable.spans?.map((span) => ({ ...span, role: KEEP_ROLES.includes(span.role) ? span.role : color })),
  };
}

type Bounds = [number, number, number, number];

const OBJECT_PAD = 14;
const PART_PAD = 8;
const OUTLINE_WIDTH = 1.6;
const ABOVE_PART = 0.5;

function outlineLook(role: Role, z: number): Pick<Drawable, "kind" | "fill" | "stroke" | "strokeWidth" | "z"> {
  return { kind: "rect", fill: "none", stroke: role, strokeWidth: OUTLINE_WIDTH, z };
}

function boxOutline(id: string, role: Role, [left, top, right, bottom]: Bounds, pad: number, z: number): Drawable {
  return { id, ...outlineLook(role, z), x: (left + right) / 2, y: (top + bottom) / 2, w: right - left + 2 * pad, h: bottom - top + 2 * pad, radius: 1 };
}

function strokeOutline(id: string, role: Role, line: Drawable, theme: Theme, z: number): Drawable {
  const [dx, dy] = [line.x2! - line.x, line.y2! - line.y];
  const thickness = (line.strokeWidth ?? 0) * theme.stroke + 2 * PART_PAD;
  return {
    id,
    ...outlineLook(role, z),
    x: line.x + dx / 2,
    y: line.y + dy / 2,
    w: Math.hypot(dx, dy) + thickness,
    h: thickness,
    radius: thickness / 2,
    rotation: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

function inkTopOf(local: Drawable[], box: Box, theme: Theme): number {
  return reachOf(local, { w: box.w / box.scale, h: box.h / box.scale }, theme).top;
}

function inkBounds(local: Drawable[], box: Box, theme: Theme): Bounds {
  const [w, h] = [box.w / box.scale, box.h / box.scale];
  const reach = reachOf(local, { w, h }, theme);
  return [-reach.left, -reach.top, w + reach.right, h + reach.bottom];
}

function outlined(object: SceneObject, local: Drawable[], box: Box, theme: Theme): Drawable[] {
  const role = object.highlight;
  if (!role) return [];
  const shown = local.filter((drawable) => drawable.part !== undefined && !drawable.tapPad && object.highlightParts?.includes(drawable.part));
  const z = Math.max(...shown.map((drawable) => drawable.z ?? 0)) + ABOVE_PART;
  const areas = shown.map(shapeBounds).filter((bounds) => bounds !== null);
  if (areas.length > 0) {
    const union: Bounds = [Math.min(...areas.map((bounds) => bounds[0])), Math.min(...areas.map((bounds) => bounds[1])), Math.max(...areas.map((bounds) => bounds[2])), Math.max(...areas.map((bounds) => bounds[3]))];
    return [boxOutline("_highlight", role, union, PART_PAD, z)];
  }
  const strokes = shown.filter((drawable) => drawable.kind === "line");
  if (strokes.length > 0) return strokes.map((line, index) => strokeOutline(`_highlight-${index}`, role, line, theme, z));
  return [boxOutline("_highlight", role, inkBounds(local, box, theme), OBJECT_PAD, -1)];
}

function shapeBounds(drawable: Drawable): Bounds | null {
  if (drawable.kind === "rect" && drawable.w !== undefined && drawable.h !== undefined) return [drawable.x - drawable.w / 2, drawable.y - drawable.h / 2, drawable.x + drawable.w / 2, drawable.y + drawable.h / 2];
  if (drawable.kind === "circle" && drawable.r !== undefined) return [drawable.x - drawable.r, drawable.y - drawable.r, drawable.x + drawable.r, drawable.y + drawable.r];
  return null;
}

type LayoutOf = (scene: SceneState, theme?: Theme) => Layout;
const GEOMETRY_ONLY: object = {};
const localDrawables = new WeakMap<object, WeakMap<SceneObject, Drawable[]>>();

function drawnIn(theme: Theme | undefined): WeakMap<SceneObject, Drawable[]> {
  let drawn = localDrawables.get(theme ?? GEOMETRY_ONLY);
  if (!drawn) localDrawables.set(theme ?? GEOMETRY_ONLY, (drawn = new WeakMap()));
  return drawn;
}
const stagesByLayout = new WeakMap<LayoutOf, WeakMap<object, WeakMap<SceneState, Stage>>>();

function linksFor(scene: SceneState, boxes: ReadonlyMap<string, Box>): Record<string, Link> {
  const links: Record<string, Link> = {};
  for (const object of scene.objects) {
    const box = boxes.get(object.id);
    if (box) links[object.id] = { x: box.x, y: box.y, w: box.w, h: box.h, round: Boolean(definitionOf(object).round) };
  }
  return links;
}

function cameraFor(scene: SceneState, boxes: ReadonlyMap<string, Box>): Camera {
  const box = scene.focus ? boxes.get(scene.focus) : undefined;
  if (!box) return HOME_CAMERA;
  const zoom = Math.max(1, Math.min(2.6, 1100 / box.w, 600 / box.h));
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom };
}

export function buildStage(scene: SceneState, layout: LayoutOf = layoutScene, theme?: Theme): Stage {
  let perTheme = stagesByLayout.get(layout);
  if (!perTheme) stagesByLayout.set(layout, (perTheme = new WeakMap()));
  let stages = perTheme.get(theme ?? GEOMETRY_ONLY);
  if (!stages) perTheme.set(theme ?? GEOMETRY_ONLY, (stages = new WeakMap()));
  const cached = stages.get(scene);
  if (cached) return cached;
  const boxes = layout(scene, theme);
  const links = linksFor(scene, boxes);
  const cache = drawnIn(theme);
  const objects = scene.objects.map((object): PlacedObject => {
    const def = definitionOf(object);
    const box = def.overlay ? OVERLAY_BOX : boxes.get(object.id)!;
    let local = def.overlay ? undefined : cache.get(object);
    if (!local) {
      local = def.draw(object.state, { objectId: object.id, links, theme });
      if (!def.overlay) cache.set(object, local);
    }
    const drawn = object.tint ? local.map((drawable) => tinted(drawable, object.tint!)) : local;
    const outlines = def.overlay ? [] : outlined(object, local, box, theme ?? THEMES.pattern);
    const caption = def.overlay ? null : captionDrawable(object, box.w / box.scale, inkTopOf(local, box, theme ?? THEMES.pattern));
    return { id: object.id, box, drawables: placeDrawables(object.id, [...drawn, ...outlines, ...(caption ? [caption] : [])], box) };
  });
  const stage = { objects, camera: cameraFor(scene, boxes) };
  stages.set(scene, stage);
  return stage;
}

export function ownDrawables(scene: SceneState, object: SceneObject): Drawable[] {
  const def = definitionOf(object);
  const links = def.overlay ? linksFor(scene, layoutScene(scene)) : {};
  return def.draw(object.state, { objectId: object.id, links });
}

const BOX_MOVE_THRESHOLD = 0.5;

export function movedObjects(before: Stage, after: Stage, beyond = BOX_MOVE_THRESHOLD): Set<string> {
  const earlier = new Map(before.objects.map((object) => [object.id, object.box]));
  return new Set(
    after.objects
      .filter((object) => {
        const was = earlier.get(object.id);
        return was !== undefined && (["x", "y", "w", "h", "scale"] as const).some((key) => Math.abs(was[key] - object.box[key]) > beyond);
      })
      .map((object) => object.id),
  );
}

export function arrivedObjects(before: Stage, after: Stage): Set<string> {
  const earlier = new Set(before.objects.map((object) => object.id));
  return new Set(after.objects.filter((object) => !earlier.has(object.id)).map((object) => object.id));
}

const GEOMETRY_KEYS = ["x", "y", "x2", "y2", "w", "h", "r"] as const;

export function reshapedDrawables(before: Stage, after: Stage): boolean {
  const earlier = new Map(before.objects.flatMap((object) => object.drawables.map((drawable) => [drawable.id, drawable] as const)));
  return after.objects.some((object) =>
    object.drawables.some((drawable) => {
      const was = earlier.get(drawable.id);
      return was !== undefined && (GEOMETRY_KEYS.some((key) => Math.abs((was[key] ?? 0) - (drawable[key] ?? 0)) > BOX_MOVE_THRESHOLD) || (was.points ?? []).some((value, index) => Math.abs(value - (drawable.points?.[index] ?? value)) > BOX_MOVE_THRESHOLD));
    }),
  );
}
