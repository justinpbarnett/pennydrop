import { type Drawable, type LabDef, roleField, stringField } from "../../lab";
import type { Role } from "../../lab";
import { wrapText } from "../text-flow";

interface QuestionState {
  lines: string[];
  kicker: string;
  role: Role;
}

const WIDTH = 1500;
const SIZE = 104;
const LINE_HEIGHT = 128;
const TOP = 190;

export const primitive: LabDef<Record<string, unknown>, QuestionState> = {
  id: "question",
  title: "Ending card",
  reading: "required",
  catalog: {
    summary: "The closing card of a Film: an open question the next Lessons will take up.",
    spec: { question: "the open question as one sentence", kicker: 'small line above, default "An open question"', role: "optional color role, default ink" },
    example: ['{"scene":{"ending":{"kind":"question","question":"What if two programs ask for the same address?"}}}'],
  },
  init(spec, objectId) {
    return {
      lines: wrapText(stringField(spec, "question", objectId), SIZE, "mark", WIDTH - 200),
      kicker: stringField(spec, "kicker", objectId, "An open question"),
      role: roleField(spec, "role", "ink", objectId),
    };
  },
  ops: {},
  size: (state) => ({ w: WIDTH, h: TOP + state.lines.length * LINE_HEIGHT + 150 }),
  draw(state) {
    const bottom = TOP + state.lines.length * LINE_HEIGHT;
    const out: Drawable[] = [
      { id: "kicker", kind: "text", x: WIDTH / 2, y: 80, text: state.kicker.toUpperCase(), size: 40, font: "read", fill: "accent", z: 2 },
      { id: "rule-top", kind: "line", x: WIDTH / 2 - 120, y: 130, x2: WIDTH / 2 + 120, y2: 130, stroke: "edge", strokeWidth: 2, z: 1 },
      { id: "rule-bottom", kind: "line", x: WIDTH / 2 - 120, y: bottom + 60, x2: WIDTH / 2 + 120, y2: bottom + 60, stroke: "edge", strokeWidth: 2, z: 1 },
    ];
    state.lines.forEach((line, index) => out.push({ id: `line-${index}`, kind: "text", x: WIDTH / 2, y: TOP + index * LINE_HEIGHT + LINE_HEIGHT / 2, text: line, size: SIZE, font: "mark", fill: state.role, z: 2 }));
    return out;
  },
};
