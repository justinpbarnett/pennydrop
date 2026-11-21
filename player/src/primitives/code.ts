import { type Drawable, fail, indexPart, type LabDef, type LabOp, numberField, stringField, type Span } from "../lab";
import { CODE_LANGUAGES, tokenizeCode } from "../highlight";
import { textWidth } from "../text-metrics";

interface CodeState {
  objectId: string;
  lines: Span[][];
  size: number;
  focus: number[];
}

const PAD = 30;
const DIMMED = 0.36;

function focusFrom(state: CodeState, value: unknown): number[] {
  const toLines = (entry: unknown): number[] => {
    if (typeof entry === "number") return [indexPart(String(entry - 1), state.lines.length, state.objectId, "lines") + 1];
    if (typeof entry === "string") {
      const range = /^(\d+)(?:-(\d+))?$/.exec(entry);
      if (!range) fail(`${state.objectId}: "${entry}" is not a line or range such as 3 or 3-5`);
      const from = Number(range![1]);
      const to = Number(range![2] ?? range![1]);
      indexPart(String(from - 1), state.lines.length, state.objectId, "lines");
      indexPart(String(to - 1), state.lines.length, state.objectId, "lines");
      return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
    }
    return fail(`${state.objectId}: focus lines must be numbers or ranges like "3-5"`);
  };
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap(toLines);
}

function lineHeight(state: CodeState): number {
  return state.size * 1.7;
}

const NUMBER_SCALE = 0.72;
const NUMBER_GAP = 22;

function gutterWidth(state: CodeState): number {
  return textWidth(String(state.lines.length), state.size * NUMBER_SCALE, "code") + NUMBER_GAP;
}

function sizeOf(state: CodeState) {
  const widest = Math.max(...state.lines.map((line) => textWidth(line.map((span) => span.text).join(""), state.size, "code")), 0);
  return { w: PAD * 2 + gutterWidth(state) + widest, h: PAD * 2 + state.lines.length * lineHeight(state) };
}

export const primitive: LabDef<Record<string, unknown>, CodeState> = {
  id: "code",
  title: "Code",
  catalog: {
    summary: "Syntax highlighted source with line numbers and a moving focus bar. Parts are line numbers: code[3] or code[3-5].",
    spec: {
      source: "the code, with \\n between lines",
      language: `one of ${CODE_LANGUAGES.join(", ")}, default python`,
      size: "optional px, default 30",
      focus: "optional line number, list or range such as [3,4] that starts focused",
    },
    ops: { focus: 'on code[3] or code[3-5], or {"lines": [3,4]}; moves the focus bar; {"lines": null} clears it' },
    example: ['{"scene":{"code":{"kind":"code","language":"python","source":"for i in range(n):\\n    print(i)","focus":1}}}'],
  },
  init(spec, objectId) {
    const language = stringField(spec, "language", objectId, "python");
    if (!CODE_LANGUAGES.includes(language)) fail(`${objectId}: language "${language}" is not available; use one of ${CODE_LANGUAGES.join(", ")}`);
    const source = stringField(spec, "source", objectId);
    const base: CodeState = { objectId, lines: tokenizeCode(source, language), size: numberField(spec, "size", 30, objectId), focus: [] };
    return { ...base, focus: focusFrom(base, spec.focus) };
  },
  apply(state, op: LabOp) {
    if (op.name !== "focus") fail(`code has no op "${op.name}"`);
    return { ...state, focus: focusFrom(state, op.parts.length > 0 ? op.parts : op.args.lines) };
  },
  size: sizeOf,
  draw(state) {
    const { w, h } = sizeOf(state);
    const height = lineHeight(state);
    const hasFocus = state.focus.length > 0;
    const first = hasFocus ? Math.min(...state.focus) : 1;
    const last = hasFocus ? Math.max(...state.focus) : 1;
    const barTop = PAD + (first - 1) * height;
    const barHeight = (last - first + 1) * height;
    const out: Drawable[] = [
      { id: "panel", kind: "rect", x: w / 2, y: h / 2, w, h, fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1, z: 0 },
      { id: "bar", kind: "rect", x: w / 2, y: barTop + barHeight / 2, w: w - 2, h: barHeight, fill: "active", opacity: hasFocus ? 0.16 : 0, z: 1 },
      { id: "marker", kind: "rect", x: 3, y: barTop + barHeight / 2, w: 6, h: barHeight, fill: "active", opacity: hasFocus ? 1 : 0, z: 1 },
    ];
    state.lines.forEach((spans, index) => {
      const y = PAD + (index + 0.5) * height;
      const opacity = !hasFocus || state.focus.includes(index + 1) ? 1 : DIMMED;
      out.push(
        { id: `number-${index + 1}`, kind: "text", x: PAD, y, text: String(index + 1), size: state.size * NUMBER_SCALE, font: "code", anchor: "start", fill: "muted", opacity, z: 2 },
        { id: `line-${index + 1}`, kind: "code", x: PAD + gutterWidth(state), y, spans: spans.length ? spans : [{ text: " ", role: "ink" }], size: state.size, font: "code", anchor: "start", opacity, z: 2 },
      );
    });
    return out;
  },
  duration: () => 0.6,
};
