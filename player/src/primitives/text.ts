import { fail, lerp, type LabDef, numberArg, positiveField, type Role, roleField, stringArg, stringField } from "../lab";
import { textWidth } from "../text-metrics";

interface TextState {
  text: string;
  size: number;
  font: "mark" | "read";
  role: Role;
}

function sizeOf(state: TextState) {
  const lines = state.text.split("\n");
  return { w: Math.max(state.size, ...lines.map((line) => textWidth(line, state.size, state.font))), h: lines.length * state.size * 1.35 };
}

const NUMBER_IN_TEXT = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/;

interface CountedText {
  before: string;
  value: number;
  decimals: number;
  grouped: boolean;
  after: string;
}

function countedText(state: TextState): CountedText {
  const found = NUMBER_IN_TEXT.exec(state.text);
  if (!found) fail(`op "count": the text "${state.text}" holds no number to count from; make the text a number first, such as "0" or "$10.00"`);
  const number = found![0];
  return {
    before: state.text.slice(0, found!.index),
    value: Number(number.replaceAll(",", "")),
    decimals: number.split(".")[1]?.length ?? 0,
    grouped: number.includes(","),
    after: state.text.slice(found!.index + number.length),
  };
}

function countedTo(counted: CountedText, value: number): string {
  const shown = value.toLocaleString("en-US", { minimumFractionDigits: counted.decimals, maximumFractionDigits: counted.decimals, useGrouping: counted.grouped });
  return counted.before + shown + counted.after;
}

function firstLine(after: TextState, shown: string) {
  return [{ id: "line-0", kind: "text" as const, x: sizeOf(after).w / 2, y: after.size * 0.675, text: shown, size: after.size, font: after.font, fill: after.role }];
}

export const primitive: LabDef<Record<string, unknown>, TextState> = {
  id: "text",
  title: "Text",
  reading: "required",
  catalog: {
    summary: "A line or block of text. Use \\n for new lines.",
    spec: { text: "the words", size: "optional px, default 44", font: '"mark" (default, bold display) or "read"', role: "optional color role, default ink" },
    example: ['{"scene":{"title":{"kind":"text","text":"Why O(n²)?","at":"top"}}}'],
  },
  ops: {
    write: {
      doc: 'typewriter: {"text": "full text"}; create the object with "text": "" first so it starts empty',
      seconds: 1.6,
      apply: (state, op) => ({ ...state, text: stringArg(op.args, "text", "write") }),
      during: (_before, after, _op, progress) => firstLine(after, after.text.slice(0, Math.ceil(after.text.length * progress))),
    },
    count: {
      doc: 'ticks the number in a text up or down and keeps what stands around it: {"to": 11} turns "$10.00" into "$11.00"',
      seconds: 1.0,
      apply(state, op) {
        const to = numberArg(op.args, "to", "count");
        const counted = countedText(state);
        return { ...state, text: countedTo({ ...counted, decimals: Math.max(counted.decimals, String(to).split(".")[1]?.length ?? 0) }, to) };
      },
      during(before, after, _op, progress) {
        const [from, to] = [countedText(before), countedText(after)];
        return firstLine(after, countedTo(to, lerp(from.value, to.value, progress)));
      },
    },
  },
  init(spec, objectId) {
    const font = stringField(spec, "font", objectId, "mark");
    if (font !== "mark" && font !== "read") fail(`${objectId}: "font" must be "mark" or "read"`);
    return { text: stringField(spec, "text", objectId), size: positiveField(spec, "size", 44, objectId), font, role: roleField(spec, "role", "ink", objectId) };
  },
  size: sizeOf,
  draw(state) {
    const lines = state.text.split("\n");
    return lines.map((line, index) => ({
      id: `line-${index}`, kind: "text" as const, x: sizeOf(state).w / 2, y: (index + 0.5) * state.size * 1.35,
      text: line, size: state.size, font: state.font, fill: state.role,
    }));
  },
};
