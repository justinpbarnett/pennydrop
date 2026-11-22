import { boxDrawable, fail, fitText, textDrawable, type Drawable, type LabOp, type Role } from "../../lab";

type Point = [number, number];

interface Line {
  name: string;
  points: Point[];
  color: Role;
}

interface Axes {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  xStep: number;
  yStep: number;
}

export interface CurvesPlot {
  kind: "curves";
  id: string;
  reading: boolean;
  xName: string;
  yName: string;
  lines: Line[];
  drawnTo: Record<string, number>;
  mark: number | null;
  axes: Axes;
}

const WIDTH = 1200;
const LEFT = 190;
const RIGHT = 1150;
const TOP = 150;
const BOTTOM = 560;
const LEGEND_Y = 50;
const Y_NAME_Y = 108;
const X_TICK_Y = BOTTOM + 38;
const X_NAME_Y = BOTTOM + 92;
const COLORS: Role[] = ["series1", "series2", "series3"];
const MAX_LINES = COLORS.length;
const LABEL_GAP = 36;

export function curvesHeight(plot: CurvesPlot): number {
  return plot.reading ? X_NAME_Y + 44 : BOTTOM + 40;
}

export function curvesPlot(spec: Record<string, unknown>, id: string, reading: boolean): CurvesPlot {
  if (spec.function !== undefined || spec.a !== undefined) fail(`${id}: a plot made by the curves directive draws the lines it computed, so leave out function and a`);
  const curves = spec.curves;
  if (typeof curves !== "object" || curves === null || Array.isArray(curves)) fail(`${id}: curves must map each line's name to its points`);
  const entries = Object.entries(curves);
  if (entries.length < 1 || entries.length > MAX_LINES) fail(`${id}: a plot holds 1 to ${MAX_LINES} lines`);
  const lines = entries.map(([name, points], index) => ({ name, points: linePoints(points, `${id} ${name}`), color: COLORS[index]! }));
  return { kind: "curves", id, reading, xName: axisName(spec.x, `${id} x`), yName: axisName(spec.y, `${id} y`), lines, drawnTo: {}, mark: null, axes: axesOf(lines) };
}

export function graphCurve(plot: CurvesPlot, op: LabOp): CurvesPlot {
  onlyArgs(plot, op, ["curve", "to"]);
  const name = op.args.curve;
  const line = plot.lines.find((found) => found.name === name);
  if (!line) fail(`${plot.id}: graph a "curve" named ${plot.lines.map((found) => found.name).join(" or ")}`);
  const start = line.points[0]![0];
  const end = line.points.at(-1)![0];
  const to = op.args.to ?? end;
  if (typeof to !== "number" || !Number.isFinite(to) || to <= start || to > end) fail(`${plot.id}: graph the ${line.name} line "to" an x after ${start} and up to ${end}, or leave out "to" to draw it to the end`);
  const reached = plot.drawnTo[line.name];
  if (reached !== undefined && to <= reached) fail(`${plot.id}: the ${line.name} line is already drawn to ${formatNumber(reached)}; graph it "to" a later x, or leave out "to" to draw it to the end`);
  return { ...plot, drawnTo: { ...plot.drawnTo, [line.name]: to } };
}

export function growingCurve(before: CurvesPlot, after: CurvesPlot, progress: number): Drawable[] {
  const line = after.lines.find((found) => after.drawnTo[found.name] !== before.drawnTo[found.name]);
  if (!line) return [];
  const from = before.drawnTo[line.name] ?? line.points[0]![0];
  const reach = from + (after.drawnTo[line.name]! - from) * progress;
  return drawCurves({ ...after, drawnTo: { ...after.drawnTo, [line.name]: reach } }).filter((drawable) => drawable.id === `curve-${line.name}`);
}

export function markCurves(plot: CurvesPlot, op: LabOp): CurvesPlot {
  onlyArgs(plot, op, ["x"]);
  const { x0, x1 } = plot.axes;
  const x = op.args.x;
  if (typeof x !== "number" || !Number.isFinite(x) || x < x0 || x > x1) fail(`${plot.id}: mark an x from ${x0} to ${x1}`);
  if (!throughX(plot, x).length) fail(`${plot.id}: no drawn line reaches x ${formatNumber(x)} yet; graph a line through that x before marking it`);
  const short = plot.lines.filter((line) => (plot.drawnTo[line.name] ?? Infinity) < x);
  if (short.length) fail(`${plot.id}: the ${short.map((line) => line.name).join(" and ")} line is drawn only to ${formatNumber(plot.drawnTo[short[0]!.name]!)}, so a mark at x ${formatNumber(x)} would show no value for it; graph it "to" ${formatNumber(x)} or on to the end before the mark`);
  return { ...plot, mark: x };
}

function throughX(plot: CurvesPlot, x: number): Line[] {
  return plot.lines.filter((line) => (plot.drawnTo[line.name] ?? -Infinity) >= x);
}

export function drawCurves(plot: CurvesPlot): Drawable[] {
  const { axes } = plot;
  const px = (x: number) => LEFT + ((x - axes.x0) / (axes.x1 - axes.x0)) * (RIGHT - LEFT);
  const py = (y: number) => BOTTOM - ((y - axes.y0) / (axes.y1 - axes.y0)) * (BOTTOM - TOP);
  const marks: Drawable[] = [boxDrawable("panel", { x: 0, y: 0, w: WIDTH, h: curvesHeight(plot) }, { fill: "fill", z: 0 })];
  for (const y of ticks(axes.y0, axes.y1, axes.yStep)) {
    marks.push(rule(`y-rule-${y}`, LEFT, py(y), RIGHT, py(y), y === 0 ? "muted" : "rule"));
    if (plot.reading) marks.push(label(`y-value-${y}`, formatNumber(y), LEFT - 18, py(y), 26, LEFT - 30, "end"));
  }
  for (const x of ticks(axes.x0, axes.x1, axes.xStep)) {
    marks.push(rule(`x-rule-${x}`, px(x), TOP, px(x), BOTTOM, "rule"));
    if (plot.reading) marks.push(label(`x-value-${x}`, formatNumber(x), px(x), X_TICK_Y, 26, 120, "middle"));
  }
  marks.push(rule("x-axis", LEFT, BOTTOM, RIGHT, BOTTOM, "muted"), rule("y-axis", LEFT, TOP, LEFT, BOTTOM, "muted"));
  if (plot.reading) {
    marks.push(label("y-name", plot.yName, LEFT, Y_NAME_Y, 30, 500, "start", "muted"), label("x-name", plot.xName, (LEFT + RIGHT) / 2, X_NAME_Y, 30, 600, "middle", "muted"));
  }
  const drawn = plot.lines.filter((line) => plot.drawnTo[line.name] !== undefined);
  const slot = (RIGHT - LEFT) / MAX_LINES;
  drawn.forEach((line, index) => {
    const points = pointsUpTo(line.points, plot.drawnTo[line.name]!).flatMap(([x, y]) => [px(x), py(y)]);
    marks.push({ id: `curve-${line.name}`, kind: "path", x: points[0]!, y: points[1]!, points, stroke: line.color, fill: "none", strokeWidth: 5, z: 4 });
    if (!plot.reading) return;
    const left = LEFT + slot * index;
    marks.push(rule(`key-${line.name}`, left, LEGEND_Y, left + 44, LEGEND_Y, line.color, 6));
    marks.push(label(`key-name-${line.name}`, spoken(line.name), left + 58, LEGEND_Y, 30, slot - 76, "start"));
  });
  const marked = plot.mark === null ? [] : throughX(plot, plot.mark);
  if (plot.mark !== null && marked.length) marks.push(...markDrawables(plot.mark, marked, plot.reading, px, py));
  return marks;
}

function markDrawables(x: number, lines: Line[], reading: boolean, px: (x: number) => number, py: (y: number) => number): Drawable[] {
  const at = px(x);
  const marks: Drawable[] = [rule("mark", at, TOP, at, BOTTOM, "muted", 2, 3)];
  const values = lines.map((line) => ({ line, y: valueAt(line.points, x) })).sort((a, b) => b.y - a.y);
  for (const { line, y } of values) marks.push({ id: `mark-dot-${line.name}`, kind: "circle", x: at, y: py(y), r: 9, fill: line.color, stroke: "fill", strokeWidth: 3, z: 6 });
  if (!reading) return marks;
  const labels = values.filter(({ y }, index) => index === 0 || formatNumber(y) !== formatNumber(values[index - 1]!.y));
  const heights: number[] = [];
  for (const { y } of labels) heights.push(Math.max(py(y) - 26, (heights.at(-1) ?? -Infinity) + LABEL_GAP, TOP - 10));
  const overflow = Math.max(0, (heights.at(-1) ?? 0) - (BOTTOM - LABEL_GAP / 2));
  const onLeft = at > (LEFT + RIGHT) / 2;
  labels.forEach(({ line, y }, index) => {
    marks.push({ ...label(`mark-value-${line.name}`, formatNumber(y), at + (onLeft ? -18 : 18), heights[index]! - overflow, 28, 260, onLeft ? "end" : "start"), backdrop: true });
  });
  return marks;
}

function pointsUpTo(points: Point[], reach: number): Point[] {
  const before = points.filter(([x]) => x < reach);
  return [...(before.length ? before : [points[0]!]), [reach, valueAt(points, reach)]];
}

function linePoints(value: unknown, field: string): Point[] {
  if (!Array.isArray(value) || value.length < 2) fail(`${field}: a line needs at least 2 points`);
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((n) => typeof n === "number" && Number.isFinite(n))) fail(`${field}: each point is [x, y] with two numbers`);
    return point as Point;
  });
  if (points.some((point, index) => index > 0 && point[0] <= points[index - 1]![0])) fail(`${field}: the points must rise in x`);
  return points;
}

function axisName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field}: name the axis, such as "years"`);
  return value;
}

function onlyArgs(plot: CurvesPlot, op: LabOp, keys: string[]): void {
  if (op.parts.length) fail(`${plot.id}: use ${op.name} on the whole plot, not on a part of it`);
  const extra = Object.keys(op.args).filter((key) => !keys.includes(key));
  if (extra.length) fail(`${plot.id}: ${op.name} on a plot of curves takes only ${keys.join(" and ")}, not ${extra.join(" or ")}`);
}

function axesOf(lines: Line[]): Axes {
  const xs = lines.flatMap((line) => line.points.map(([x]) => x));
  const ys = lines.flatMap((line) => line.points.map(([, y]) => y));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const low = Math.min(0, ...ys);
  const high = Math.max(0, ...ys);
  const yStep = niceStep(high > low ? high - low : 1, 5);
  return { x0, x1, y0: Math.floor(low / yStep) * yStep, y1: Math.max(Math.ceil(high / yStep) * yStep, Math.floor(low / yStep) * yStep + yStep), xStep: niceStep(x1 - x0, 6), yStep };
}

function niceStep(span: number, count: number): number {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5].find((multiple) => multiple * power >= raw) ?? 10) * power;
}

function ticks(from: number, to: number, step: number): number[] {
  const found: number[] = [];
  for (let k = Math.ceil(from / step - 1e-9); k * step <= to + step * 1e-9; k++) found.push(Number((k * step).toPrecision(12)));
  return found;
}

function valueAt(points: Point[], x: number): number {
  const after = points.findIndex(([px]) => px >= x);
  if (after <= 0) return after === 0 ? points[0]![1] : points[points.length - 1]![1];
  const [xa, ya] = points[after - 1]!;
  const [xb, yb] = points[after]!;
  return ya + ((yb - ya) * (x - xa)) / (xb - xa);
}

function formatNumber(value: number): string {
  const size = Math.abs(value);
  return value.toLocaleString("en-US", { maximumFractionDigits: size >= 100 ? 0 : size >= 10 ? 1 : size >= 1 || value === 0 ? 2 : 4 });
}

function spoken(name: string): string {
  return name.replaceAll("_", " ");
}

function rule(id: string, x: number, y: number, x2: number, y2: number, stroke: Role, strokeWidth = 2, z = 1): Drawable {
  return { id, kind: "line", x, y, x2, y2, stroke, strokeWidth, z };
}

function label(id: string, content: string, x: number, y: number, size: number, room: number, anchor: Drawable["anchor"], fill: Role = "ink"): Drawable {
  return textDrawable(id, content, { x, y }, { anchor, size: fitText(content, size, room, "read"), fill, z: 7 });
}
