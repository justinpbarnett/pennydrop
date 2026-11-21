import { fail, type LabDef, numberField, type Role, roleField, stringField } from "../lab";

interface MathState {
  latex: string;
  size: number;
  role: Role;
}

const TALL = /\\(frac|sum|int|sqrt|binom|prod)/;

function sizeOf(state: MathState) {
  const glyphs = state.latex.replace(/\\[a-zA-Z]+/g, "x").replace(/[{}^_]/g, "").length;
  return { w: Math.max(state.size, glyphs * state.size * 0.55), h: state.size * (TALL.test(state.latex) ? 2.4 : 1.5) };
}

export const primitive: LabDef<Record<string, unknown>, MathState> = {
  id: "math",
  title: "Math",
  catalog: {
    summary: "A LaTeX expression typeset with KaTeX.",
    spec: { latex: "LaTeX source such as a^2 + b^2 = c^2", size: "optional px, default 56", role: "optional color role, default ink" },
    ops: {},
    example: ['{"scene":{"eq":{"kind":"math","latex":"\\\\frac{n(n-1)}{2}"}}}'],
  },
  init(spec, objectId) {
    return { latex: stringField(spec, "latex", objectId), size: numberField(spec, "size", 56, objectId), role: roleField(spec, "role", "ink", objectId) };
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
