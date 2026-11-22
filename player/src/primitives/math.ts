import { loadMath, typeset } from "../typeset";
import { type LabDef, positiveField, type Role, roleField, stringField } from "../lab";

interface MathState {
  latex: string;
  size: number;
  role: Role;
}

function sizeOf(state: MathState) {
  const { w, h } = typeset(state.latex);
  return { w: w * state.size, h: h * state.size };
}

export const primitive: LabDef<Record<string, unknown>, MathState> = {
  id: "math",
  title: "Math",
  reading: "required",
  catalog: {
    summary: "A LaTeX expression typeset with MathJax.",
    spec: { latex: "LaTeX source such as a^2 + b^2 = c^2", size: "optional px, default 56", role: "optional color role, default ink" },
    example: ['{"scene":{"eq":{"kind":"math","latex":"\\\\frac{n(n-1)}{2}"}}}'],
  },
  ops: {},
  init(spec, objectId) {
    const state = { latex: stringField(spec, "latex", objectId), size: positiveField(spec, "size", 56, objectId), role: roleField(spec, "role", "ink", objectId) };
    typeset(state.latex);
    return state;
  },
  prepare: loadMath,
  size: sizeOf,
  draw(state) {
    const { w, h } = sizeOf(state);
    return [{ id: "expression", kind: "math", x: w / 2, y: h / 2, w, h, latex: state.latex, size: state.size, font: "math", fill: state.role }];
  },
};
