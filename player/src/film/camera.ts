import { lerp } from "../lab";
import type { CameraMove, CameraView } from "./format";
import { centerOf, type Placement } from "./world";

export const SCREEN = { w: 1920, h: 1080 } as const;
export const PERSPECTIVE = 2000;
const FILL: Record<CameraView, number> = { wide: 0.5, fit: 0.88, close: 0.96 };
const MIN_DISTANCE = 700;
const ARC_LIFT = 0.05;
const DOLLY_SHARE = 0.4;
const DOLLY_LIMIT = 1600;
const NEAR = 1;
const DRIFT_SIDEWAYS = 0.004;
const DRIFT_UPWARD = 0.0025;
const DRIFT_DEPTH = 0.012;

export interface Pose {
  px: number;
  py: number;
  pz: number;
  tx: number;
  ty: number;
  tz: number;
}

export interface Shot {
  start: number;
  end: number;
  to: Pose;
}

type Vec = [number, number, number];

const subtract = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec): Vec => {
  const length = Math.hypot(...a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

export function poseFor(placement: Placement, move: Pick<CameraMove, "view" | "elevation">): Pose {
  const center = centerOf(placement);
  const fill = FILL[move.view ?? "fit"];
  const distance = Math.max(MIN_DISTANCE, PERSPECTIVE * Math.max(placement.w / (fill * SCREEN.w), placement.h / (fill * SCREEN.h)));
  const elevation = ((move.elevation ?? 0) * Math.PI) / 180;
  return {
    px: center.x,
    py: center.y - distance * Math.sin(elevation),
    pz: center.z + distance * Math.cos(elevation),
    tx: center.x,
    ty: center.y,
    tz: center.z,
  };
}

export function blendPose(from: Pose, to: Pose, progress: number): Pose {
  const swing = Math.sin(Math.PI * progress);
  const travel = Math.hypot(to.px - from.px, to.py - from.py, to.pz - from.pz);
  const pose = {
    px: lerp(from.px, to.px, progress),
    py: lerp(from.py, to.py, progress) - swing * ARC_LIFT * travel,
    pz: lerp(from.pz, to.pz, progress),
    tx: lerp(from.tx, to.tx, progress),
    ty: lerp(from.ty, to.ty, progress),
    tz: lerp(from.tz, to.tz, progress),
  };
  const away = unit(subtract([pose.px, pose.py, pose.pz], [pose.tx, pose.ty, pose.tz]));
  const dolly = swing * Math.min(DOLLY_SHARE * travel, DOLLY_LIMIT);
  return { ...pose, px: pose.px + away[0] * dolly, py: pose.py + away[1] * dolly, pz: pose.pz + away[2] * dolly };
}

export function poseAt(opening: Pose, shots: Shot[], time: number, ease: (progress: number) => number): Pose {
  let index = -1;
  shots.forEach((shot, position) => {
    if (shot.start <= time) index = position;
  });
  const settle = (position: number, at: number): Pose => {
    if (position < 0) return opening;
    const shot = shots[position]!;
    if (at >= shot.end) return shot.to;
    return blendPose(settle(position - 1, shot.start), shot.to, ease(Math.max(0, (at - shot.start) / (shot.end - shot.start))));
  };
  return settle(index, time);
}

export function drift(pose: Pose, time: number): Pose {
  const distance = Math.hypot(pose.px - pose.tx, pose.py - pose.ty, pose.pz - pose.tz);
  const sideways = distance * DRIFT_SIDEWAYS * Math.sin(0.31 * time);
  const upward = distance * DRIFT_UPWARD * Math.sin(0.23 * time + 1.3);
  return {
    px: pose.px + sideways,
    py: pose.py + upward,
    pz: pose.pz + distance * DRIFT_DEPTH * Math.sin(0.17 * time + 0.4),
    tx: pose.tx + sideways,
    ty: pose.ty + upward,
    tz: pose.tz,
  };
}

interface Basis {
  x: Vec;
  y: Vec;
  z: Vec;
  position: Vec;
}

function basisOf(pose: Pose): Basis {
  const position: Vec = [pose.px, pose.py, pose.pz];
  const z = unit(subtract(position, [pose.tx, pose.ty, pose.tz]));
  const x = unit(cross(z, [0, -1, 0]));
  const y = cross(z, x);
  return { x, y, z, position };
}

export function cssMatrix(pose: Pose): string {
  const { x, y, z, position } = basisOf(pose);
  const shift = [-dot(x, position), -dot(y, position), -dot(z, position) + PERSPECTIVE];
  const columns = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, shift[0], shift[1], shift[2], 1];
  return `matrix3d(${columns.map((value) => (value ?? 0).toFixed(6)).join(",")})`;
}

export interface Screen {
  x: number;
  y: number;
  depth: number;
}

export function project(pose: Pose, point: Vec): Screen | null {
  const { x, y, z, position } = basisOf(pose);
  const relative = subtract(point, position);
  const depth = -dot(z, relative);
  if (depth < NEAR) return null;
  const scale = PERSPECTIVE / depth;
  return { x: SCREEN.w / 2 + dot(x, relative) * scale, y: SCREEN.h / 2 + dot(y, relative) * scale, depth };
}

export interface ScreenRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function regionOf(pose: Pose, placement: Placement): ScreenRegion | null {
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => project(pose, [placement.x + u! * placement.w, placement.y + v! * placement.h, placement.z]));
  if (corners.some((corner) => corner === null)) return null;
  const xs = corners.map((corner) => corner!.x);
  const ys = corners.map((corner) => corner!.y);
  const left = Math.max(0, Math.min(...xs));
  const top = Math.max(0, Math.min(...ys));
  const right = Math.min(SCREEN.w, Math.max(...xs));
  const bottom = Math.min(SCREEN.h, Math.max(...ys));
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}
