import { fail, type LabDef, numberField, type Role, roleField, stringField } from "../lab";

interface NodeState {
  label: string;
  radius: number;
  role: Role;
}

export const primitive: LabDef<Record<string, unknown>, NodeState> = {
  id: "node",
  title: "Node",
  round: true,
  catalog: {
    summary: "A labeled circle for graphs and trees. Join nodes with the connect verb or an edge object.",
    spec: { label: "text inside", radius: "optional px, default 52", role: "outline color role, default ink" },
    ops: {},
    example: ['{"scene":{"a":{"kind":"node","label":"A"},"b":{"kind":"node","label":"B","at":{"right of":"a"}}}}'],
  },
  init(spec, objectId) {
    return { label: stringField(spec, "label", objectId), radius: numberField(spec, "radius", 52, objectId), role: roleField(spec, "role", "ink", objectId) };
  },
  apply(_state, op) {
    return fail(`node has no op "${op.name}"; use highlight or color`);
  },
  size: (state) => ({ w: state.radius * 2, h: state.radius * 2 }),
  draw: (state) => [
    { id: "body", kind: "circle", x: state.radius, y: state.radius, r: state.radius, fill: "fill", stroke: state.role, strokeWidth: 1.6 },
    { id: "label", kind: "text", x: state.radius, y: state.radius, text: state.label, size: state.radius * 0.8, font: "mark", fill: "ink", z: 1 },
  ],
};
