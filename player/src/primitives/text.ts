import { fail, lerp, type LabDef, numberArg, numberField, type Role, roleField, stringArg, stringField, textWidth } from "../lab";

interface TextState {
  text: string;
  size: number;
  font: "mark" | "read";
  role: Role;
}

const FORMAT_DECIMALS = (value: number) => (String(value).split(".")[1] ?? "").length;

export const primitive: LabDef<Record<string, unknown>, TextState> = {
  id: "text",
  title: "Text",
  catalog: {
    summary: "A line or block of text. Use \\n for new lines.",
    spec: { text: "the words", size: "optional px, default 44", font: '"mark" (default, bold display) or "read"', role: "optional color role, default ink" },
    ops: {
      write: 'typewriter: {"text": "full text"}; create the object with "text": "" first so it starts empty',
      count: 'ticks a number text up or down: {"to": 12}',
    },
    example: ['{"scene":{"title":{"kind":"text","text":"Why O(n²)?","at":"top"}}}'],
  },
  init(spec, objectId) {
    const font = stringField(spec, "font", objectId, "mark");
    if (font !== "mark" && font !== "read") fail(`${objectId}: "font" must be "mark" or "read"`);
    return { text: stringField(spec, "text", objectId), size: numberField(spec, "size", 44, objectId), font, role: roleField(spec, "role", "ink", objectId) };
  },
  apply(state, op) {
    if (op.name === "write") return { ...state, text: stringArg(op.args, "text", "write") };
    if (op.name === "count") return { ...state, text: String(numberArg(op.args, "to", "count")) };
    return fail(`text has no op "${op.name}"`);
  },
  size(state) {
    const lines = state.text.split("\n");
    return { w: Math.max(state.size, ...lines.map((line) => textWidth(line, state.size))), h: lines.length * state.size * 1.35 };
  },
  draw(state) {
    const lines = state.text.split("\n");
    return lines.map((line, index) => ({
      id: `line-${index}`, kind: "text" as const, x: this.size(state).w / 2, y: (index + 0.5) * state.size * 1.35,
      text: line, size: state.size, font: state.font, fill: state.role,
    }));
  },
  duration: (op) => (op.name === "write" ? 1.6 : 1.0),
  during(before, after, op, progress) {
    const shown = op.name === "write"
      ? after.text.slice(0, Math.ceil(after.text.length * progress))
      : (() => {
          const from = Number(before.text);
          const to = Number(after.text);
          const decimals = Math.max(FORMAT_DECIMALS(from), FORMAT_DECIMALS(to));
          return Number.isNaN(from) ? after.text : lerp(from, to, progress).toFixed(decimals);
        })();
    return [{ id: "line-0", kind: "text", x: this.size(after).w / 2, y: after.size * 0.675, text: shown, size: after.size, font: after.font, fill: after.role }];
  },
};
