import { type Drawable, type LabDef, roleField, stringField } from "../../lab";
import type { Role } from "../../lab";
import { wrapText } from "../text-flow";

interface QuoteState {
  lines: string[];
  by: string[];
  role: Role;
}

const WIDTH = 1500;
const TEXT_LEFT = 190;
const TEXT_SIZE = 72;
const LINE_HEIGHT = 96;
const TOP = 130;
const TEXT_ROOM = 1000;
const BY_ROOM = WIDTH - TEXT_LEFT - 110;
const BY_SIZE = 42;
const BY_LINE = 56;
const BY_GAP = 62;

function heightOf(state: QuoteState): number {
  return TOP + state.lines.length * LINE_HEIGHT + (state.by.length ? 170 + (state.by.length - 1) * BY_LINE : 90);
}

export const primitive: LabDef<Record<string, unknown>, QuoteState> = {
  id: "quote",
  title: "Quote card",
  reading: "required",
  catalog: {
    summary: "A short quotation, large, with who said it. Only words a person said or wrote, as a source records them; a term, a paraphrase or the Film's own question goes on another piece. The code wraps the lines.",
    spec: { text: "the quotation without quote marks", by: "optional who said it", role: "optional color role, default ink" },
    example: ['{"scene":{"saying":{"kind":"quote","text":"Premature optimization is the root of all evil.","by":"Donald Knuth"}}}'],
  },
  init(spec, objectId) {
    const by = stringField(spec, "by", objectId, "");
    return {
      lines: wrapText(stringField(spec, "text", objectId), TEXT_SIZE, "read", TEXT_ROOM),
      by: by ? wrapText(`– ${by}`, BY_SIZE, "mark", BY_ROOM) : [],
      role: roleField(spec, "role", "ink", objectId),
    };
  },
  ops: {},
  size: (state) => ({ w: WIDTH, h: heightOf(state) }),
  draw(state) {
    const out: Drawable[] = [
      { id: "mark", kind: "text", x: 70, y: 150, text: "“", size: 320, font: "mark", anchor: "start", fill: "accent", opacity: 0.85, z: 1 },
      { id: "bar", kind: "line", x: 150, y: TOP - 20, x2: 150, y2: TOP + state.lines.length * LINE_HEIGHT - 20, stroke: "edge", strokeWidth: 2, z: 1 },
    ];
    state.lines.forEach((line, index) => out.push({ id: `line-${index}`, kind: "text", x: TEXT_LEFT, y: TOP + index * LINE_HEIGHT + LINE_HEIGHT / 2, text: line, size: TEXT_SIZE, font: "read", anchor: "start", fill: state.role, z: 2 }));
    state.by.forEach((line, index) => out.push({ id: `by-${index}`, kind: "text", x: TEXT_LEFT, y: TOP + state.lines.length * LINE_HEIGHT + BY_GAP + index * BY_LINE, text: line, size: BY_SIZE, font: "mark", anchor: "start", fill: "accent", z: 2 }));
    return out;
  },
};
