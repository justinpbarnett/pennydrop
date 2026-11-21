import { CODE_LANGUAGES, tokenizeCode } from "../highlight";
import { type Drawable, fail, labelDrawable, type LabDef, type LabOp, type Paint, type Rect, segmentDrawable, type Span, stringArg, stringField } from "../lab";
import { textWidth } from "../text-metrics";

interface Variable {
  name: string;
  value: string | null;
}

interface Frame {
  label: string;
  variables: Variable[];
  changed: string | null;
}

interface Returned {
  function: string;
  value: string | null;
}

interface CodeStepperState {
  lines: Span[][];
  declared: string[];
  frames: Frame[];
  currentLine: number | null;
  output: string[];
  returned: Returned | null;
}

interface CodeStepperSpec extends Record<string, unknown> {
  source: unknown;
  language?: unknown;
  vars?: unknown;
}

const WIDTH = 1480;
const HEIGHT = 720;
const GAP = 24;
const SOURCE_WIDTH = 700;
const RIGHT_X = SOURCE_WIDTH + GAP;
const TOP_HEIGHT = 420;
const STACK_WIDTH = 300;
const VARIABLES_X = RIGHT_X + STACK_WIDTH + GAP;
const OUTPUT_Y = TOP_HEIGHT + GAP;
const PANEL_PAD = 18;
const HEADER_HEIGHT = 52;
const HEADER_SIZE = 20;
const SOURCE_PAD = 22;
const MAX_CODE_SIZE = 28;
const MIN_CODE_SIZE = 18;
const LINE_HEIGHT_PER_SIZE = 1.5;
const NUMBER_SCALE = 0.72;
const NUMBER_GAP = 18;
const MAX_VARIABLES = 12;
const MAX_ROW_HEIGHT = 46;
const OUTPUT_LINES = 8;
const BAND_OPACITY = 0.16;
const GLOBAL_FRAME = "global";
const UNSET = "–";
const ELLIPSIS = "…";
const CARD_GAP = 8;
const MAX_CARD_HEIGHT = 64;
const MIN_CARD_HEIGHT = 34;
const FOOTER_HEIGHT = 40;

const PANELS: Record<"source" | "stack" | "variables" | "output", Rect> = {
  source: { x: 0, y: 0, w: SOURCE_WIDTH, h: HEIGHT },
  stack: { x: RIGHT_X, y: 0, w: STACK_WIDTH, h: TOP_HEIGHT },
  variables: { x: VARIABLES_X, y: 0, w: WIDTH - VARIABLES_X, h: TOP_HEIGHT },
  output: { x: RIGHT_X, y: OUTPUT_Y, w: WIDTH - RIGHT_X, h: HEIGHT - OUTPUT_Y },
};

const PANEL_TITLES = { stack: "Call stack", variables: "Variables", output: "Output" } as const;

function fitted(text: string, size: number, width: number): string {
  if (textWidth(text, size, "code") <= width) return text;
  let kept = text.length;
  while (kept > 0 && textWidth(text.slice(0, kept) + ELLIPSIS, size, "code") > width) kept -= 1;
  return text.slice(0, kept) + ELLIPSIS;
}

function fittedSpans(spans: Span[], size: number, width: number): Span[] {
  const text = spans.map((span) => span.text).join("");
  if (textWidth(text, size, "code") <= width) return spans;
  const kept = fitted(text, size, width).length - ELLIPSIS.length;
  const out: Span[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= kept) break;
    out.push({ ...span, text: span.text.slice(0, kept - used) });
    used += span.text.length;
  }
  return [...out, { text: ELLIPSIS, role: "muted" }];
}

function valueArg(args: Record<string, unknown>, key: string, opName: string): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fail(`op "${opName}" needs "${key}" as text such as "3" or "[1, 2]" (the repr of the value)`);
}

function optionalValueArg(args: Record<string, unknown>, key: string, opName: string): string | null {
  return args[key] === undefined || args[key] === null ? null : valueArg(args, key, opName);
}

function readLanguage(spec: CodeStepperSpec, objectId: string): string {
  const language = stringField(spec, "language", objectId, "python");
  if (!CODE_LANGUAGES.includes(language)) fail(`${objectId}: language "${language}" is not available; use one of ${CODE_LANGUAGES.join(", ")}`);
  return language;
}

function readDeclared(vars: unknown, objectId: string): string[] {
  if (vars === undefined) return [];
  if (!Array.isArray(vars) || vars.some((name) => typeof name !== "string" || name === "")) fail(`${objectId}: "vars" must be a list of variable names such as ["n", "result"]`);
  return vars as string[];
}

function newFrame(label: string, declared: string[], args: Record<string, string> = {}): Frame {
  const names = [...new Set([...declared, ...Object.keys(args)])];
  return { label, variables: names.map((name) => ({ name, value: args[name] ?? null })), changed: null };
}

function readCallArgs(args: unknown): Record<string, string> {
  if (args === undefined) return {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) return fail('op "call" arg "args" must be a map of parameter name to value text, such as {"n": "3"}');
  return Object.fromEntries(Object.keys(args).map((name) => [name, valueArg(args as Record<string, unknown>, name, "call")]));
}

function callLabel(name: string, args: Record<string, string>): string {
  return `${name}(${Object.entries(args).map(([parameter, value]) => `${parameter}=${value}`).join(", ")})`;
}

function topFrame(state: CodeStepperState): Frame {
  return state.frames[state.frames.length - 1]!;
}

function withTopFrame(state: CodeStepperState, frame: Frame): CodeStepperState {
  return { ...state, frames: [...state.frames.slice(0, -1), frame] };
}

function writeVariable(frame: Frame, name: string, value: string): Frame {
  const exists = frame.variables.some((variable) => variable.name === name);
  if (!exists && frame.variables.length >= MAX_VARIABLES) fail(`frame ${frame.label} already shows ${MAX_VARIABLES} variables; the table has no room for "${name}"`);
  const variables = exists ? frame.variables.map((variable) => (variable.name === name ? { name, value } : variable)) : [...frame.variables, { name, value }];
  return { ...frame, variables, changed: name };
}

function codeMetrics(lines: Span[][]) {
  const innerHeight = HEIGHT - SOURCE_PAD * 2;
  const widest = Math.max(...lines.map((line) => textWidth(line.map((span) => span.text).join(""), 1, "code")), 1);
  const gutterPerSize = textWidth(String(lines.length), NUMBER_SCALE, "code");
  const byHeight = innerHeight / lines.length / LINE_HEIGHT_PER_SIZE;
  const byWidth = (SOURCE_WIDTH - SOURCE_PAD * 2 - NUMBER_GAP - 8) / (widest + gutterPerSize);
  const size = Math.min(MAX_CODE_SIZE, byHeight, Math.max(byWidth, MIN_CODE_SIZE));
  const gutter = gutterPerSize * size + NUMBER_GAP;
  return { size, gutter, lineWidth: SOURCE_WIDTH - SOURCE_PAD * 2 - gutter, lineHeight: Math.min(size * LINE_HEIGHT_PER_SIZE, innerHeight / lines.length) };
}

function boxDrawable(id: string, rect: Rect, fill: Paint, stroke: Paint, z: number, extras: Partial<Drawable> = {}): Drawable {
  return { id, kind: "rect", x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: rect.w, h: rect.h, fill, stroke, strokeWidth: 1, radius: 1, z, ...extras };
}

function textDrawable(id: string, text: string, x: number, y: number, size: number, fill: Paint, extras: Partial<Drawable> = {}): Drawable {
  return { ...labelDrawable(text, { x, y }, size, "code", fill, 2), id, anchor: "start", ...extras };
}

function panelDrawables(key: keyof typeof PANEL_TITLES, trailing?: string): Drawable[] {
  const rect = PANELS[key];
  const header = labelDrawable(PANEL_TITLES[key], { x: rect.x + PANEL_PAD, y: rect.y + HEADER_HEIGHT / 2 }, HEADER_SIZE, "mark", "muted", 2);
  const out: Drawable[] = [
    boxDrawable(`${key}-panel`, rect, "fill", "rule", 0),
    { ...header, id: `${key}-title`, anchor: "start" },
    { ...segmentDrawable("line", { x: rect.x + PANEL_PAD, y: rect.y + HEADER_HEIGHT }, { x: rect.x + rect.w - PANEL_PAD, y: rect.y + HEADER_HEIGHT }, "rule", 1, 1), id: `${key}-rule` },
  ];
  if (trailing) out.push(textDrawable(`${key}-trailing`, trailing, rect.x + rect.w - PANEL_PAD, rect.y + HEADER_HEIGHT / 2, HEADER_SIZE - 2, "muted", { anchor: "end" }));
  return out;
}

function bandDrawable(id: string, panel: Rect, y: number, height: number, opacity: number): Drawable {
  return boxDrawable(id, { x: panel.x + 1, y: y - height / 2, w: panel.w - 2, h: height }, "active", "none", 1, { opacity, radius: 0 });
}

function sourceDrawables(state: CodeStepperState): Drawable[] {
  const { size, lineHeight, gutter, lineWidth } = codeMetrics(state.lines);
  const lineY = (line: number) => SOURCE_PAD + (line - 0.5) * lineHeight;
  const marked = state.currentLine !== null;
  const barY = lineY(state.currentLine ?? 1);
  const out: Drawable[] = [
    boxDrawable("source-panel", PANELS.source, "fill", "rule", 0),
    bandDrawable("line-bar", PANELS.source, barY, lineHeight, marked ? BAND_OPACITY : 0),
    boxDrawable("line-marker", { x: 1, y: barY - lineHeight / 2, w: 6, h: lineHeight }, "active", "none", 1, { opacity: marked ? 1 : 0, radius: 0 }),
  ];
  state.lines.forEach((spans, index) => {
    const y = lineY(index + 1);
    out.push(
      textDrawable(`number-${index + 1}`, String(index + 1), SOURCE_PAD, y, size * NUMBER_SCALE, "muted"),
      { id: `line-${index + 1}`, kind: "code", x: SOURCE_PAD + gutter, y, spans: spans.length ? fittedSpans(spans, size, lineWidth) : [{ text: " ", role: "ink" }], size, font: "code", anchor: "start", z: 2 },
    );
  });
  return out;
}

function variableRowGeometry(frame: Frame) {
  const rect = PANELS.variables;
  const top = rect.y + HEADER_HEIGHT + 12;
  const rowHeight = Math.min(MAX_ROW_HEIGHT, (rect.h - HEADER_HEIGHT - 12 - PANEL_PAD) / Math.max(frame.variables.length, 1));
  const size = Math.min(26, rowHeight * 0.58);
  const inner = rect.w - PANEL_PAD * 2;
  const nameWidth = inner * 0.36;
  return { top, rowHeight, size, left: rect.x + PANEL_PAD, inner, nameWidth };
}

function variableRowY(frame: Frame, index: number): number {
  const { top, rowHeight } = variableRowGeometry(frame);
  return top + (index + 0.5) * rowHeight;
}

function variableDrawables(state: CodeStepperState): Drawable[] {
  const frame = topFrame(state);
  const { rowHeight, size, left, inner, nameWidth } = variableRowGeometry(frame);
  const out = panelDrawables("variables", frame.label === GLOBAL_FRAME ? undefined : fitted(frame.label, HEADER_SIZE - 2, PANELS.variables.w * 0.5));
  if (frame.variables.length === 0) out.push(textDrawable("variables-empty", "nothing yet", left, variableRowY(frame, 0), size, "muted"));
  frame.variables.forEach((variable, index) => {
    const y = variableRowY(frame, index);
    const changed = frame.changed === variable.name;
    const unset = variable.value === null;
    const valueWidth = inner - nameWidth - 12;
    if (changed) out.push(bandDrawable(`row-${variable.name}-tint`, PANELS.variables, y, rowHeight, BAND_OPACITY));
    out.push(
      textDrawable(`row-${variable.name}-name`, fitted(variable.name, size, nameWidth - 12), left, y, size, "ink"),
      textDrawable(`row-${variable.name}-value`, unset ? UNSET : fitted(variable.value!, size, valueWidth), left + nameWidth, y, size, unset ? "muted" : changed ? "active" : "ink"),
    );
  });
  return out;
}

function stackGeometry(frameCount: number) {
  const rect = PANELS.stack;
  const top = rect.y + HEADER_HEIGHT + 14;
  const bottom = rect.y + rect.h - PANEL_PAD - FOOTER_HEIGHT;
  const room = bottom - top;
  const capacity = Math.floor((room + CARD_GAP) / (MIN_CARD_HEIGHT + CARD_GAP));
  const shown = Math.min(frameCount, capacity);
  const cardHeight = Math.min(MAX_CARD_HEIGHT, (room - CARD_GAP * (shown - 1)) / shown);
  return { bottom, shown, cardHeight, left: rect.x + PANEL_PAD, width: rect.w - PANEL_PAD * 2 };
}

function stackDrawables(state: CodeStepperState): Drawable[] {
  const { bottom, shown, cardHeight, left, width } = stackGeometry(state.frames.length);
  const hidden = state.frames.length - shown;
  const out = panelDrawables("stack", hidden > 0 ? `+${hidden} older` : undefined);
  const size = Math.min(22, cardHeight * 0.45);
  state.frames.slice(hidden).forEach((frame, offset) => {
    const isTop = hidden + offset === state.frames.length - 1;
    const y = bottom - (offset + 1) * cardHeight - offset * CARD_GAP;
    out.push(
      boxDrawable(`frame-${hidden + offset}`, { x: left, y, w: width, h: cardHeight }, isTop ? "fill2" : "none", isTop ? "active" : "rule", 1, { strokeWidth: isTop ? 2 : 1 }),
      textDrawable(`frame-${hidden + offset}-label`, fitted(frame.label, size, width - 28), left + 14, y + cardHeight / 2, size, isTop ? "ink" : "muted"),
    );
  });
  if (state.returned) {
    const rect = PANELS.stack;
    const text = `${state.returned.function} returned${state.returned.value === null ? "" : ` ${state.returned.value}`}`;
    out.push(textDrawable("returned", fitted(text, 20, width), left, rect.y + rect.h - PANEL_PAD - FOOTER_HEIGHT / 2, 20, "ok"));
  }
  return out;
}

function outputDrawables(state: CodeStepperState): Drawable[] {
  const rect = PANELS.output;
  const rowHeight = (rect.h - HEADER_HEIGHT - 8 - PANEL_PAD) / OUTPUT_LINES;
  const first = Math.max(0, state.output.length - OUTPUT_LINES);
  const out = panelDrawables("output", first > 0 ? `+${first} earlier` : undefined);
  state.output.slice(first).forEach((text, offset) => {
    out.push(textDrawable(`output-${first + offset}`, fitted(text, 20, rect.w - PANEL_PAD * 2), rect.x + PANEL_PAD, rect.y + HEADER_HEIGHT + 8 + (offset + 0.5) * rowHeight, 20, "ink"));
  });
  return out;
}

function setPulse(before: CodeStepperState, after: CodeStepperState, progress: number): Drawable[] {
  const frame = topFrame(after);
  const index = frame.variables.findIndex((variable) => variable.name === frame.changed);
  if (index < 0 || topFrame(before).label !== frame.label) return [];
  const { rowHeight } = variableRowGeometry(frame);
  return [{ ...bandDrawable("row-pulse", PANELS.variables, variableRowY(frame, index), rowHeight, 0.5 * Math.sin(Math.PI * progress)), z: 3 }];
}

function lineNumber(state: CodeStepperState, args: Record<string, unknown>): number {
  const line = args.n;
  if (typeof line !== "number" || !Number.isInteger(line)) fail(`op "line" needs "n" as a whole line number from 1 to ${state.lines.length}`);
  if ((line as number) < 1 || (line as number) > state.lines.length) fail(`op "line" n=${line} is out of range: the source has ${state.lines.length} lines`);
  return line as number;
}

export const lab: LabDef<CodeStepperSpec, CodeStepperState> = {
  id: "code",
  title: "Code stepper",
  catalog: {
    summary: "Runs a Python or C snippet one event at a time: source with a current line marker, the top frame's variables, the call stack and the output. Events map one to one onto the tracer.",
    spec: {
      source: "the code, with \\n between lines; line numbers start at 1",
      language: `one of ${CODE_LANGUAGES.join(", ")}, default python`,
      vars: 'optional names every called frame lists from the start, such as ["n","result"]; shown as – until set',
    },
    ops: {
      line: '{"n": 3} moves the current line marker to source line 3 and clears the "just changed" highlight',
      set: '{"name": "result", "value": "6"} writes a variable in the top frame; a new name adds a row; value is the repr as text',
      call: '{"name": "factorial", "args": {"n": "3"}} pushes a frame whose parameters are set from args',
      return: '{"value": "6"} pops the top frame and shows what it returned; value is optional; the global frame cannot return',
      print: '{"text": "6"} appends a line to the output; \\n splits it into several lines',
    },
    example: [
      '{"step":1,"say":"Call factorial of three. It gets its own frame with n equal to three.","scene":{"run":{"lab":"code","language":"python","source":"def factorial(n):\\n    if n <= 1:\\n        return 1\\n    return n * factorial(n - 1)\\n\\nprint(factorial(3))","vars":["n"]}},"do":[{"cue":"Call","op":"line","on":["run"],"n":6},{"cue":"own frame","op":"call","on":["run"],"name":"factorial","args":{"n":"3"}},{"cue":"equal to three","op":"line","on":["run"],"n":2}]}',
    ],
  },

  init(spec, objectId) {
    const source = stringField(spec, "source", objectId).replace(/\n+$/, "");
    if (source.trim() === "") fail(`${objectId}: "source" must hold at least one line of code`);
    const declared = readDeclared(spec.vars, objectId);
    return {
      lines: tokenizeCode(source, readLanguage(spec, objectId)),
      declared,
      frames: [newFrame(GLOBAL_FRAME, [])],
      currentLine: null,
      output: [],
      returned: null,
    };
  },

  apply(state, op: LabOp) {
    switch (op.name) {
      case "line":
        return { ...state, currentLine: lineNumber(state, op.args), returned: null, frames: state.frames.map((frame) => ({ ...frame, changed: null })) };
      case "set": {
        const name = stringArg(op.args, "name", "set");
        if (name === "") fail('op "set" needs "name" as a variable name');
        return withTopFrame(state, writeVariable(topFrame(state), name, valueArg(op.args, "value", "set")));
      }
      case "call": {
        const name = stringArg(op.args, "name", "call");
        const args = readCallArgs(op.args.args);
        const frame = newFrame(callLabel(name, args), state.declared, args);
        if (frame.variables.length > MAX_VARIABLES) fail(`op "call" ${name} would list ${frame.variables.length} variables; the table shows at most ${MAX_VARIABLES}`);
        return { ...state, frames: [...state.frames, frame], returned: null };
      }
      case "return": {
        if (state.frames.length === 1) fail('op "return" has no frame to pop: only the global frame is on the stack; use "call" first');
        const name = topFrame(state).label.replace(/\(.*$/, "");
        return { ...state, frames: state.frames.slice(0, -1), returned: { function: name, value: optionalValueArg(op.args, "value", "return") } };
      }
      case "print": {
        const text = stringArg(op.args, "text", "print").replace(/\n$/, "");
        return { ...state, output: [...state.output, ...text.split("\n")] };
      }
      default:
        return fail(`code has no op "${op.name}"; ops: line, set, call, return, print`);
    }
  },

  size: () => ({ w: WIDTH, h: HEIGHT }),

  draw(state) {
    return [...sourceDrawables(state), ...stackDrawables(state), ...variableDrawables(state), ...outputDrawables(state)];
  },

  duration(op) {
    return ({ line: 0.45, set: 0.7, call: 0.7, return: 0.7, print: 0.5 } as Record<string, number>)[op.name] ?? 0.6;
  },

  during(before, after, op, progress) {
    return op.name === "set" ? setPulse(before, after, progress) : [];
  },
};
