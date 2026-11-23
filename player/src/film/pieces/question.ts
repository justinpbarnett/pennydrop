import { type Drawable, type LabDef, roleField, stringField } from "../../lab";
import type { Role } from "../../lab";
import type { Theme } from "../../theme";
import { spokenSeconds, wrapText, writtenLine, writtenShares } from "../text-flow";

interface QuestionState {
  lines: string[];
  kicker: string;
  role: Role;
  written: boolean;
}

const WIDTH = 1500;
const SIZE = 104;
const LINE_HEIGHT = 128;
const TOP = 190;

function card(state: QuestionState, progress: number, theme: Theme | undefined): Drawable[] {
  const bottom = TOP + state.lines.length * LINE_HEIGHT;
  const shares = writtenShares(state.lines, progress);
  return [
    { id: "kicker", kind: "text", x: WIDTH / 2, y: 80, text: state.kicker.toUpperCase(), size: 40, font: "read", fill: "accent", z: 2 },
    { id: "rule-top", kind: "line", x: WIDTH / 2 - 120, y: 130, x2: WIDTH / 2 + 120, y2: 130, stroke: "edge", strokeWidth: 2, z: 1 },
    { id: "rule-bottom", kind: "line", x: WIDTH / 2 - 120, y: bottom + 60, x2: WIDTH / 2 + 120, y2: bottom + 60, stroke: "edge", strokeWidth: 2, z: 1 },
    ...state.lines.flatMap((line, index) =>
      writtenLine({ id: `line-${index}`, kind: "text", x: WIDTH / 2, y: TOP + index * LINE_HEIGHT + LINE_HEIGHT / 2, text: line, size: SIZE, font: "mark", fill: state.role, z: 2 }, shares[index]!, theme),
    ),
  ];
}

export const primitive: LabDef<Record<string, unknown>, QuestionState> = {
  id: "question",
  title: "Ending card",
  reading: "required",
  concurrentParts: true,
  catalog: {
    summary: "The closing card of a Film: an open question the next Lessons will take up. It waits blank until its write op writes the question on as the narration reads it.",
    spec: { question: "the open question as one sentence, worded as the narration reads it", kicker: 'small line above, default "An open question"', role: "optional color role, default ink" },
    example: ['{"scene":{"ending":{"kind":"question","question":"What if two programs ask for the same address?"}},"do":[{"cue":"What if two programs","op":"write","on":["ending"]}]}'],
  },
  init(spec, objectId) {
    return {
      lines: wrapText(stringField(spec, "question", objectId), SIZE, "mark", WIDTH - 200),
      kicker: stringField(spec, "kicker", objectId, "An open question"),
      role: roleField(spec, "role", "ink", objectId),
      written: false,
    };
  },
  ops: {
    write: {
      doc: "writes the question on at the pace the narration reads it: cue it on the first word the narration reads from the card",
      seconds: (_op, state) => spokenSeconds(state.lines),
      apply: (state) => ({ ...state, written: true }),
      trueTime: true,
    },
  },
  size: (state) => ({ w: WIDTH, h: TOP + state.lines.length * LINE_HEIGHT + 150 }),
  unfilled: (state) => !state.written,
  draw: (state, ctx) => card(state, state.written ? 1 : 0, ctx.theme),
  live: (state, running, ctx) => card(state, running.find((run) => run.op.name === "write")?.progress ?? (state.written ? 1 : 0), ctx.theme),
};
