import { type Drawable, fail, type LabDef, labelDrawable, numberField, type Point, type Role, roleField, segmentDrawable } from "../lab";
import { textWidth } from "../text-metrics";

type ShapeName = "rect" | "circle" | "line" | "arrow" | "path";

type Direction = keyof typeof DIRECTIONS;

interface ShapeState {
  shape: ShapeName;
  w: number;
  h: number;
  points: number[];
  direction: Direction;
  label: string;
  role: Role;
  fillRole: Role | "none";
}

const DIRECTIONS = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] } as const;
const SHAPES: ShapeName[] = ["rect", "circle", "line", "arrow", "path"];
const LABEL_SIZE = 34;
const markWidth = (label: string) => Math.max(textWidth(label, LABEL_SIZE, "mark"), textWidth(label.toUpperCase(), LABEL_SIZE, "mark"));
const LABEL_BAND = LABEL_SIZE * 1.2;
const LABEL_PAD = 24;
const LABEL_GAP = 14;
const STROKE = 2;

const isHorizontal = (direction: Direction) => direction === "right" || direction === "left";

function labelAnchor(state: ShapeState): Point {
  const { shape, w, h, label, direction } = state;
  if (shape !== "line" && shape !== "arrow") return { x: w / 2, y: h / 2 };
  if (isHorizontal(direction)) return { x: w / 2, y: LABEL_BAND / 2 };
  return { x: STROKE + LABEL_GAP + markWidth(label) / 2, y: h / 2 };
}

function lineEnds(state: ShapeState): [Point, Point] {
  const { w, h, direction } = state;
  const [dx, dy] = DIRECTIONS[direction];
  const across = isHorizontal(direction) ? { x: 0, y: h - STROKE / 2 } : { x: STROKE / 2, y: 0 };
  const from = { x: dx < 0 ? w : dx > 0 ? 0 : across.x, y: dy < 0 ? h : dy > 0 ? 0 : across.y };
  const to = { x: dx < 0 ? 0 : dx > 0 ? w : across.x, y: dy < 0 ? 0 : dy > 0 ? h : across.y };
  return [from, to];
}

export const primitive: LabDef<Record<string, unknown>, ShapeState> = {
  id: "shape",
  title: "Shape",
  catalog: {
    summary: "A rect, circle, line, arrow or path with an optional label. The shape grows to fit its label: a rect, circle or path holds it inside, an arrow or line carries it above (horizontal) or beside (vertical).",
    spec: {
      shape: SHAPES.join(" | "),
      w: "rect width, default 220",
      h: "rect height, default 120",
      r: "circle radius, default 70",
      length: "line or arrow length, default 260",
      direction: "line or arrow direction: right, left, up, down",
      points: "path as [[x, y], ...] in a box of about 300 by 200",
      label: "optional text inside",
      role: "stroke color role, default ink",
      fill: "optional fill color role",
    },
    ops: {},
    example: ['{"scene":{"box":{"kind":"shape","shape":"rect","label":"Hello"}}}'],
  },
  init(spec, objectId) {
    const shape = spec.shape as ShapeName;
    if (!SHAPES.includes(shape)) fail(`${objectId}: "shape" must be one of ${SHAPES.join(", ")}`);
    const role = roleField(spec, "role", "ink", objectId);
    const fillRole: ShapeState["fillRole"] = spec.fill === undefined ? "none" : roleField(spec, "fill", "fill", objectId);
    const label = typeof spec.label === "string" ? spec.label : "";
    const base = { shape, label, role, fillRole, points: [] as number[], direction: "right" as Direction };
    const labelW = label ? markWidth(label) : 0;
    const wideEnough = (w: number) => (label ? Math.max(w, labelW + 2 * LABEL_PAD) : w);
    const tallEnough = (h: number) => (label ? Math.max(h, LABEL_BAND + LABEL_PAD) : h);
    if (shape === "circle") {
      const r = numberField(spec, "r", 70, objectId);
      const diameter = label ? Math.max(r * 2, Math.hypot(labelW, LABEL_BAND) + LABEL_PAD) : r * 2;
      return { ...base, w: diameter, h: diameter };
    }
    if (shape === "line" || shape === "arrow") {
      const length = numberField(spec, "length", 260, objectId);
      const direction = String(spec.direction ?? "right") as Direction;
      if (!(direction in DIRECTIONS)) fail(`${objectId}: "direction" must be right, left, up or down`);
      if (!label) {
        const [dx, dy] = DIRECTIONS[direction];
        return { ...base, direction, w: Math.max(STROKE, Math.abs(dx) * length), h: Math.max(STROKE, Math.abs(dy) * length) };
      }
      if (isHorizontal(direction)) return { ...base, direction, w: Math.max(length, labelW + LABEL_PAD), h: LABEL_BAND + LABEL_GAP + STROKE };
      return { ...base, direction, w: STROKE + LABEL_GAP + labelW, h: Math.max(length, LABEL_BAND) };
    }
    if (shape === "path") {
      const points = spec.points;
      if (!Array.isArray(points) || points.length < 2 || !points.every((point) => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === "number"))) {
        fail(`${objectId}: "points" must be a list of at least two [x, y] pairs`);
      }
      const flat = (points as number[][]).flat();
      const xs = flat.filter((_, index) => index % 2 === 0);
      const ys = flat.filter((_, index) => index % 2 === 1);
      const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
      const w = Math.max(...xs) - minX;
      const h = Math.max(...ys) - minY;
      const [fitW, fitH] = [wideEnough(w), tallEnough(h)];
      return { ...base, w: fitW, h: fitH, points: flat.map((value, index) => (index % 2 === 0 ? value - minX + (fitW - w) / 2 : value - minY + (fitH - h) / 2)) };
    }
    return { ...base, w: wideEnough(numberField(spec, "w", 220, objectId)), h: tallEnough(numberField(spec, "h", 120, objectId)) };
  },
  apply(_state, op) {
    return fail(`shape has no op "${op.name}"; use the generic verbs highlight, color, trace or morph`);
  },
  size: (state) => ({ w: state.w, h: state.h }),
  draw(state) {
    const { shape, w, h, role, label } = state;
    const box = { x: w / 2, y: h / 2 };
    const out: Drawable[] = [];
    if (shape === "rect") out.push({ id: "body", kind: "rect", ...box, w, h, fill: state.fillRole, stroke: role, strokeWidth: 1.6, radius: 1 });
    if (shape === "circle") out.push({ id: "body", kind: "circle", ...box, r: w / 2, fill: state.fillRole, stroke: role, strokeWidth: 1.6 });
    if (shape === "line" || shape === "arrow") {
      const [from, to] = lineEnds(state);
      out.push(segmentDrawable(shape, from, to, role, STROKE));
    }
    if (shape === "path") out.push({ id: "body", kind: "path", x: 0, y: 0, points: state.points, fill: state.fillRole, stroke: role, strokeWidth: 2, closed: state.fillRole !== "none" });
    if (label) out.push(labelDrawable(label, labelAnchor(state), LABEL_SIZE, "mark", "ink", 1));
    return out;
  },
};
