import { textWidth } from "./text-metrics";

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
export const PATH_KINDS: readonly DrawableKind[] = ["line", "arrow", "path"];
export const WORD_KINDS: readonly DrawableKind[] = ["text", "code", "math"];

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
  crop?: Rect;
  clip?: Rect;
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
  backdrop?: boolean;
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

export interface LabCatalog {
  summary: string;
  spec: Record<string, string>;
  example: string[];
}

export interface Catalog extends LabCatalog {
  ops: Record<string, string>;
  wordless: boolean;
}

export type LabReading = "required" | "optional";

export interface OpDef<State = unknown> {
  doc: string;
  seconds: number | ((op: LabOp, state: State) => number);
  apply(state: State, op: LabOp): State;
  during?(before: State, after: State, op: LabOp, progress: number, ctx: LabCtx): Drawable[];
  sound?(op: LabOp, state: State): void;
  trueTime?: boolean;
}

export interface LabDef<Spec = Record<string, unknown>, State = unknown> {
  id: string;
  title: string;
  reading: LabReading;
  overlay?: boolean;
  round?: boolean;
  catalog: LabCatalog;
  ops: Record<string, OpDef<State>>;
  prepare?(): Promise<void>;
  init(spec: Spec, objectId: string): State;
  size(state: State): Size;
  draw(state: State, ctx: LabCtx): Drawable[];
}

export type AnyLabDef = LabDef<any, any>;

export class LabError extends Error {
  override name = "LabError";
}

export function segmentDrawable(kind: "line" | "arrow", from: Point, to: Point, stroke: Paint, strokeWidth: number, z = 0): Drawable {
  return { id: "body", kind, x: from.x, y: from.y, x2: to.x, y2: to.y, stroke, strokeWidth, z };
}

export const STAGE: Size = { w: 1600, h: 900 };
export const STAGE_MARGIN = 60;
export const NODE_LABEL_SIZE = 26;

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

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t), w: lerp(from.w, to.w, t), h: lerp(from.h, to.h, t) };
}

export function fitText(text: string, maxSize: number, room: number, font: FontRole): number {
  return Math.min(maxSize, (room / textWidth(text, 100, font)) * 100);
}

export type TextLook = Partial<Omit<Drawable, "id" | "kind" | "x" | "y" | "text">> & { size: number };
export type BoxLook = Partial<Omit<Drawable, "id" | "kind" | "x" | "y" | "w" | "h">>;

export function textDrawable(id: string, content: string, at: Point, look: TextLook): Drawable {
  return { id, kind: "text", x: at.x, y: at.y, text: content, font: "read", fill: "ink", ...look };
}

export function boxDrawable(id: string, rect: Rect, look: BoxLook): Drawable {
  return { id, kind: "rect", x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: rect.w, h: rect.h, ...look };
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
  const value = spec[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${objectId}: "${key}" must be a number, got ${JSON.stringify(value)}`);
  return value;
}

export function positiveField<Fallback extends number | undefined>(spec: Record<string, unknown>, key: string, fallback: Fallback, objectId: string): number | Fallback {
  const value = spec[key] ?? fallback;
  if (value === undefined) return value as Fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${objectId}: "${key}" must be a positive number, got ${JSON.stringify(value)}`);
  return value;
}

export function integerField(spec: Record<string, unknown>, key: string, fallback: number, min: number, max: number, objectId: string): number {
  const value = spec[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${objectId}: "${key}" must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function rangeField(spec: Record<string, unknown>, key: string, fallback: number, min: number, max: number, objectId: string): number {
  const value = spec[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${objectId}: "${key}" must be a number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function integerArg(args: Record<string, unknown>, key: string, opName: string, min: number, max: number, fallback?: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`op "${opName}" needs "${key}" as a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function readsWords(spec: Record<string, unknown>): boolean {
  return spec.reading !== false;
}

export function stringField(spec: Record<string, unknown>, key: string, objectId: string, fallback?: string): string {
  const value = spec[key] ?? fallback;
  if (typeof value !== "string") fail(`${objectId}: "${key}" must be text`);
  return value;
}

export function hasOp(def: AnyLabDef, name: string): boolean {
  return Object.hasOwn(def.ops, name);
}

export function opSeconds(def: AnyLabDef, op: LabOp, state: unknown): number {
  const { seconds } = def.ops[op.name]!;
  return typeof seconds === "number" ? seconds : seconds(op, state);
}

export function opIsTrueTime(def: AnyLabDef, name: string): boolean {
  return Boolean(def.ops[name]?.trueTime);
}

export function applyLabOp(def: AnyLabDef, state: unknown, op: LabOp): unknown {
  return def.ops[op.name]!.apply(state, op);
}

export function duringLabOp(def: AnyLabDef, before: unknown, after: unknown, op: LabOp, progress: number, ctx: LabCtx): Drawable[] {
  return def.ops[op.name]?.during?.(before, after, op, progress, ctx) ?? [];
}

export function labCatalog(def: AnyLabDef): Catalog {
  const ops = Object.fromEntries(Object.entries(def.ops).map(([name, op]) => [name, op.trueTime ? `${op.doc} Runs in real time.` : op.doc]));
  return { ...def.catalog, ops, wordless: def.reading === "optional" };
}
