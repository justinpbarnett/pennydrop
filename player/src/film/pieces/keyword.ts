import { type Drawable, type LabDef, roleField, stringArg, stringField } from "../../lab";
import type { Role } from "../../lab";
import { inkBelow, textWidth } from "../../text-metrics";

interface KeywordState {
  word: string;
  kicker: string;
  role: Role;
}

const WORD_Y = 290;
const RULE_GAP = 50;
const FOOT = 70;
const MAX_WORD_WIDTH = 1500;
const WORD_SIZE = 300;

function wordSize(word: string): number {
  return Math.min(WORD_SIZE, (WORD_SIZE * MAX_WORD_WIDTH) / Math.max(MAX_WORD_WIDTH, textWidth(word, WORD_SIZE, "mark")));
}

function ruleY(word: string): number {
  return WORD_Y + inkBelow(word, wordSize(word), "mark") + RULE_GAP;
}

function widthOf(state: KeywordState): number {
  return Math.max(1100, textWidth(state.word, wordSize(state.word), "mark") + 240);
}

export const primitive: LabDef<Record<string, unknown>, KeywordState> = {
  id: "keyword",
  title: "Key word card",
  reading: "required",
  catalog: {
    summary: "One large word on its own card, with a small line above it. The cold open of a Film, or a term the Film turns on.",
    spec: { word: "the one word or short phrase", kicker: "optional small line above", role: "optional color role, default ink" },
    example: ['{"scene":{"title":{"kind":"keyword","kicker":"Every program was told","word":"Virtual"}}}'],
  },
  init(spec, objectId) {
    return { word: stringField(spec, "word", objectId), kicker: stringField(spec, "kicker", objectId, ""), role: roleField(spec, "role", "ink", objectId) };
  },
  ops: {
    set: {
      doc: 'swaps the word: {"word": "new word"}',
      seconds: 1.2,
      apply: (state, op) => ({ ...state, word: stringArg(op.args, "word", "set") }),
    },
  },
  size: (state) => ({ w: widthOf(state), h: ruleY(state.word) + FOOT }),
  draw(state) {
    const width = widthOf(state);
    const out: Drawable[] = [
      { id: "word", kind: "text", x: width / 2, y: WORD_Y, text: state.word, size: wordSize(state.word), font: "mark", fill: state.role, z: 2 },
      { id: "rule", kind: "line", x: width / 2 - 150, y: ruleY(state.word), x2: width / 2 + 150, y2: ruleY(state.word), stroke: "accent", strokeWidth: 3, z: 1 },
    ];
    if (state.kicker) out.push({ id: "kicker", kind: "text", x: width / 2, y: 62, text: state.kicker.toUpperCase(), size: 38, font: "read", fill: "muted", z: 2 });
    return out;
  },
};
