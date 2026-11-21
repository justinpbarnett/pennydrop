import { typeset } from "../typeset";
import { fail, type LabDef, numberField, type Role, roleField, stringField } from "../lab";

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
  catalog: {
    summary: "A LaTeX expression typeset with MathJax.",
    spec: { latex: "LaTeX source such as a^2 + b^2 = c^2", size: "optional px, default 56", role: "optional color role, default ink" },
    ops: {},
    example: ['{"scene":{"eq":{"kind":"math","latex":"\\\\frac{n(n-1)}{2}"}}}'],
  },
  init(spec, objectId) {
    const state = { latex: stringField(spec, "latex", objectId), size: numberField(spec, "size", 56, objectId), role: roleField(spec, "role", "ink", objectId) };
    typeset(state.latex);
    return state;
  },
  apply(_state, op) {
    return fail(`math has no op "${op.name}"; use morph to change the expression`);
  },
  size: sizeOf,
  draw(state) {
    const { w, h } = sizeOf(state);
    return [{ id: "expression", kind: "math", x: w / 2, y: h / 2, w, h, latex: state.latex, size: state.size, font: "math", fill: state.role }];
  },
};
