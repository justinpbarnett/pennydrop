import { clamp01, type Drawable, integerArg, type LabDef, type Role, roleField } from "../../lab";

interface Mark {
  year: number;
  label: string;
  level: number;
  role: Role;
}

interface TimelineState {
  from: number;
  to: number;
  marks: Mark[];
  shown: number;
}

const SIZE = { w: 3000, h: 1000 };
const MARGIN = 260;
const END_YEAR_GAP = 70;
const AXIS_Y = 500;
const LEVEL_STEP = 220;
const YEAR_OFFSET = 80;
const LABEL_RISE = 70;
const MARK_SECONDS = 1;

function xOf(state: TimelineState, year: number): number {
  return MARGIN + ((year - state.from) / (state.to - state.from)) * (SIZE.w - 2 * MARGIN);
}

function markDrawables(state: TimelineState, index: number, opacity: number): Drawable[] {
  const mark = state.marks[index]!;
  const x = xOf(state, mark.year);
  const side = mark.level > 0 ? -1 : 1;
  const yearY = AXIS_Y + side * (YEAR_OFFSET + LEVEL_STEP * (Math.abs(mark.level) - 1));
  const latest = index === state.shown - 1;
  const role = latest || mark.role !== "accent" ? mark.role : "muted";
  return [
    { id: `stem-${index}`, kind: "line", x, y: AXIS_Y, x2: x, y2: yearY - side * 38, stroke: role, strokeWidth: 3, opacity, z: 2 },
    { id: `dot-${index}`, kind: "circle", x, y: AXIS_Y, r: latest ? 24 : 16, fill: role, stroke: "ground", strokeWidth: 4, opacity, z: 4 },
    { id: `year-${index}`, kind: "text", x, y: yearY, text: String(mark.year), size: 44, font: "mark", fill: "muted", opacity, z: 3 },
    { id: `label-${index}`, kind: "text", x, y: yearY + side * LABEL_RISE, text: mark.label, size: 64, font: "read", fill: latest ? "ink" : "muted", opacity, z: 3 },
  ];
}

function parseMarks(raw: unknown, objectId: string): Mark[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${objectId}: "marks" must list the dated moments`);
  return raw.map((entry, position) => {
    const item = entry as Record<string, unknown>;
    if (typeof item.year !== "number" || typeof item.label !== "string") throw new Error(`${objectId}: marks[${position}] needs a numeric "year" and a text "label"`);
    const level = typeof item.level === "number" ? item.level : position % 2 === 0 ? 1 : -1;
    if (!Number.isInteger(level) || level === 0 || Math.abs(level) > 2) throw new Error(`${objectId}: marks[${position}] "level" must be 1, 2, -1 or -2`);
    return { year: item.year, label: item.label, level, role: roleField(item, "role", "accent", objectId) };
  });
}

export const primitive: LabDef<Record<string, unknown>, TimelineState> = {
  id: "timeline",
  title: "Timeline",
  reading: "required",
  catalog: {
    summary: "A line of years with dated moments that appear one by one. The camera can return to it as the story moves on.",
    spec: {
      from: "first year on the line",
      to: "last year on the line",
      marks: 'the moments in time order: [{"year": 1793, "label": "Toulon", "level": 1, "role": "accent"}]; level 1 or 2 puts the label above the line, -1 or -2 below it, so close years do not collide',
    },
    example: ['{"scene":{"years":{"kind":"timeline","from":1785,"to":1804,"marks":[{"year":1793,"label":"Toulon"},{"year":1794,"label":"Arrested","level":-1,"role":"warn"}]}},"do":[{"cue":"Toulon","op":"mark","on":["years"],"to":1}]}'],
  },
  init(spec, objectId) {
    const from = spec.from;
    const to = spec.to;
    if (typeof from !== "number" || typeof to !== "number" || to <= from) throw new Error(`${objectId}: "from" and "to" must be years, with "to" after "from"`);
    const marks = parseMarks(spec.marks, objectId);
    if (marks.some((mark) => mark.year < from || mark.year > to)) throw new Error(`${objectId}: every mark year must lie between ${from} and ${to}`);
    return { from, to, marks, shown: 0 };
  },
  ops: {
    mark: {
      doc: 'shows the moments up to a count and lights the latest: {"to": 3} shows the first three',
      seconds: MARK_SECONDS,
      apply: (state, op) => ({ ...state, shown: integerArg(op.args, "to", "mark", 0, state.marks.length) }),
      during: (_before, after, _op, progress) => (after.shown > 0 ? markDrawables(after, after.shown - 1, clamp01(progress)) : []),
    },
  },
  size: () => SIZE,
  unfilled: (state) => state.shown === 0,
  draw(state) {
    const out: Drawable[] = [{ id: "axis", kind: "line", x: MARGIN - 40, y: AXIS_Y, x2: SIZE.w - MARGIN + 40, y2: AXIS_Y, stroke: "edge", strokeWidth: 5, z: 1 }];
    for (let year = state.from; year <= state.to; year += 1) {
      const major = year % 5 === 0 || year === state.from || year === state.to;
      const x = xOf(state, year);
      out.push({ id: `tick-${year}`, kind: "line", x, y: AXIS_Y - (major ? 22 : 11), x2: x, y2: AXIS_Y + (major ? 22 : 11), stroke: "edge", strokeWidth: 3, z: 1 });
    }
    out.push(
      { id: "from-year", kind: "text", x: MARGIN - END_YEAR_GAP, y: AXIS_Y, text: String(state.from), size: 44, font: "mark", anchor: "end", fill: "muted", z: 3 },
      { id: "to-year", kind: "text", x: SIZE.w - MARGIN + END_YEAR_GAP, y: AXIS_Y, text: String(state.to), size: 44, font: "mark", anchor: "start", fill: "muted", z: 3 },
    );
    for (let index = 0; index < state.shown; index += 1) out.push(...markDrawables(state, index, 1));
    return out;
  },
};
