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

const FORMAT_DECIMALS = (value: number) => (String(value).split(".")[1] ?? "").length;

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
      doc: 'ticks a number text up or down: {"to": 12}',
      seconds: 1.0,
      apply: (state, op) => ({ ...state, text: String(numberArg(op.args, "to", "count")) }),
      during(before, after, _op, progress) {
        const from = Number(before.text);
        const to = Number(after.text);
        const decimals = Math.max(FORMAT_DECIMALS(from), FORMAT_DECIMALS(to));
        return firstLine(after, Number.isNaN(from) ? after.text : lerp(from, to, progress).toFixed(decimals));
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
