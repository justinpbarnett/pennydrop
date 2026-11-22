import { clamp01, type Drawable, integerArg, type LabDef, type Role, roleField, stringField } from "../../lab";
import { wrapText } from "../text-flow";

interface Side {
  head: string;
  lines: string[];
}

interface CompareState {
  title: string;
  held: Side;
  broke: Side;
  roles: { held: Role; broke: Role };
  shown: number;
}

const WIDTH = 3000;
const CARD = 1380;
const GAP = 120;
const TITLE_Y = 120;
const CARD_TOP = 260;
const HEAD_SIZE = 76;
const BODY_SIZE = 66;
const BODY_LINE = 92;
const PADDING = 70;
const BODY_ROOM = 6;
const SHOW_SECONDS = 1;

function side(spec: Record<string, unknown>, key: string, objectId: string): Side {
  const raw = spec[key] as Record<string, unknown> | undefined;
  if (!raw || typeof raw.head !== "string" || typeof raw.text !== "string") throw new Error(`${objectId}: "${key}" needs {"head": ..., "text": ...}`);
  const lines = wrapText(raw.text, BODY_SIZE, "read", CARD - 2 * PADDING);
  if (lines.length > BODY_ROOM) throw new Error(`${objectId}: "${key}" text wraps to ${lines.length} lines; keep it to ${BODY_ROOM}`);
  return { head: raw.head, lines };
}

function heightOf(state: CompareState): number {
  const rows = Math.max(state.held.lines.length, state.broke.lines.length);
  return CARD_TOP + 2 * PADDING + HEAD_SIZE + 40 + rows * BODY_LINE;
}

function cardDrawables(state: CompareState, key: "held" | "broke", opacity: number): Drawable[] {
  const content = state[key];
  const left = key === "held" ? 0 : CARD + GAP;
  const role = state.roles[key];
  const height = heightOf(state) - CARD_TOP;
  const out: Drawable[] = [
    { id: `${key}-card`, kind: "rect", x: left + CARD / 2, y: CARD_TOP + height / 2, w: CARD, h: height, radius: 28, fill: "fill", stroke: role, strokeWidth: 5, opacity, z: 1 },
    { id: `${key}-head`, kind: "text", x: left + PADDING, y: CARD_TOP + PADDING + HEAD_SIZE / 2, text: content.head, size: HEAD_SIZE, font: "mark", anchor: "start", fill: role, opacity, z: 3 },
  ];
  content.lines.forEach((line, index) => out.push({ id: `${key}-line-${index}`, kind: "text", x: left + PADDING, y: CARD_TOP + PADDING + HEAD_SIZE + 40 + index * BODY_LINE + BODY_LINE / 2, text: line, size: BODY_SIZE, font: "read", anchor: "start", fill: "ink", opacity, z: 3 }));
  return out;
}

export const primitive: LabDef<Record<string, unknown>, CompareState> = {
  id: "compare",
  title: "Held and broke",
  reading: "required",
  catalog: {
    summary: "Two cards side by side under one title: where an idea held, and where it breaks.",
    spec: { title: "the idea being tested", held: '{"head": "Held at Toulon", "text": "short sentence"}', broke: '{"head": "Breaks on sponsors", "text": "short sentence"}', heldRole: "optional color role of the first card, default ok", brokeRole: "optional color role of the second card, default warn" },
    example: ['{"scene":{"test":{"kind":"compare","title":"Tactic one","held":{"head":"Held","text":"A plan solved it."},"broke":{"head":"Breaks","text":"Nobody let him act."}}},"do":[{"cue":"held","op":"show","on":["test"],"to":1}]}'],
  },
  init(spec, objectId) {
    return { title: stringField(spec, "title", objectId), held: side(spec, "held", objectId), broke: side(spec, "broke", objectId), roles: { held: roleField(spec, "heldRole", "ok", objectId), broke: roleField(spec, "brokeRole", "warn", objectId) }, shown: 0 };
  },
  ops: {
    show: {
      doc: 'reveals the cards: {"to": 1} shows the held card, {"to": 2} adds the one that breaks',
      seconds: SHOW_SECONDS,
      apply: (state, op) => ({ ...state, shown: integerArg(op.args, "to", "show", 0, 2) }),
      during: (_before, after, _op, progress) => (after.shown === 0 ? [] : cardDrawables(after, after.shown === 1 ? "held" : "broke", clamp01(progress))),
    },
  },
  size: (state) => ({ w: WIDTH, h: heightOf(state) }),
  draw(state) {
    const out: Drawable[] = [
      { id: "title", kind: "text", x: WIDTH / 2, y: TITLE_Y, text: state.title, size: 96, font: "mark", fill: "ink", z: 2 },
      { id: "rule", kind: "line", x: WIDTH / 2 - 200, y: TITLE_Y + 80, x2: WIDTH / 2 + 200, y2: TITLE_Y + 80, stroke: "edge", strokeWidth: 2, z: 1 },
    ];
    if (state.shown >= 1) out.push(...cardDrawables(state, "held", 1));
    if (state.shown >= 2) out.push(...cardDrawables(state, "broke", 1));
    return out;
  },
};
