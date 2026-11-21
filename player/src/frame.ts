import { gsap } from "gsap";
import { definitionOf } from "./scene";
import { type Camera, buildStage, HOME_CAMERA, type PlacedObject, placeDrawables, type Stage } from "./stage";
import type { Drawable, DrawableKind, Paint } from "./lab";
import { lerp } from "./lab";
import { parseHex, type Rgba, type Theme } from "./theme";
import type { Timeline } from "./timeline";
import { applyEffect, type Touch } from "./verbs";
import type { Box } from "./layout";

export interface PaintedSpan {
  text: string;
  color: Rgba;
}

export interface Painted {
  id: string;
  kind: DrawableKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  x2?: number;
  y2?: number;
  points?: number[];
  closed?: boolean;
  text?: string;
  spans?: PaintedSpan[];
  latex?: string;
  href?: string;
  size: number;
  fontFamily: string;
  fontWeight: number;
  tracking: number;
  anchor: "start" | "middle" | "end";
  fill: Rgba | null;
  stroke: Rgba | null;
  strokeWidth: number;
  radius: number;
  opacity: number;
  z: number;
  rotation: number;
  draw?: number;
  part?: string;
}

export interface Frame {
  items: Painted[];
  camera: Camera;
  time: number;
}

const PATH_KINDS: DrawableKind[] = ["line", "arrow", "path"];
const WORD_KINDS: DrawableKind[] = ["text", "code", "math"];
const ENTER_RISE = 18;

const easings = new Map<string, (progress: number) => number>();
function easeFor(theme: Theme): (progress: number) => number {
  let ease = easings.get(theme.ease);
  if (!ease) {
    ease = gsap.parseEase(theme.ease) as (progress: number) => number;
    easings.set(theme.ease, ease);
  }
  return ease;
}

function paintOf(paint: Paint | undefined, theme: Theme): Rgba | null {
  return paint === undefined || paint === "none" ? null : parseHex(theme.colors[paint]);
}

function paintDrawable(drawable: Drawable, theme: Theme): Painted {
  const font = theme.fonts[drawable.font ?? "read"];
  const caps = drawable.font === "mark" && theme.capitalMarks;
  return {
    id: drawable.id,
    kind: drawable.kind,
    x: drawable.x,
    y: drawable.y,
    w: drawable.w,
    h: drawable.h,
    r: drawable.r,
    x2: drawable.x2,
    y2: drawable.y2,
    points: drawable.points,
    closed: drawable.closed,
    text: caps ? drawable.text?.toUpperCase() : drawable.text,
    spans: drawable.spans?.map((span) => ({ text: span.text, color: parseHex(theme.colors[span.role]) })),
    latex: drawable.latex,
    href: drawable.href,
    size: drawable.size ?? 28,
    fontFamily: font.family,
    fontWeight: font.weight,
    tracking: font.tracking,
    anchor: drawable.anchor ?? "middle",
    fill: paintOf(drawable.fill, theme),
    stroke: paintOf(drawable.stroke, theme),
    strokeWidth: (drawable.strokeWidth ?? 0) * theme.stroke,
    radius: (drawable.radius ?? 0) * theme.corner,
    opacity: drawable.opacity ?? 1,
    z: drawable.z ?? 0,
    rotation: drawable.rotation ?? 0,
    draw: drawable.draw ?? (PATH_KINDS.includes(drawable.kind) ? 1 : undefined),
    part: drawable.part,
  };
}

const paintedStages = new WeakMap<Theme, WeakMap<Stage, Map<string, Painted>>>();
function paintedStage(stage: Stage, theme: Theme): Map<string, Painted> {
  let perTheme = paintedStages.get(theme);
  if (!perTheme) paintedStages.set(theme, (perTheme = new WeakMap()));
  let painted = perTheme.get(stage);
  if (!painted) {
    painted = new Map(stage.objects.flatMap((object) => object.drawables.map((drawable) => [drawable.id, paintDrawable(drawable, theme)] as const)));
    perTheme.set(stage, painted);
  }
  return painted;
}

function mixPaint(before: Rgba | null, after: Rgba | null, progress: number): Rgba | null {
  if (!before && !after) return null;
  const from = before ?? [...after!.slice(0, 3), 0] as Rgba;
  const to = after ?? [...before!.slice(0, 3), 0] as Rgba;
  const mixed = from.map((channel, index) => lerp(channel, to[index]!, progress)) as Rgba;
  mixed[3] = Math.min(1, Math.max(0, mixed[3]));
  return mixed;
}

function mixOptional(before: number | undefined, after: number | undefined, progress: number): number | undefined {
  if (before === undefined) return after;
  if (after === undefined) return before;
  return lerp(before, after, progress);
}

function resample(points: number[], count: number): number[] {
  const pairs = points.length / 2;
  if (pairs === count) return points;
  const result: number[] = [];
  for (let index = 0; index < count; index++) {
    const position = (index / (count - 1)) * (pairs - 1);
    const low = Math.floor(position);
    const high = Math.min(pairs - 1, low + 1);
    const fraction = position - low;
    result.push(lerp(points[low * 2]!, points[high * 2]!, fraction), lerp(points[low * 2 + 1]!, points[high * 2 + 1]!, fraction));
  }
  return result;
}

function mixPoints(before: number[] | undefined, after: number[] | undefined, progress: number): number[] | undefined {
  if (!before || !after) return after ?? before;
  const count = Math.max(before.length, after.length) / 2;
  const from = resample(before, count);
  const to = resample(after, count);
  return from.map((value, index) => lerp(value, to[index]!, progress));
}

function contentKey(item: Painted): string {
  return `${item.kind}|${item.text ?? ""}|${item.latex ?? ""}|${item.href ?? ""}|${item.spans?.map((span) => span.text).join("") ?? ""}`;
}

function blend(before: Painted, after: Painted, progress: number): Painted[] {
  const mixed: Painted = {
    ...after,
    x: lerp(before.x, after.x, progress),
    y: lerp(before.y, after.y, progress),
    w: mixOptional(before.w, after.w, progress),
    h: mixOptional(before.h, after.h, progress),
    r: mixOptional(before.r, after.r, progress),
    x2: mixOptional(before.x2, after.x2, progress),
    y2: mixOptional(before.y2, after.y2, progress),
    points: mixPoints(before.points, after.points, progress),
    size: lerp(before.size, after.size, progress),
    fill: mixPaint(before.fill, after.fill, progress),
    stroke: mixPaint(before.stroke, after.stroke, progress),
    strokeWidth: lerp(before.strokeWidth, after.strokeWidth, progress),
    radius: lerp(before.radius, after.radius, progress),
    opacity: lerp(before.opacity, after.opacity, Math.min(1, Math.max(0, progress))),
    z: lerp(before.z, after.z, progress),
    rotation: lerp(before.rotation, after.rotation, progress),
    draw: mixOptional(before.draw, after.draw, progress),
  };
  if (contentKey(before) === contentKey(after)) return [mixed];
  const clamped = Math.min(1, Math.max(0, progress));
  return [
    { ...mixed, kind: before.kind, text: before.text, spans: before.spans, latex: before.latex, href: before.href, id: `${before.id}~out`, opacity: before.opacity * Math.max(0, 1 - clamped * 2) },
    { ...mixed, opacity: after.opacity * Math.max(0, clamped * 2 - 1) },
  ];
}

function objectOf(id: string): string {
  return id.slice(0, id.indexOf("/"));
}

function lerpBox(before: Box | undefined, after: Box | undefined, progress: number): Box {
  const from = before ?? after!;
  const to = after ?? before!;
  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    w: lerp(from.w, to.w, progress),
    h: lerp(from.h, to.h, progress),
    scale: lerp(from.scale, to.scale, progress),
  };
}

function boxOf(stage: Stage, objectId: string): Box | undefined {
  return stage.objects.find((object: PlacedObject) => object.id === objectId)?.box;
}

function applyTouches(
  items: Map<string, Painted>,
  touches: Touch[],
  stages: { before: Stage; after: Stage },
  progress: number,
  theme: Theme,
): void {
  for (const touch of touches) {
    const box = lerpBox(boxOf(stages.before, touch.objectId), boxOf(stages.after, touch.objectId), progress);
    if (touch.action.type === "effect") {
      const own = [...items.values()].filter((item) => objectOf(item.id) === touch.objectId);
      const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const moved = applyEffect(touch.action.effect, own, progress, center);
      moved.forEach((item) => items.set(item.id, item));
    } else if (touch.action.type === "lab" && touch.before && touch.after) {
      const def = definitionOf(touch.after);
      if (!def.during) continue;
      const labOp = { name: touch.action.name, parts: touch.action.parts, args: touch.action.args };
      const local = def.during(touch.before.state, touch.after.state, labOp, progress, { objectId: touch.objectId, links: {} });
      placeDrawables(touch.objectId, local, box).forEach((drawable) => items.set(drawable.id, paintDrawable(drawable, theme)));
    }
  }
}

export function renderFrame(timeline: Timeline, time: number, theme: Theme): Frame {
  const located = timeline.locate(time, theme.motionScale);
  const before = buildStage(located.before);
  const after = buildStage(located.after);
  const progress = located.progress >= 1 ? 1 : easeFor(theme)(located.progress);
  const beforeItems = paintedStage(before, theme);
  const afterItems = paintedStage(after, theme);

  const items = new Map<string, Painted>();
  if (before === after || progress >= 1) {
    afterItems.forEach((item, id) => items.set(id, item));
  } else {
    const oldObjects = new Set(before.objects.map((object) => object.id));
    const clamped = Math.min(1, Math.max(0, progress));
    afterItems.forEach((item, id) => {
      const previous = beforeItems.get(id);
      if (previous) {
        blend(previous, item, progress).forEach((blended) => items.set(blended.id, blended));
      } else {
        const rise = oldObjects.has(objectOf(id)) ? 0 : ENTER_RISE * (1 - clamped);
        items.set(id, { ...item, y: item.y + rise, opacity: item.opacity * clamped });
      }
    });
    beforeItems.forEach((item, id) => {
      if (!afterItems.has(id)) items.set(id, { ...item, opacity: item.opacity * (1 - clamped) });
    });
    applyTouches(items, located.touches, { before, after }, progress, theme);
  }

  const camera = before === after || progress >= 1 ? after.camera : {
    cx: lerp(before.camera.cx, after.camera.cx, progress),
    cy: lerp(before.camera.cy, after.camera.cy, progress),
    zoom: lerp(before.camera.zoom, after.camera.zoom, progress),
  };
  const painted = timeline.startScene.reading === false ? [...items.values()].filter((item) => !WORD_KINDS.includes(item.kind)) : [...items.values()];
  const ordered = painted.map((item, order) => ({ item, order })).sort((a, b) => a.item.z - b.item.z || a.order - b.order);
  return { items: ordered.map((entry) => entry.item), camera: camera ?? HOME_CAMERA, time };
}
