export const ROLES = [
  "ground", "ink", "muted", "rule", "accent", "active", "compare", "swap",
  "done", "ok", "warn", "fault", "fill", "fill2", "highlight", "edge",
  "series1", "series2", "series3", "series4", "series5", "series6",
] as const;
export type Role = (typeof ROLES)[number];
export type Paint = Role | "none";
export type FontRole = "mark" | "read" | "code" | "math";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface Span {
  text: string;
  role: Role;
}

export type DrawableKind = "rect" | "circle" | "line" | "arrow" | "path" | "text" | "code" | "math" | "image";

export interface Drawable {
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
  spans?: Span[];
  latex?: string;
  href?: string;
  size?: number;
  font?: FontRole;
  anchor?: "start" | "middle" | "end";
  fill?: Paint;
  stroke?: Paint;
  strokeWidth?: number;
  radius?: number;
  opacity?: number;
  z?: number;
  rotation?: number;
  draw?: number;
  part?: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface Link extends Rect {
  round: boolean;
}

export interface LabOp {
  name: string;
  parts: string[];
  args: Record<string, unknown>;
}

export interface LabCtx {
  objectId: string;
  links: Record<string, Link>;
}

export interface Catalog {
  summary: string;
  spec: Record<string, string>;
  ops: Record<string, string>;
  example: string[];
}

export interface LabDef<Spec = Record<string, unknown>, State = unknown> {
  id: string;
  title: string;
  overlay?: boolean;
  round?: boolean;
  linearOps?: readonly string[];
  catalog: Catalog;
  init(spec: Spec, objectId: string): State;
  apply(state: State, op: LabOp): State;
  size(state: State): Size;
  draw(state: State, ctx: LabCtx): Drawable[];
  duration?(op: LabOp, state: State): number;
  during?(before: State, after: State, op: LabOp, progress: number, ctx: LabCtx): Drawable[];
}

export type AnyLabDef = LabDef<any, any>;

export class LabError extends Error {
  override name = "LabError";
}

export function segmentDrawable(kind: "line" | "arrow", from: Point, to: Point, stroke: Paint, strokeWidth: number, z = 0): Drawable {
  return { id: "body", kind, x: from.x, y: from.y, x2: to.x, y2: to.y, stroke, strokeWidth, z };
}

export function labelDrawable(text: string, at: Point, size: number, font: FontRole, fill: Paint, z: number): Drawable {
  return { id: "label", kind: "text", x: at.x, y: at.y, text, size, font, fill, z };
}

export function fail(message: string): never {
  throw new LabError(message);
}

export function indexPart(part: string, count: number, objectId: string, unit = "cells"): number {
  const index = Number(part);
  if (!Number.isInteger(index)) fail(`${objectId}[${part}] is not an index: use ${objectId}[0] to ${objectId}[${count - 1}]`);
  if (index < 0 || index >= count) fail(`${objectId}[${index}] is out of range: ${objectId} has ${count} ${unit}`);
  return index;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function stringArg(args: Record<string, unknown>, key: string, opName: string): string {
  const value = args[key];
  if (typeof value !== "string") fail(`op "${opName}" needs "${key}" as text`);
  return value;
}

export function numberArg(args: Record<string, unknown>, key: string, opName: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`op "${opName}" needs "${key}" as a number`);
  return value;
}

export function roleField(spec: Record<string, unknown>, key: string, fallback: Role, objectId: string): Role {
  const value = spec[key];
  if (value === undefined) return fallback;
  if (!isRole(value)) fail(`${objectId}: "${key}" must be a role name such as ink, accent, active, done or fault`);
  return value;
}

export function numberField(spec: Record<string, unknown>, key: string, fallback: number, objectId: string): number {
  const value = spec[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${objectId}: "${key}" must be a positive number`);
  return value;
}

export function stringField(spec: Record<string, unknown>, key: string, objectId: string, fallback?: string): string {
  const value = spec[key] ?? fallback;
  if (typeof value !== "string") fail(`${objectId}: "${key}" must be text`);
  return value;
}
