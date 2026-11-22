import type { Drawable, Link, Paint, Role } from "./lab";
import { type Box, type Layout, layoutScene, STAGE } from "./layout";
import { definitionOf, type SceneObject, type SceneState } from "./scene";
import type { Theme } from "./theme";

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
    if (drawable.points) placed.points = drawable.points.map((value, index) => (index % 2 === 0 ? box.x : box.y) + value * s);
    return placed;
  });
}

function tinted(drawable: Drawable, role: Role): Drawable {
  const recolor = (paint: Paint | undefined) => (paint === undefined || KEEP_ROLES.includes(paint) ? paint : role);
  return {
    ...drawable,
    fill: recolor(drawable.fill),
    stroke: recolor(drawable.stroke),
    spans: drawable.spans?.map((span) => ({ ...span, role: KEEP_ROLES.includes(span.role) ? span.role : role })),
  };
}

type Bounds = [number, number, number, number];

function highlightOutline(role: Role, [left, top, right, bottom]: Bounds, pad: number): Drawable {
  return {
    id: "_highlight",
    kind: "rect",
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    w: right - left + 2 * pad,
    h: bottom - top + 2 * pad,
    fill: "none",
    stroke: role,
    strokeWidth: 1.6,
    radius: 1,
    z: -1,
  };
}

function outlined(object: SceneObject, local: Drawable[], box: Box): Drawable | null {
  if (!object.highlight) return null;
  const whole: Bounds = [0, 0, box.w / box.scale, box.h / box.scale];
  if (!object.highlightParts) return highlightOutline(object.highlight, whole, 14);
  const parts = local.filter((drawable) => drawable.part !== undefined && object.highlightParts!.includes(drawable.part)).map(shapeBounds).filter((bounds) => bounds !== null);
  if (parts.length === 0) return highlightOutline(object.highlight, whole, 14);
  const union: Bounds = [Math.min(...parts.map((bounds) => bounds[0])), Math.min(...parts.map((bounds) => bounds[1])), Math.max(...parts.map((bounds) => bounds[2])), Math.max(...parts.map((bounds) => bounds[3]))];
  return highlightOutline(object.highlight, union, 8);
}

function shapeBounds(drawable: Drawable): Bounds | null {
  if (drawable.kind === "rect" && drawable.w !== undefined && drawable.h !== undefined) return [drawable.x - drawable.w / 2, drawable.y - drawable.h / 2, drawable.x + drawable.w / 2, drawable.y + drawable.h / 2];
  if (drawable.kind === "circle" && drawable.r !== undefined) return [drawable.x - drawable.r, drawable.y - drawable.r, drawable.x + drawable.r, drawable.y + drawable.r];
  return null;
}

const localDrawables = new WeakMap<SceneObject, Drawable[]>();
type LayoutOf = (scene: SceneState, theme?: Theme) => Layout;
const GEOMETRY_ONLY: object = {};
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
  const objects = scene.objects.map((object): PlacedObject => {
    const def = definitionOf(object);
    const box = def.overlay ? OVERLAY_BOX : boxes.get(object.id)!;
    let local = def.overlay ? undefined : localDrawables.get(object);
    if (!local) {
      local = def.draw(object.state, { objectId: object.id, links });
      if (!def.overlay) localDrawables.set(object, local);
    }
    const drawn = object.tint ? local.map((drawable) => tinted(drawable, object.tint!)) : local;
    const outline = def.overlay ? null : outlined(object, local, box);
    const withOutline = outline ? [...drawn, outline] : drawn;
    return { id: object.id, box, drawables: placeDrawables(object.id, withOutline, box) };
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
