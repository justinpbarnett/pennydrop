import { gsap } from "gsap";
import { definitionOf, type SceneState } from "./scene";
import { type Camera, buildStage, HOME_CAMERA, arrivedObjects, movedObjects, type PlacedObject, placeDrawables, type Stage } from "./stage";
import { clamp01, type Drawable, duringLabOp, lerp, lerpRect, type Paint, PATH_KINDS, type Rect, WORD_KINDS } from "./lab";
import { parseHex, type Rgba, shownText, type Theme } from "./theme";
import { type SegmentProgress, type Timeline, trueProgress } from "./timeline";
import { applyEffect, type Touch } from "./verbs";
import type { Box } from "./layout";

export interface PaintedSpan {
  text: string;
  color: Rgba;
}

export type Painted = Omit<Drawable, "fill" | "stroke" | "spans"> & {
  spans?: PaintedSpan[];
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
};

export interface Frame {
  items: Painted[];
  camera: Camera;
  time: number;
}

const ENTER_RISE = 18;
const RELAYOUT_FADE_START = 0.6;

const easings = new Map<string, (progress: number) => number>();
export function easeFor(theme: Theme): (progress: number) => number {
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
    text: shownText(drawable, theme),
    spans: drawable.spans?.map((span) => ({ text: span.text, color: parseHex(theme.colors[span.role]) })),
    latex: drawable.latex,
    href: drawable.href,
    crop: drawable.crop,
    clip: drawable.clip,
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
  mixed[3] = clamp01(mixed[3]);
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

function mixCrop(before: Rect | undefined, after: Rect | undefined, progress: number): Rect | undefined {
  if (!before || !after) return after ?? before;
  return { x: lerp(before.x, after.x, progress), y: lerp(before.y, after.y, progress), w: lerp(before.w, after.w, progress), h: lerp(before.h, after.h, progress) };
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
    opacity: lerp(before.opacity, after.opacity, clamp01(progress)),
    z: lerp(before.z, after.z, progress),
    rotation: lerp(before.rotation, after.rotation, progress),
    draw: mixOptional(before.draw, after.draw, progress),
    crop: mixCrop(before.crop, after.crop, progress),
    clip: mixCrop(before.clip, after.clip, progress),
  };
  if (contentKey(before) === contentKey(after)) return [mixed];
  const clamped = clamp01(progress);
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
  return { ...lerpRect(from, to, progress), scale: lerp(from.scale, to.scale, progress) };
}

function boxOf(stage: Stage, objectId: string): Box | undefined {
  return stage.objects.find((object: PlacedObject) => object.id === objectId)?.box;
}

function arriving(item: Painted, eased: number): Painted {
  const progress = clamp01(eased);
  return { ...item, y: item.y + ENTER_RISE * (1 - progress), opacity: item.opacity * progress };
}

function applyTouches(
  items: Map<string, Painted>,
  touches: Touch[],
  stages: { before: Stage; after: Stage },
  progress: SegmentProgress,
  theme: Theme,
): void {
  const moving = movedObjects(stages.before, stages.after);
  const arrived = arrivedObjects(stages.before, stages.after);
  for (const touch of touches) {
    const box = lerpBox(boxOf(stages.before, touch.objectId), boxOf(stages.after, touch.objectId), moving.has(touch.objectId) ? progress.shift : progress.eased);
    if (touch.action.type === "effect") {
      const own = [...items.values()].filter((item) => objectOf(item.id) === touch.objectId);
      const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const moved = applyEffect(touch.action.effect, own, progress.eased, center);
      moved.forEach((item) => items.set(item.id, item));
    } else if (touch.action.type === "lab" && touch.before && touch.after) {
      const { name, parts, args, seconds, trueTime } = touch.action;
      const drive = trueTime ? trueProgress(progress, seconds) : progress.eased;
      const local = duringLabOp(definitionOf(touch.after), touch.before.state, touch.after.state, { name, parts, args }, drive, { objectId: touch.objectId, links: {} });
      placeDrawables(touch.objectId, local, box).forEach((drawable) => {
        const painted = paintDrawable(drawable, theme);
        items.set(drawable.id, arrived.has(touch.objectId) ? arriving(painted, progress.eased) : painted);
      });
    }
  }
}

export function renderFrame(timeline: Timeline, time: number, theme: Theme, stageOf: (scene: SceneState) => Stage = (scene) => buildStage(scene, undefined, theme)): Frame {
  const located = timeline.locate(time, theme.motionScale, easeFor(theme));
  const before = stageOf(located.before);
  const after = stageOf(located.after);
  const beforeItems = paintedStage(before, theme);
  const afterItems = paintedStage(after, theme);
  const replaced = new Set(located.replaced);
  const { progress } = located;
  const settled = progress.done || before === after;

  const items = new Map<string, Painted>();
  if (settled) {
    afterItems.forEach((item, id) => items.set(id, item));
  } else {
    const oldObjects = new Set(before.objects.map((object) => object.id));
    const moved = movedObjects(before, after);
    const clamped = clamp01(progress.eased);
    afterItems.forEach((item, id) => {
      const previous = beforeItems.get(id);
      const owner = objectOf(id);
      if (replaced.has(owner)) {
        items.set(id, { ...item, opacity: item.opacity * clamped });
      } else if (previous) {
        blend(previous, item, progress.shift).forEach((blended) => items.set(blended.id, blended));
      } else if (moved.has(owner)) {
        items.set(id, { ...item, opacity: item.opacity * clamp01((clamp01(progress.shift) - RELAYOUT_FADE_START) / (1 - RELAYOUT_FADE_START)) });
      } else {
        items.set(id, oldObjects.has(owner) ? { ...item, opacity: item.opacity * clamped } : arriving(item, progress.eased));
      }
    });
    beforeItems.forEach((item, id) => {
      if (replaced.has(objectOf(id))) items.set(`${id}~replaced`, { ...item, id: `${id}~replaced`, opacity: item.opacity * (1 - progress.exit) });
      else if (!afterItems.has(id)) items.set(id, { ...item, opacity: item.opacity * (1 - progress.exit) });
    });
    applyTouches(items, located.touches, { before, after }, progress, theme);
  }

  const camera = settled ? after.camera : {
    cx: lerp(before.camera.cx, after.camera.cx, progress.eased),
    cy: lerp(before.camera.cy, after.camera.cy, progress.eased),
    zoom: lerp(before.camera.zoom, after.camera.zoom, progress.eased),
  };
  const painted = timeline.startScene.reading === false ? [...items.values()].filter((item) => !WORD_KINDS.includes(item.kind)) : [...items.values()];
  const ordered = painted.map((item, order) => ({ item, order })).sort((a, b) => a.item.z - b.item.z || a.order - b.order);
  return { items: ordered.map((entry) => entry.item), camera: camera ?? HOME_CAMERA, time };
}
