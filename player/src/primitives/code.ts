import { type Drawable, fail, indexPart, type LabDef, positiveField, stringField, type Span } from "../lab";
import { CODE_LANGUAGES, codeListing, languageField, loadHighlighter, NUMBER_SCALE, tokenizeCode } from "../highlight";
import { textWidth } from "../text-metrics";

interface CodeState {
  objectId: string;
  lines: Span[][];
  size: number;
  focus: number[];
}

const PAD = 30;
const DIMMED = 0.36;
const NUMBER_GAP = 22;

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
  reading: "required",
  catalog: {
    summary: "Syntax highlighted source with line numbers and a moving focus bar. Parts are line numbers: code[3] or code[3-5].",
    spec: {
      source: "the code, with \\n between lines",
      language: `one of ${CODE_LANGUAGES.join(", ")}, default python`,
      size: "optional px, default 30",
      focus: "optional line number, list or range such as [3,4] that starts focused",
    },
    example: ['{"scene":{"code":{"kind":"code","language":"python","source":"for i in range(n):\\n    print(i)","focus":1}}}'],
  },
  ops: {
    focus: {
      doc: 'on code[3] or code[3-5], or {"lines": [3,4]}; moves the focus bar; {"lines": null} clears it',
      seconds: 0.6,
      apply: (state, op) => ({ ...state, focus: focusFrom(state, op.parts.length > 0 ? op.parts : op.args.lines) }),
    },
  },
  prepare: loadHighlighter,
  init(spec, objectId) {
    const language = languageField(spec, objectId);
    const source = stringField(spec, "source", objectId);
    const base: CodeState = { objectId, lines: tokenizeCode(source, language), size: positiveField(spec, "size", 30, objectId), focus: [] };
    return { ...base, focus: focusFrom(base, spec.focus) };
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
    const panel: Drawable[] = [
      { id: "panel", kind: "rect", x: w / 2, y: h / 2, w, h, fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1, z: 0 },
      { id: "bar", kind: "rect", x: w / 2, y: barTop + barHeight / 2, w: w - 2, h: barHeight, fill: "active", opacity: hasFocus ? 0.16 : 0, z: 1 },
      { id: "marker", kind: "rect", x: 3, y: barTop + barHeight / 2, w: 6, h: barHeight, fill: "active", opacity: hasFocus ? 1 : 0, z: 1 },
    ];
    const listing = codeListing(state.lines, {
      left: PAD,
      top: PAD,
      size: state.size,
      lineHeight: height,
      gutter: gutterWidth(state),
      opacityOf: (line) => (!hasFocus || state.focus.includes(line) ? 1 : DIMMED),
    });
    return [...panel, ...listing];
  },
};
