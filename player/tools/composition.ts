import { prepareStepAssets } from "../src/assets";
import type { LessonSource } from "../src/format";
import type { Drawable } from "../src/lab";
import { layoutScene } from "../src/layout";
import { definitionOf, startSceneOf } from "../src/scene";
import { ARROW_HEAD_ANGLE, arrowHeadLength, turned } from "../src/ink";
import { textWidth } from "../src/text-metrics";
import { THEMES } from "../src/theme";
import { Timeline } from "../src/timeline";

const MAX_GAP_SHARE = 0.15;
const MAX_MARGIN_RATIO = 2;
const CLEARANCE = 12;
const MAX_REPORTED = 3;
const MIN_SHAFT_HEADS = 1.5;
const MIN_TEXT_PX = 20;
const ON_EDGE = 0.5;
const WIDEST_STROKE = Math.max(...Object.values(THEMES).map((theme) => theme.stroke));

export interface Finding {
  stage: string;
  message: string;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Point {
  x: number;
  y: number;
}

export function boxOf(drawable: Drawable): Box | null {
  const { x, y } = drawable;
  switch (drawable.kind) {
    case "rect":
    case "image":
    case "code":
    case "math":
      return drawable.w === undefined || drawable.h === undefined ? null : { minX: x - drawable.w / 2, maxX: x + drawable.w / 2, minY: y - drawable.h / 2, maxY: y + drawable.h / 2 };
    case "circle": {
      const r = drawable.r ?? 0;
      return { minX: x - r, maxX: x + r, minY: y - r, maxY: y + r };
    }
    case "line":
    case "arrow":
      return { minX: Math.min(x, drawable.x2 ?? x), maxX: Math.max(x, drawable.x2 ?? x), minY: Math.min(y, drawable.y2 ?? y), maxY: Math.max(y, drawable.y2 ?? y) };
    case "path": {
      const points = drawable.points ?? [];
      const xs = points.filter((_, position) => position % 2 === 0);
      const ys = points.filter((_, position) => position % 2 === 1);
      return xs.length ? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } : null;
    }
    case "text": {
      const size = drawable.size ?? 28;
      const width = textWidth(drawable.text ?? "", size, drawable.font ?? "read");
      const left = drawable.anchor === "start" ? x : drawable.anchor === "end" ? x - width : x - width / 2;
      return { minX: left, maxX: left + width, minY: y - size / 2, maxY: y + size / 2 };
    }
  }
}

function turnedShape(drawable: Drawable): Drawable {
  if (!drawable.rotation || drawable.kind === "circle" || drawable.kind === "text") return drawable;
  if (drawable.kind === "line" || drawable.kind === "arrow") {
    const [x2, y2] = turned(drawable, [drawable.x2 ?? drawable.x, drawable.y2 ?? drawable.y]);
    return { ...drawable, x2, y2, rotation: 0 };
  }
  const box = boxOf({ ...drawable, rotation: 0 });
  const unturned = drawable.kind === "rect" && box ? [box.minX, box.minY, box.maxX, box.minY, box.maxX, box.maxY, box.minX, box.maxY] : drawable.points ?? [];
  return { ...drawable, kind: "path", closed: drawable.kind === "rect" || drawable.closed, points: turned(drawable, unturned), rotation: 0 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function boxGap(a: Box, b: Box): number {
  return Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));
}

function corners(box: Box): Point[] {
  return [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
}

function pointToBox(point: Point, box: Box): number {
  return Math.hypot(Math.max(0, box.minX - point.x, point.x - box.maxX), Math.max(0, box.minY - point.y, point.y - box.maxY));
}

function pointToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const along = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length));
  return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy));
}

function segmentCrossesBox(from: Point, to: Point, box: Box): boolean {
  let entry = 0;
  let exit = 1;
  for (const [delta, start, low, high] of [[to.x - from.x, from.x, box.minX, box.maxX], [to.y - from.y, from.y, box.minY, box.maxY]] as const) {
    if (delta === 0) {
      if (start < low || start > high) return false;
      continue;
    }
    const near = (low - start) / delta;
    const far = (high - start) / delta;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
  }
  return entry <= exit;
}

function segmentToBox(from: Point, to: Point, box: Box): number {
  if (segmentCrossesBox(from, to, box)) return 0;
  return Math.min(pointToBox(from, box), pointToBox(to, box), ...corners(box).map((corner) => pointToSegment(corner, from, to)));
}

function inside(box: Box, outer: Box): boolean {
  return box.minX >= outer.minX && box.maxX <= outer.maxX && box.minY >= outer.minY && box.maxY <= outer.maxY;
}

function insidePolygon(point: Point, polygon: Point[]): boolean {
  let result = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

function pointsOf(drawable: Drawable): Point[] {
  const flat = drawable.points ?? [];
  return Array.from({ length: Math.floor(flat.length / 2) }, (_, index) => ({ x: flat[index * 2]!, y: flat[index * 2 + 1]! }));
}

function clearance(text: Box, shape: Drawable): number | null {
  const box = boxOf(shape);
  if (!box) return null;
  switch (shape.kind) {
    case "rect":
      if (inside(text, box)) return null;
      return overlaps(text, box) ? 0 : boxGap(text, box);
    case "circle": {
      const center = { x: shape.x, y: shape.y };
      const r = shape.r ?? 0;
      const nearest = pointToBox(center, text);
      const farthest = Math.max(...corners(text).map((corner) => Math.hypot(corner.x - center.x, corner.y - center.y)));
      if (farthest <= r) return null;
      return nearest > r ? nearest - r : 0;
    }
    case "line":
      return segmentToBox({ x: shape.x, y: shape.y }, { x: shape.x2 ?? shape.x, y: shape.y2 ?? shape.y }, text);
    case "arrow": {
      const [from, to] = [{ x: shape.x, y: shape.y }, { x: shape.x2 ?? shape.x, y: shape.y2 ?? shape.y }];
      const head = arrowHeadLength((shape.strokeWidth ?? 0) * WIDEST_STROKE);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const wings = [ARROW_HEAD_ANGLE, -ARROW_HEAD_ANGLE].map((offset) => ({ x: to.x - head * Math.cos(angle + offset), y: to.y - head * Math.sin(angle + offset) }));
      return Math.min(segmentToBox(from, to, text), ...wings.map((wing) => segmentToBox(wing, to, text)));
    }
    case "path": {
      const points = pointsOf(shape);
      if (shape.closed && corners(text).every((corner) => insidePolygon(corner, points))) return null;
      const edges = points.slice(1).map((point, index) => [points[index]!, point] as const);
      if (shape.closed && points.length > 2) edges.push([points[points.length - 1]!, points[0]!]);
      return edges.length ? Math.min(...edges.map(([from, to]) => segmentToBox(from, to, text))) : null;
    }
    default:
      return null;
  }
}

function encloses(outline: Drawable, inner: Drawable): boolean {
  if (outline === inner) return false;
  const [outer, within] = [boxOf(outline), boxOf(inner)];
  if (!outer || !within) return false;
  if (outline.kind === "rect") return inside(within, { minX: outer.minX - ON_EDGE, maxX: outer.maxX + ON_EDGE, minY: outer.minY - ON_EDGE, maxY: outer.maxY + ON_EDGE });
  if (outline.kind !== "path" || !outline.closed) return false;
  const polygon = pointsOf(outline);
  return corners(within).every((corner) => insidePolygon(corner, polygon) || polygon.some((point, index) => pointToSegment(corner, point, polygon[(index + 1) % polygon.length]!) <= ON_EDGE));
}

function mergedGaps(spans: [number, number][]): { from: number; to: number }[] {
  const ordered = [...spans].sort((a, b) => a[0] - b[0]);
  const gaps: { from: number; to: number }[] = [];
  let reach = ordered[0]![1];
  for (const [low, high] of ordered.slice(1)) {
    if (low > reach) gaps.push({ from: reach, to: low });
    reach = Math.max(reach, high);
  }
  return gaps;
}

function describe(drawable: Drawable): string {
  return drawable.text !== undefined ? `${drawable.id} "${drawable.text}"` : drawable.id;
}

function limited(lines: string[]): string[] {
  return lines.length <= MAX_REPORTED ? lines : [...lines.slice(0, MAX_REPORTED), `and ${lines.length - MAX_REPORTED} more like it`];
}

export async function compositionFindings(lesson: LessonSource, wants: (defKey: string) => boolean, label = ""): Promise<Finding[]> {
  const timeline = new Timeline(startSceneOf(lesson.lesson));
  const findings: Finding[] = [];
  const add = (step: number, object: string, message: string) => findings.push({ stage: "composition", message: `${label}step ${step}: ${object}: ${message}` });
  await prepareStepAssets(lesson.lesson);
  for (const step of lesson.steps) {
    await prepareStepAssets(step);
    const span = timeline.addStep(step);
    if (span.errors?.length) add(step.step, "scene", `the Step did not play, so its Labs were not checked: ${span.errors[0]}`);
    const placed = layoutScene(timeline.finalScene);
    for (const object of timeline.finalScene.objects.filter((candidate) => wants(candidate.defKey))) {
      const definition = definitionOf(object);
      const size = definition.size(object.state);
      const drawables = definition.draw(object.state, { objectId: object.id, links: {} }).filter((drawable) => drawable.opacity !== 0).map(turnedShape);
      const boxes = drawables.map(boxOf).filter((box): box is Box => box !== null);
      if (boxes.length === 0) continue;
      const projections: [string, number, [number, number][]][] = [
        ["x", size.w, boxes.map((box) => [box.minX, box.maxX])],
        ["y", size.h, boxes.map((box) => [box.minY, box.maxY])],
      ];
      for (const [axis, length, spans] of projections) {
        for (const gap of mergedGaps(spans).filter(({ from, to }) => to - from > length * MAX_GAP_SHARE)) {
          add(step.step, object.id, `empty band on ${axis}: nothing is drawn from ${axis}=${Math.round(gap.from)} to ${axis}=${Math.round(gap.to)}, ${Math.round(gap.to - gap.from)} px which is ${Math.round(((gap.to - gap.from) / length) * 100)} percent of the ${Math.round(length)} px size() (limit ${MAX_GAP_SHARE * 100}); close the gap by moving the parts together or give it content`);
        }
      }
      const extent = { minX: Math.min(...boxes.map((box) => box.minX)), maxX: Math.max(...boxes.map((box) => box.maxX)), minY: Math.min(...boxes.map((box) => box.minY)), maxY: Math.max(...boxes.map((box) => box.maxY)) };
      for (const [axis, length, low, high, lowName, highName] of [["x", size.w, extent.minX, size.w - extent.maxX, "left", "right"], ["y", size.h, extent.minY, size.h - extent.maxY, "top", "bottom"]] as const) {
        if (Math.max(low, high) > MAX_MARGIN_RATIO * Math.max(Math.min(low, high), CLEARANCE)) {
          add(step.step, object.id, `unbalanced space on ${axis}: the ${lowName} margin is ${Math.round(low)} px and the ${highName} margin is ${Math.round(high)} px against a size() of ${Math.round(length)} px (one margin may be at most ${MAX_MARGIN_RATIO} times the other); centre the drawing in size() or make size() match the drawing`);
        }
      }
      for (const arrow of drawables.filter((drawable) => drawable.kind === "arrow")) {
        const shaft = Math.hypot((arrow.x2 ?? arrow.x) - arrow.x, (arrow.y2 ?? arrow.y) - arrow.y);
        const head = arrowHeadLength((arrow.strokeWidth ?? 0) * WIDEST_STROKE);
        if (shaft < MIN_SHAFT_HEADS * head) add(step.step, object.id, `arrow too short: ${arrow.id} has a ${Math.round(shaft)} px shaft but its head is ${Math.round(head)} px long in the widest Theme, so it draws as a bare head or a glitch; make the shaft at least ${Math.round(MIN_SHAFT_HEADS * head)} px, lower its strokeWidth, or draw a line with no head`);
      }
      const texts = drawables.filter((drawable) => drawable.kind === "text" && /\S/.test(drawable.text ?? ""));
      const crowded: string[] = [];
      for (const [index, text] of texts.entries()) {
        const box = boxOf(text)!;
        for (const other of texts.slice(index + 1)) {
          const gap = boxGap(box, boxOf(other)!);
          if (gap < CLEARANCE) crowded.push(`label ${describe(text)} is ${Math.round(gap)} px from label ${describe(other)} (need ${CLEARANCE}); move them apart`);
        }
        const holders = drawables.filter((shape) => ["rect", "path"].includes(shape.kind) && clearance(box, shape) === null);
        for (const shape of drawables) {
          if (!["rect", "circle", "line", "arrow", "path"].includes(shape.kind) || shape.backdrop) continue;
          if (shape.part !== undefined && holders.some((holder) => holder.part !== undefined && encloses(holder, shape))) continue;
          const gap = clearance(box, shape);
          if (gap !== null && gap < CLEARANCE) crowded.push(`label ${describe(text)} is ${Math.round(gap)} px from the edge of ${shape.kind} ${shape.id} that it does not sit inside (need ${CLEARANCE}); move the label or enlarge the shape around it`);
        }
      }
      const onStage = placed.get(object.id)?.scale ?? 1;
      const small = timeline.finalScene.reading === false ? [] : drawables.filter((drawable) => (drawable.kind === "text" || drawable.kind === "code") && /\S/.test(drawable.text ?? "") && (drawable.size ?? Infinity) * onStage < MIN_TEXT_PX - 0.5);
      limited(small.map((text) => `${describe(text)} draws at ${Math.round((text.size ?? 0) * onStage)} px on the 1600x900 stage (minimum ${MIN_TEXT_PX}); raise its size or give the object more room`)).forEach((line) => add(step.step, object.id, `text too small: ${line}`));
      limited(crowded).forEach((line) => add(step.step, object.id, `crowded labels: ${line}`));
    }
  }
  return findings;
}
