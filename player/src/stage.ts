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

function highlightOutline(role: Role, size: { w: number; h: number }): Drawable {
  const pad = 14;
  return {
    id: "_highlight",
    kind: "rect",
    x: size.w / 2,
    y: size.h / 2,
    w: size.w + 2 * pad,
    h: size.h + 2 * pad,
    fill: "none",
    stroke: role,
    strokeWidth: 1.6,
    radius: 1,
    z: -1,
  };
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
    const withOutline = object.highlight && !def.overlay ? [...drawn, highlightOutline(object.highlight, { w: box.w / box.scale, h: box.h / box.scale })] : drawn;
    return { id: object.id, box, drawables: placeDrawables(object.id, withOutline, box) };
  });
  const stage = { objects, camera: cameraFor(scene, boxes) };
  stages.set(scene, stage);
  return stage;
}
