import { type Drawable, type Link, type LabDef, labelDrawable, type Point, readsWords, type Role, roleField, segmentDrawable, stringField } from "../lab";

interface EdgeState {
  from: string;
  to: string;
  directed: boolean;
  label: string;
  role: Role;
  reading: boolean;
}

const GAP = 10;

export function borderPoint(link: Link, toward: Point): Point {
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
  reading: "optional",
  overlay: true,
  catalog: {
    summary: "A line or arrow between two other objects that follows them as they move. The connect verb makes one.",
    spec: { from: "object id", to: "object id", directed: "true for an arrow, default false", label: "optional text", role: "color role, default edge" },
    example: ['{"scene":{"ab":{"kind":"edge","from":"a","to":"b","directed":true}}}'],
  },
  ops: {},
  init(spec, objectId) {
    return {
      from: stringField(spec, "from", objectId),
      to: stringField(spec, "to", objectId),
      directed: spec.directed === true,
      label: typeof spec.label === "string" ? spec.label : "",
      role: roleField(spec, "role", "edge", objectId),
      reading: readsWords(spec),
    };
  },
  size: () => ({ w: 0, h: 0 }),
  draw(state, ctx) {
    const from = ctx.links[state.from];
    const to = ctx.links[state.to];
    if (!from || !to) return [];
    const start = borderPoint(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 });
    const end = borderPoint(to, { x: from.x + from.w / 2, y: from.y + from.h / 2 });
    const out: Drawable[] = [{ ...segmentDrawable(state.directed ? "arrow" : "line", start, end, state.role, 1.8, -2), id: "line" }];
    if (state.reading && state.label) out.push(labelDrawable(state.label, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 22 }, 24, "read", "muted", -1));
    return out;
  },
};
