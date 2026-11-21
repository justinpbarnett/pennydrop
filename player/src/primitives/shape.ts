import { type Drawable, fail, type LabDef, labelDrawable, numberField, type Role, roleField, segmentDrawable } from "../lab";

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

export const primitive: LabDef<Record<string, unknown>, ShapeState> = {
  id: "shape",
  title: "Shape",
  catalog: {
    summary: "A rect, circle, line, arrow or path with an optional label inside.",
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
    if (shape === "circle") {
      const r = numberField(spec, "r", 70, objectId);
      return { ...base, w: r * 2, h: r * 2 };
    }
    if (shape === "line" || shape === "arrow") {
      const length = numberField(spec, "length", 260, objectId);
      const direction = String(spec.direction ?? "right") as Direction;
      if (!(direction in DIRECTIONS)) fail(`${objectId}: "direction" must be right, left, up or down`);
      const [dx, dy] = DIRECTIONS[direction];
      return { ...base, direction, w: Math.max(2, Math.abs(dx) * length), h: Math.max(2, Math.abs(dy) * length) };
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
      return { ...base, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY, points: flat.map((value, index) => value - (index % 2 === 0 ? minX : minY)) };
    }
    return { ...base, w: numberField(spec, "w", 220, objectId), h: numberField(spec, "h", 120, objectId) };
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
      const [dx, dy] = DIRECTIONS[state.direction];
      out.push(segmentDrawable(
        shape,
        { x: dx < 0 ? w : dx > 0 ? 0 : w / 2, y: dy < 0 ? h : dy > 0 ? 0 : h / 2 },
        { x: dx < 0 ? 0 : dx > 0 ? w : w / 2, y: dy < 0 ? 0 : dy > 0 ? h : h / 2 },
        role, 2,
      ));
    }
    if (shape === "path") out.push({ id: "body", kind: "path", x: 0, y: 0, points: state.points, fill: state.fillRole, stroke: role, strokeWidth: 2, closed: state.fillRole !== "none" });
    if (label) out.push(labelDrawable(label, box, 34, "mark", "ink", 1));
    return out;
  },
};
