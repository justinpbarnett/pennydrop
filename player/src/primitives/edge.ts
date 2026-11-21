import { type Drawable, fail, type Link, type LabDef, type Role, roleField, stringField } from "../lab";

interface EdgeState {
  from: string;
  to: string;
  directed: boolean;
  label: string;
  role: Role;
}

const GAP = 10;

function borderPoint(link: Link, toward: { x: number; y: number }): { x: number; y: number } {
  const center = { x: link.x + link.w / 2, y: link.y + link.h / 2 };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const reach = link.round
    ? 1 / Math.hypot(dx / (link.w / 2), dy / (link.h / 2))
    : Math.min(dx === 0 ? Infinity : link.w / 2 / Math.abs(dx), dy === 0 ? Infinity : link.h / 2 / Math.abs(dy));
  const length = Math.hypot(dx, dy);
  const gapShare = GAP / length;
  return { x: center.x + dx * (reach + gapShare), y: center.y + dy * (reach + gapShare) };
}

export const primitive: LabDef<Record<string, unknown>, EdgeState> = {
  id: "edge",
  title: "Edge",
  overlay: true,
  catalog: {
    summary: "A line or arrow between two other objects that follows them as they move. The connect verb makes one.",
    spec: { from: "object id", to: "object id", directed: "true for an arrow, default false", label: "optional text", role: "color role, default edge" },
    ops: {},
    example: ['{"scene":{"ab":{"kind":"edge","from":"a","to":"b","directed":true}}}'],
  },
  init(spec, objectId) {
    return {
      from: stringField(spec, "from", objectId),
      to: stringField(spec, "to", objectId),
      directed: spec.directed === true,
      label: typeof spec.label === "string" ? spec.label : "",
      role: roleField(spec, "role", "edge", objectId),
    };
  },
  apply(_state, op) {
    return fail(`edge has no op "${op.name}"`);
  },
  size: () => ({ w: 0, h: 0 }),
  draw(state, ctx) {
    const from = ctx.links[state.from];
    const to = ctx.links[state.to];
    if (!from || !to) return [];
    const start = borderPoint(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 });
    const end = borderPoint(to, { x: from.x + from.w / 2, y: from.y + from.h / 2 });
    const out: Drawable[] = [
      { id: "line", kind: state.directed ? "arrow" : "line", x: start.x, y: start.y, x2: end.x, y2: end.y, stroke: state.role, strokeWidth: 1.8, z: -2 },
    ];
    if (state.label) {
      out.push({ id: "label", kind: "text", x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 22, text: state.label, size: 24, font: "read", fill: "muted", z: -1 });
    }
    return out;
  },
};
