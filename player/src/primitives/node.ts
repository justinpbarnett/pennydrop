import { type Drawable, type LabDef, NODE_LABEL_SIZE, type Paint, type Point, positiveField, readsWords, type Role, roleField, stringField, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

interface NodeState {
  label: string;
  radius: number;
  fitted: boolean;
  role: Role;
  reading: boolean;
}

export interface NodeLook {
  stroke: Role;
  fill: Paint;
  strokeWidth: number;
  labelFill: Paint;
}

const MIN_RADIUS = 52;
const LABEL_PADDING = 12;

export function radiusForLabels(labels: string[], least: number): number {
  const widest = Math.max(0, ...labels.map((label) => textWidth(label, NODE_LABEL_SIZE, "read")));
  return Math.max(least, Math.ceil(Math.hypot(widest / 2, NODE_LABEL_SIZE * 0.4) + LABEL_PADDING));
}

export const NODE_KEY = "primitive:node";

export function shareRadius<T extends { defKey: string; state: unknown }>(objects: readonly T[]): T[] {
  const fitted = objects.filter((object) => object.defKey === NODE_KEY && (object.state as NodeState).fitted);
  const shared = Math.max(0, ...fitted.map((object) => (object.state as NodeState).radius));
  return objects.map((object) => (fitted.includes(object) ? { ...object, state: { ...(object.state as NodeState), radius: shared } } : object));
}

export function nodeDrawables(label: string, center: Point, radius: number, look: NodeLook): Drawable[] {
  return [
    { id: "body", kind: "circle", x: center.x, y: center.y, r: radius, fill: look.fill, stroke: look.stroke, strokeWidth: look.strokeWidth },
    textDrawable("label", label, center, { size: NODE_LABEL_SIZE, fill: look.labelFill, z: 1 }),
  ];
}

export const primitive: LabDef<Record<string, unknown>, NodeState> = {
  id: "node",
  title: "Node",
  reading: "optional",
  round: true,
  catalog: {
    summary: "A labeled circle for graphs and trees. Join nodes with the connect verb or an edge object.",
    spec: { label: "text inside", radius: "optional px, default 52, grown to fit the longest label among the nodes", role: "outline color role, default ink" },
    example: ['{"scene":{"a":{"kind":"node","label":"A"},"b":{"kind":"node","label":"B","at":{"right of":"a"}}}}'],
  },
  ops: {},
  init(spec, objectId) {
    const label = stringField(spec, "label", objectId);
    const given = positiveField(spec, "radius", undefined, objectId);
    return { label, radius: given ?? radiusForLabels([label], MIN_RADIUS), fitted: given === undefined, role: roleField(spec, "role", "ink", objectId), reading: readsWords(spec) };
  },
  size: (state) => ({ w: state.radius * 2, h: state.radius * 2 }),
  draw(state) {
    const drawables = nodeDrawables(state.label, { x: state.radius, y: state.radius }, state.radius, { stroke: state.role, fill: "fill", strokeWidth: 1.6, labelFill: "ink" });
    return state.reading ? drawables : drawables.filter((drawable) => drawable.kind !== "text");
  },
};
