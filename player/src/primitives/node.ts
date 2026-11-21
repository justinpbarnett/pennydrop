import { type Drawable, type LabDef, type Paint, type Point, positiveField, readsWords, type Role, roleField, stringField } from "../lab";
import { textWidth } from "../text-metrics";

interface NodeState {
  label: string;
  radius: number;
  role: Role;
  reading: boolean;
}

export interface NodeLook {
  stroke: Role;
  fill: Paint;
  strokeWidth: number;
  labelFill: Paint;
}

const LABEL_SCALE = 0.8;
const LABEL_FIT = 1.5;

export function nodeDrawables(label: string, center: Point, radius: number, look: NodeLook): Drawable[] {
  const natural = radius * LABEL_SCALE;
  const width = textWidth(label, natural, "mark");
  const size = width > radius * LABEL_FIT ? (natural * radius * LABEL_FIT) / width : natural;
  return [
    { id: "body", kind: "circle", x: center.x, y: center.y, r: radius, fill: look.fill, stroke: look.stroke, strokeWidth: look.strokeWidth },
    { id: "label", kind: "text", x: center.x, y: center.y, text: label, size, font: "mark", fill: look.labelFill, z: 1 },
  ];
}

export const primitive: LabDef<Record<string, unknown>, NodeState> = {
  id: "node",
  title: "Node",
  reading: "optional",
  round: true,
  catalog: {
    summary: "A labeled circle for graphs and trees. Join nodes with the connect verb or an edge object.",
    spec: { label: "text inside", radius: "optional px, default 52", role: "outline color role, default ink" },
    example: ['{"scene":{"a":{"kind":"node","label":"A"},"b":{"kind":"node","label":"B","at":{"right of":"a"}}}}'],
  },
  ops: {},
  init(spec, objectId) {
    return { label: stringField(spec, "label", objectId), radius: positiveField(spec, "radius", 52, objectId), role: roleField(spec, "role", "ink", objectId), reading: readsWords(spec) };
  },
  size: (state) => ({ w: state.radius * 2, h: state.radius * 2 }),
  draw(state) {
    const drawables = nodeDrawables(state.label, { x: state.radius, y: state.radius }, state.radius, { stroke: state.role, fill: "fill", strokeWidth: 1.6, labelFill: "ink" });
    return state.reading ? drawables : drawables.filter((drawable) => drawable.kind !== "text");
  },
};
