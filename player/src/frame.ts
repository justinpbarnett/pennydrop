import { gsap } from "gsap";
import { definitionOf, type SceneState } from "./scene";
import { type Camera, buildStage, HOME_CAMERA, arrivedObjects, movedObjects, type PlacedObject, placeDrawables, type Stage } from "./stage";
import { clamp01, type Drawable, duringLabOp, lerp, lerpRect, liveLabDrawing, type Paint, PATH_KINDS, type Rect, type Running, WORD_KINDS } from "./lab";
import { colorOf, parseHex, type Rgba, shownText, type Theme } from "./theme";
import { type Carried, type Located, type SegmentProgress, type Timeline, trueProgress } from "./timeline";
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
  return paint === undefined || paint === "none" ? null : parseHex(colorOf(theme, paint));
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
    soft: drawable.soft,
    d: drawable.d,
    mirror: drawable.mirror,
    text: shownText(drawable, theme),
    spans: drawable.spans?.map((span) => ({ text: span.text, color: parseHex(colorOf(theme, span.role)) })),
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
    layer: drawable.layer,
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
  return `${item.kind}|${item.text ?? ""}|${item.latex ?? ""}|${item.href ?? ""}|${item.d ?? ""}|${item.spans?.map((span) => span.text).join("") ?? ""}`;
}

const FADING_OUT = "~out";
const REPLACED = "~replaced";

function faded(item: Painted, amount: number): Painted {
  return item.layer ? { ...item, layer: { ...item.layer, opacity: item.layer.opacity * amount } } : { ...item, opacity: item.opacity * amount };
}

function renamed(item: Painted, suffix: string): Painted {
  return { ...item, id: `${item.id}${suffix}`, layer: item.layer && { ...item.layer, id: `${item.layer.id}${suffix}` } };
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
    layer: after.layer && { ...after.layer, opacity: lerp(before.layer?.opacity ?? 1, after.layer.opacity, clamp01(progress)) },
  };
  if (contentKey(before) === contentKey(after)) return [mixed];
  const clamped = clamp01(progress);
  return [
    faded(renamed({ ...mixed, kind: before.kind, text: before.text, spans: before.spans, latex: before.latex, href: before.href, d: before.d, mirror: before.mirror, opacity: before.opacity, layer: before.layer }, FADING_OUT), Math.max(0, 1 - clamped * 2)),
    faded({ ...mixed, opacity: after.opacity, layer: after.layer }, Math.max(0, clamped * 2 - 1)),
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
  return { ...faded(item, progress), y: item.y + ENTER_RISE * (1 - progress) };
}

interface Moment {
  stages: { before: Stage; after: Stage };
  progress: SegmentProgress;
  theme: Theme;
  replaced: Set<string>;
  clock: number;
}

function momentBox(moment: Moment, objectId: string): Box | undefined {
  const { before, after } = moment.stages;
  const from = boxOf(before, objectId);
  const to = boxOf(after, objectId);
  if (!from && !to) return undefined;
  return lerpBox(from, to, movedObjects(before, after).has(objectId) ? moment.progress.shift : moment.progress.eased);
}

function entering(moment: Moment, objectId: string, painted: Painted): Painted {
  if (arrivedObjects(moment.stages.before, moment.stages.after).has(objectId)) return arriving(painted, moment.progress.eased);
  return moment.replaced.has(objectId) ? faded(painted, clamp01(moment.progress.eased)) : painted;
}

function drive(touch: Touch, progress: SegmentProgress): number {
  return touch.action.type === "lab" && touch.action.trueTime ? trueProgress(progress, touch.action.seconds) : progress.eased;
}

function applyTouches(items: Map<string, Painted>, touches: Touch[], moment: Moment): void {
  for (const touch of touches) {
    const box = momentBox(moment, touch.objectId)!;
    if (touch.action.type === "effect") {
      const own = [...items.values()].filter((item) => objectOf(item.id) === touch.objectId);
      const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const moved = applyEffect(touch.action.effect, own, moment.progress.eased, center);
      moved.forEach((item) => items.set(item.id, item));
    } else if (touch.action.type === "lab" && touch.before && touch.after && !definitionOf(touch.after).live) {
      const { name, parts, args } = touch.action;
      const local = duringLabOp(definitionOf(touch.after), touch.before.state, touch.after.state, { name, parts, args }, drive(touch, moment.progress), { objectId: touch.objectId, links: {} });
      placeDrawables(touch.objectId, local, box).forEach((drawable) => {
        items.set(drawable.id, entering(moment, touch.objectId, paintDrawable(drawable, moment.theme)));
        items.delete(`${drawable.id}${FADING_OUT}`);
      });
    }
  }
}

function runningOn(objectId: string, touches: Touch[], carried: Carried[], moment: Moment): Running[] {
  const runs = [
    ...touches.map((touch) => ({ touch, progress: drive(touch, moment.progress) })),
    ...carried.map((run) => ({ touch: run.touch, progress: (moment.clock - run.start) / (run.end - run.start) })),
  ];
  return runs.flatMap(({ touch, progress }) => {
    if (touch.objectId !== objectId || touch.action.type !== "lab" || !touch.before || !touch.after) return [];
    const { name, parts, args } = touch.action;
    return [{ op: { name, parts, args }, before: touch.before.state, after: touch.after.state, progress }];
  });
}

function paintLive(items: Map<string, Painted>, scene: SceneState, touches: Touch[], carried: Carried[], moment: Moment): void {
  for (const object of scene.objects) {
    const box = momentBox(moment, object.id);
    const local = box && liveLabDrawing(definitionOf(object), object.state, runningOn(object.id, touches, carried, moment), { objectId: object.id, links: {}, clock: moment.clock });
    if (!local) continue;
    for (const id of [...items.keys()]) if (objectOf(id) === object.id && !id.endsWith(REPLACED)) items.delete(id);
    placeDrawables(object.id, local, box).forEach((drawable) => items.set(drawable.id, entering(moment, object.id, paintDrawable(drawable, moment.theme))));
  }
}

const roomStages = new WeakMap<Stage, WeakMap<Stage, Stage>>();

const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;

function roomBox(was: PlacedObject, will: PlacedObject): Box {
  const scale = will.box.scale;
  const size = { w: (was.box.w / was.box.scale) * scale, h: (was.box.h / was.box.scale) * scale };
  const landing = new Map(will.drawables.map((drawable) => [drawable.id, drawable]));
  const shared = was.drawables.filter((drawable) => landing.has(drawable.id));
  if (shared.length === 0) return { ...size, x: will.box.x + (will.box.w - size.w) / 2, y: will.box.y + (will.box.h - size.h) / 2, scale };
  const offset = (axis: "x" | "y") => mean(shared.map((drawable) => landing.get(drawable.id)![axis] - ((drawable[axis] - was.box[axis]) / was.box.scale) * scale));
  return { ...size, x: offset("x"), y: offset("y"), scale };
}

function roomStage(before: SceneState, beforeStage: Stage, after: Stage, replaced: Set<string>): Stage {
  let perAfter = roomStages.get(after);
  if (!perAfter) roomStages.set(after, (perAfter = new WeakMap()));
  let room = perAfter.get(beforeStage);
  if (!room) {
    const earlier = new Map(beforeStage.objects.map((object) => [object.id, object]));
    const boxes = new Map(after.objects.flatMap((object) => (earlier.has(object.id) ? [[object.id, roomBox(earlier.get(object.id)!, object)] as const] : [])));
    const kept = new Set(after.objects.flatMap((object) => object.drawables.map((drawable) => drawable.id)));
    const staying = buildStage({ ...before, objects: before.objects.filter((object) => boxes.has(object.id) && !replaced.has(object.id)) }, () => boxes);
    room = { ...staying, objects: staying.objects.map((object) => ({ ...object, drawables: object.drawables.filter((drawable) => kept.has(drawable.id)) })) };
    perAfter.set(beforeStage, room);
  }
  return room;
}

function relayoutPhase(located: Located, staged: { before: Stage; after: Stage }): { before: Stage; after: Stage; progress: SegmentProgress; touches: Touch[]; replaced: Set<string> } {
  const replaced = new Set(located.replaced);
  const room = roomStage(located.before, staged.before, staged.after, replaced);
  const { progress } = located;
  if (progress.shift < 1) return { before: staged.before, after: room, progress: { ...progress, eased: 0 }, touches: [], replaced: new Set() };
  return { before: room, after: staged.after, progress: { ...progress, shift: progress.eased, exit: 1 }, touches: located.touches, replaced };
}

export function renderFrame(timeline: Timeline, time: number, theme: Theme, stageOf: (scene: SceneState) => Stage = (scene) => buildStage(scene, undefined, theme)): Frame {
  const located = timeline.locate(time, theme.motionScale, easeFor(theme));
  const staged = { before: stageOf(located.before), after: stageOf(located.after) };
  const settled = located.progress.done || staged.before === staged.after;
  const { before, after, progress, touches, replaced } = settled || !located.relayout ? { ...staged, progress: located.progress, touches: located.touches, replaced: new Set(located.replaced) } : relayoutPhase(located, staged);

  const items = new Map<string, Painted>();
  const moment: Moment = { stages: settled ? { before: after, after } : { before, after }, progress, theme, replaced: settled ? new Set() : replaced, clock: time };
  if (settled) {
    paintedStage(after, theme).forEach((item, id) => items.set(id, item));
    paintLive(items, located.after, [], located.carried, moment);
  } else {
    const beforeItems = paintedStage(before, theme);
    const afterItems = paintedStage(after, theme);
    const oldObjects = new Set(before.objects.map((object) => object.id));
    const moved = movedObjects(before, after);
    const clamped = clamp01(progress.eased);
    afterItems.forEach((item, id) => {
      const previous = beforeItems.get(id);
      const owner = objectOf(id);
      if (replaced.has(owner)) {
        items.set(id, faded(item, clamped));
      } else if (previous) {
        blend(previous, item, progress.shift).forEach((blended) => items.set(blended.id, blended));
      } else if (moved.has(owner)) {
        items.set(id, faded(item, clamp01((clamp01(progress.shift) - RELAYOUT_FADE_START) / (1 - RELAYOUT_FADE_START))));
      } else {
        items.set(id, oldObjects.has(owner) ? faded(item, clamped) : arriving(item, progress.eased));
      }
    });
    beforeItems.forEach((item, id) => {
      if (replaced.has(objectOf(id))) items.set(`${id}${REPLACED}`, faded(renamed(item, REPLACED), 1 - progress.exit));
      else if (!afterItems.has(id)) items.set(id, faded(item, 1 - progress.exit));
    });
    applyTouches(items, touches, moment);
    paintLive(items, located.after, located.touches, located.carried, moment);
  }

  const camera = settled ? after.camera : {
    cx: lerp(before.camera.cx, after.camera.cx, progress.shift),
    cy: lerp(before.camera.cy, after.camera.cy, progress.shift),
    zoom: lerp(before.camera.zoom, after.camera.zoom, progress.shift),
  };
  const painted = timeline.startScene.reading === false ? [...items.values()].filter((item) => !WORD_KINDS.includes(item.kind)) : [...items.values()];
  const ordered = painted.map((item, order) => ({ item, order })).sort((a, b) => a.item.z - b.item.z || a.order - b.order);
  return { items: ordered.map((entry) => entry.item), camera: camera ?? HOME_CAMERA, time };
}
