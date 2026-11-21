import type { Drawable, Size } from "./lab";
import type { Theme } from "./theme";

export const ARROW_HEAD_ANGLE = 0.46;

export const arrowHeadLength = (strokeWidth: number): number => 16 + strokeWidth * 2;

export interface Reach {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_REACH: Reach = { left: 0, top: 0, right: 0, bottom: 0 };

type Extent = [minX: number, minY: number, maxX: number, maxY: number];

function pointsOf(drawable: Drawable, strokeWidth: number): number[] {
  const { x, y } = drawable;
  if (drawable.kind === "rect") {
    const [w, h] = [drawable.w ?? 0, drawable.h ?? 0];
    return [x - w / 2, y - h / 2, x + w / 2, y - h / 2, x + w / 2, y + h / 2, x - w / 2, y + h / 2];
  }
  if (drawable.kind === "circle") {
    const r = Math.max(0, drawable.r ?? 0);
    return [x - r, y - r, x + r, y + r];
  }
  if (drawable.kind === "line") return [x, y, drawable.x2!, drawable.y2!];
  if (drawable.kind === "arrow") {
    const [x2, y2] = [drawable.x2!, drawable.y2!];
    const angle = Math.atan2(y2 - y, x2 - x);
    const head = arrowHeadLength(strokeWidth);
    const wing = (offset: number) => [x2 - head * Math.cos(angle + offset), y2 - head * Math.sin(angle + offset)];
    return [x, y, x2, y2, ...wing(ARROW_HEAD_ANGLE), ...wing(-ARROW_HEAD_ANGLE)];
  }
  if (drawable.kind === "path") return drawable.points ?? [];
  return [];
}

function turned(drawable: Drawable, points: number[]): number[] {
  if (!drawable.rotation || drawable.kind === "circle") return points;
  const radians = (drawable.rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
  const rotated: number[] = [];
  for (let index = 0; index < points.length; index += 2) {
    const dx = points[index]! - drawable.x;
    const dy = points[index + 1]! - drawable.y;
    rotated.push(drawable.x + dx * cos - dy * sin, drawable.y + dx * sin + dy * cos);
  }
  return rotated;
}

function extentOf(drawable: Drawable, theme: Theme): Extent | null {
  const strokeWidth = (drawable.strokeWidth ?? 0) * theme.stroke;
  const points = turned(drawable, pointsOf(drawable, strokeWidth));
  if (points.length === 0) return null;
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  const stroked = drawable.stroke !== undefined && drawable.stroke !== "none";
  const half = stroked ? strokeWidth / 2 : 0;
  const extent: Extent = [Math.min(...xs) - half, Math.min(...ys) - half, Math.max(...xs) + half, Math.max(...ys) + half];
  const { clip } = drawable;
  if (!clip) return extent;
  const inside: Extent = [Math.max(extent[0], clip.x), Math.max(extent[1], clip.y), Math.min(extent[2], clip.x + clip.w), Math.min(extent[3], clip.y + clip.h)];
  return inside[0] < inside[2] && inside[1] < inside[3] ? inside : null;
}

export function reachOf(drawables: Drawable[], size: Size, theme: Theme): Reach {
  const reach = { ...NO_REACH };
  for (const drawable of drawables) {
    const extent = extentOf(drawable, theme);
    if (!extent) continue;
    reach.left = Math.max(reach.left, -extent[0]);
    reach.top = Math.max(reach.top, -extent[1]);
    reach.right = Math.max(reach.right, extent[2] - size.w);
    reach.bottom = Math.max(reach.bottom, extent[3] - size.h);
  }
  return reach;
}
