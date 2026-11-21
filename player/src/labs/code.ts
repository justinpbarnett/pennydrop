import { CODE_LANGUAGES, codeListing, fitted, languageField, loadHighlighter, NUMBER_SCALE, tokenizeCode } from "../highlight";
import { boxDrawable, type BoxLook, type Drawable, fail, type LabDef, type Paint, type Rect, segmentDrawable, type Span, stringArg, stringField, textDrawable, type TextLook } from "../lab";
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
  height: number;
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
const MAX_HEIGHT = 720;
const MIN_HEIGHT = 480;
const GAP = 24;
const SOURCE_WIDTH = 700;
const RIGHT_X = SOURCE_WIDTH + GAP;
const TOP_SHARE = 0.58;
const STACK_WIDTH = 300;
const VARIABLES_X = RIGHT_X + STACK_WIDTH + GAP;
const PANEL_PAD = 18;
const HEADER_HEIGHT = 52;
const HEADER_SIZE = 20;
const TITLE_ROOM = 130;
const SOURCE_PAD = 22;
const MAX_CODE_SIZE = 28;
const MIN_CODE_SIZE = 18;
const LINE_HEIGHT_PER_SIZE = 1.5;
const NUMBER_GAP = 18;
const MAX_VARIABLES = 12;
const MAX_ROW_HEIGHT = 46;
const OUTPUT_LINES = 8;
const BAND_OPACITY = 0.16;
const GLOBAL_FRAME = "global";
const UNSET = "–";
const CARD_GAP = 8;
const TWO_LINE_HEIGHT = 44;
const MIN_CARD_TEXT = 14;
const MAX_CARD_HEIGHT = 64;
const MIN_CARD_HEIGHT = 34;
const FOOTER_HEIGHT = 40;

type PanelKey = "source" | "stack" | "variables" | "output";

function panelsFor(height: number): Record<PanelKey, Rect> {
  const top = Math.round(height * TOP_SHARE);
  const outputY = top + GAP;
  return {
    source: { x: 0, y: 0, w: SOURCE_WIDTH, h: height },
    stack: { x: RIGHT_X, y: 0, w: STACK_WIDTH, h: top },
    variables: { x: VARIABLES_X, y: 0, w: WIDTH - VARIABLES_X, h: top },
    output: { x: RIGHT_X, y: outputY, w: WIDTH - RIGHT_X, h: height - outputY },
  };
}

function heightFor(lines: Span[][]): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(lines.length * MAX_CODE_SIZE * LINE_HEIGHT_PER_SIZE + SOURCE_PAD * 2)));
}

const PANEL_TITLES = { stack: "Call stack", variables: "Variables", output: "Output" } as const;

function valueArg(args: Record<string, unknown>, key: string, opName: string): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fail(`op "${opName}" needs "${key}" as text such as "3" or "[1, 2]" (the repr of the value)`);
}

function optionalValueArg(args: Record<string, unknown>, key: string, opName: string): string | null {
  return args[key] === undefined || args[key] === null ? null : valueArg(args, key, opName);
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

function codeMetrics(lines: Span[][], height: number) {
  const innerHeight = height - SOURCE_PAD * 2;
  const widest = Math.max(...lines.map((line) => textWidth(line.map((span) => span.text).join(""), 1, "code")), 1);
  const gutterPerSize = textWidth(String(lines.length), NUMBER_SCALE, "code");
  const byHeight = innerHeight / lines.length / LINE_HEIGHT_PER_SIZE;
  const byWidth = (SOURCE_WIDTH - SOURCE_PAD * 2 - NUMBER_GAP - 8) / (widest + gutterPerSize);
  const size = Math.min(MAX_CODE_SIZE, byHeight, Math.max(byWidth, MIN_CODE_SIZE));
  const gutter = gutterPerSize * size + NUMBER_GAP;
  return { size, gutter, lineWidth: SOURCE_WIDTH - SOURCE_PAD * 2 - gutter, lineHeight: Math.min(size * LINE_HEIGHT_PER_SIZE, innerHeight / lines.length) };
}

function panelBox(id: string, rect: Rect, fill: Paint, stroke: Paint, z: number, extras: BoxLook = {}): Drawable {
  return boxDrawable(id, rect, { fill, stroke, strokeWidth: 1, radius: 1, z, ...extras });
}

function codeText(id: string, text: string, x: number, y: number, size: number, fill: Paint, extras: Partial<TextLook> = {}): Drawable {
  return textDrawable(id, text, { x, y }, { size, font: "code", fill, anchor: "start", z: 2, ...extras });
}

function panelDrawables(height: number, key: keyof typeof PANEL_TITLES, trailing?: string): Drawable[] {
  const rect = panelsFor(height)[key];
  const out: Drawable[] = [
    panelBox(`${key}-panel`, rect, "fill", "rule", 0),
    textDrawable(`${key}-title`, PANEL_TITLES[key], { x: rect.x + PANEL_PAD, y: rect.y + HEADER_HEIGHT / 2 }, { size: HEADER_SIZE, font: "mark", fill: "muted", anchor: "start", z: 2 }),
    { ...segmentDrawable("line", { x: rect.x + PANEL_PAD, y: rect.y + HEADER_HEIGHT }, { x: rect.x + rect.w - PANEL_PAD, y: rect.y + HEADER_HEIGHT }, "rule", 1, 1), id: `${key}-rule` },
  ];
  if (trailing) out.push(codeText(`${key}-trailing`, trailing, rect.x + rect.w - PANEL_PAD, rect.y + HEADER_HEIGHT / 2, HEADER_SIZE - 2, "muted", { anchor: "end" }));
  return out;
}

function bandDrawable(id: string, panel: Rect, y: number, height: number, opacity: number): Drawable {
  return panelBox(id, { x: panel.x + 1, y: y - height / 2, w: panel.w - 2, h: height }, "active", "none", 1, { opacity, radius: 0 });
}

function sourceDrawables(state: CodeStepperState): Drawable[] {
  const { size, lineHeight, gutter, lineWidth } = codeMetrics(state.lines, state.height);
  const lineY = (line: number) => SOURCE_PAD + (line - 0.5) * lineHeight;
  const panels = panelsFor(state.height);
  const marked = state.currentLine !== null;
  const barY = lineY(state.currentLine ?? 1);
  return [
    panelBox("source-panel", panels.source, "fill", "rule", 0),
    bandDrawable("line-bar", panels.source, barY, lineHeight, marked ? BAND_OPACITY : 0),
    panelBox("line-marker", { x: 1, y: barY - lineHeight / 2, w: 6, h: lineHeight }, "active", "none", 1, { opacity: marked ? 1 : 0, radius: 0 }),
    ...codeListing(state.lines, { left: SOURCE_PAD, top: SOURCE_PAD, size, lineHeight, gutter, lineWidth }),
  ];
}

function variableRowGeometry(state: CodeStepperState, frame: Frame) {
  const rect = panelsFor(state.height).variables;
  const top = rect.y + HEADER_HEIGHT + 12;
  const rowHeight = Math.min(MAX_ROW_HEIGHT, (rect.h - HEADER_HEIGHT - 12 - PANEL_PAD) / Math.max(frame.variables.length, 1));
  const size = Math.min(26, rowHeight * 0.58);
  const inner = rect.w - PANEL_PAD * 2;
  const nameWidth = inner * 0.36;
  return { top, rowHeight, size, left: rect.x + PANEL_PAD, inner, nameWidth };
}

function variableRowY(state: CodeStepperState, frame: Frame, index: number): number {
  const { top, rowHeight } = variableRowGeometry(state, frame);
  return top + (index + 0.5) * rowHeight;
}

function variableDrawables(state: CodeStepperState): Drawable[] {
  const frame = topFrame(state);
  const { rowHeight, size, left, inner, nameWidth } = variableRowGeometry(state, frame);
  const variablesPanel = panelsFor(state.height).variables;
  const out = panelDrawables(state.height, "variables", frame.label === GLOBAL_FRAME ? undefined : fitted(frame.label.replace(/\(.*$/, ""), HEADER_SIZE - 2, variablesPanel.w - PANEL_PAD * 2 - TITLE_ROOM));
  if (frame.variables.length === 0) out.push(codeText("variables-empty", "nothing yet", left, variableRowY(state, frame, 0), size, "muted"));
  frame.variables.forEach((variable, index) => {
    const y = variableRowY(state, frame, index);
    const changed = frame.changed === variable.name;
    const unset = variable.value === null;
    const valueWidth = inner - nameWidth - 12;
    if (changed) out.push(bandDrawable(`row-${variable.name}-tint`, variablesPanel, y, rowHeight, BAND_OPACITY));
    out.push(
      codeText(`row-${variable.name}-name`, fitted(variable.name, size, nameWidth - 12), left, y, size, "ink"),
      codeText(`row-${variable.name}-value`, unset ? UNSET : fitted(variable.value!, size, valueWidth), left + nameWidth, y, size, unset ? "muted" : changed ? "active" : "ink"),
    );
  });
  return out;
}

function stackGeometry(height: number, frameCount: number) {
  const rect = panelsFor(height).stack;
  const top = rect.y + HEADER_HEIGHT + 14;
  const bottom = rect.y + rect.h - PANEL_PAD - FOOTER_HEIGHT;
  const room = bottom - top;
  const capacity = Math.floor((room + CARD_GAP) / (MIN_CARD_HEIGHT + CARD_GAP));
  const shown = Math.min(frameCount, capacity);
  const cardHeight = Math.min(MAX_CARD_HEIGHT, (room - CARD_GAP * (shown - 1)) / shown);
  return { bottom, shown, cardHeight, left: rect.x + PANEL_PAD, width: rect.w - PANEL_PAD * 2 };
}

function splitLabel(label: string): string[] {
  const breaks = [...label.matchAll(/, /g)].map((match) => match.index! + 1);
  if (breaks.length === 0) return [label];
  const middle = label.length / 2;
  const at = breaks.reduce((best, index) => (Math.abs(index - middle) < Math.abs(best - middle) ? index : best));
  return [label.slice(0, at), label.slice(at).trimStart()];
}

function cardLabel(id: string, label: string, x: number, top: number, height: number, width: number, size: number, fill: Paint): Drawable[] {
  if (textWidth(label, size, "code") <= width) return [codeText(id, label, x, top + height / 2, size, fill)];
  const lines = height >= TWO_LINE_HEIGHT ? splitLabel(label) : [label];
  const lineSize = Math.max(MIN_CARD_TEXT, Math.min(size, ...lines.map((line) => (size * width) / textWidth(line, size, "code"))));
  const pitch = lineSize * 1.25;
  return lines.map((line, index) => codeText(`${id}-${index}`, fitted(line, lineSize, width), x, top + height / 2 + (index - (lines.length - 1) / 2) * pitch, lineSize, fill));
}

function stackDrawables(state: CodeStepperState): Drawable[] {
  const { bottom, shown, cardHeight, left, width } = stackGeometry(state.height, state.frames.length);
  const hidden = state.frames.length - shown;
  const out = panelDrawables(state.height, "stack", hidden > 0 ? `+${hidden} older` : undefined);
  const size = Math.min(22, cardHeight * 0.45);
  state.frames.slice(hidden).forEach((frame, offset) => {
    const isTop = hidden + offset === state.frames.length - 1;
    const y = bottom - (offset + 1) * cardHeight - offset * CARD_GAP;
    out.push(
      panelBox(`frame-${hidden + offset}`, { x: left, y, w: width, h: cardHeight }, isTop ? "fill2" : "none", isTop ? "active" : "rule", 1, { strokeWidth: isTop ? 2 : 1 }),
      ...cardLabel(`frame-${hidden + offset}-label`, frame.label, left + 14, y, cardHeight, width - 28, size, isTop ? "ink" : "muted"),
    );
  });
  if (state.returned) {
    const rect = panelsFor(state.height).stack;
    const text = `${state.returned.function} returned${state.returned.value === null ? "" : ` ${state.returned.value}`}`;
    out.push(codeText("returned", fitted(text, 20, width), left, rect.y + rect.h - PANEL_PAD - FOOTER_HEIGHT / 2, 20, "ok"));
  }
  return out;
}

function outputDrawables(state: CodeStepperState): Drawable[] {
  const rect = panelsFor(state.height).output;
  const rowHeight = (rect.h - HEADER_HEIGHT - 8 - PANEL_PAD) / OUTPUT_LINES;
  const first = Math.max(0, state.output.length - OUTPUT_LINES);
  const out = panelDrawables(state.height, "output", first > 0 ? `+${first} earlier` : undefined);
  state.output.slice(first).forEach((text, offset) => {
    out.push(codeText(`output-${first + offset}`, fitted(text, 20, rect.w - PANEL_PAD * 2), rect.x + PANEL_PAD, rect.y + HEADER_HEIGHT + 8 + (offset + 0.5) * rowHeight, 20, "ink"));
  });
  return out;
}

function setPulse(before: CodeStepperState, after: CodeStepperState, progress: number): Drawable[] {
  const frame = topFrame(after);
  const index = frame.variables.findIndex((variable) => variable.name === frame.changed);
  if (index < 0 || topFrame(before).label !== frame.label) return [];
  const { rowHeight } = variableRowGeometry(after, frame);
  return [{ ...bandDrawable("row-pulse", panelsFor(after.height).variables, variableRowY(after, frame, index), rowHeight, 0.5 * Math.sin(Math.PI * progress)), z: 3 }];
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
  reading: "required",
  catalog: {
    summary: "Runs a Python or C snippet one event at a time: source with a current line marker, the top frame's variables, the call stack and the output. Events map one to one onto the tracer.",
    spec: {
      source: "the code, with \\n between lines; line numbers start at 1",
      language: `one of ${CODE_LANGUAGES.join(", ")}, default python`,
      vars: 'optional names every called frame lists from the start, such as ["n","result"]; shown as – until set',
    },
    example: [
      '{"step":1,"say":"Call factorial of three. It gets its own frame with n equal to three.","scene":{"run":{"lab":"code","language":"python","source":"def factorial(n):\\n    if n <= 1:\\n        return 1\\n    return n * factorial(n - 1)\\n\\nprint(factorial(3))","vars":["n"]}},"do":[{"cue":"Call","op":"line","on":["run"],"n":6},{"cue":"own frame","op":"call","on":["run"],"name":"factorial","args":{"n":"3"}},{"cue":"equal to three","op":"line","on":["run"],"n":2}]}',
    ],
  },

  ops: {
    line: {
      doc: '{"n": 3} moves the current line marker to source line 3 and clears the "just changed" highlight',
      seconds: 0.45,
      apply: (state, op) => ({ ...state, currentLine: lineNumber(state, op.args), returned: null, frames: state.frames.map((frame) => ({ ...frame, changed: null })) }),
    },
    set: {
      doc: '{"name": "result", "value": "6"} writes a variable in the top frame; a new name adds a row; value is the repr as text',
      seconds: 0.7,
      apply(state, op) {
        const name = stringArg(op.args, "name", "set");
        if (name === "") fail('op "set" needs "name" as a variable name');
        return withTopFrame(state, writeVariable(topFrame(state), name, valueArg(op.args, "value", "set")));
      },
      during: (before, after, _op, progress) => setPulse(before, after, progress),
    },
    call: {
      doc: '{"name": "factorial", "args": {"n": "3"}} pushes a frame whose parameters are set from args',
      seconds: 0.7,
      apply(state, op) {
        const name = stringArg(op.args, "name", "call");
        const args = readCallArgs(op.args.args);
        const frame = newFrame(callLabel(name, args), state.declared, args);
        if (frame.variables.length > MAX_VARIABLES) fail(`op "call" ${name} would list ${frame.variables.length} variables; the table shows at most ${MAX_VARIABLES}`);
        return { ...state, frames: [...state.frames, frame], returned: null };
      },
    },
    return: {
      doc: '{"value": "6"} pops the top frame and shows what it returned; value is optional; the global frame cannot return',
      seconds: 0.7,
      apply(state, op) {
        if (state.frames.length === 1) fail('op "return" has no frame to pop: only the global frame is on the stack; use "call" first');
        const name = topFrame(state).label.replace(/\(.*$/, "");
        return { ...state, frames: state.frames.slice(0, -1), returned: { function: name, value: optionalValueArg(op.args, "value", "return") } };
      },
    },
    print: {
      doc: '{"text": "6"} appends a line to the output; \\n splits it into several lines',
      seconds: 0.5,
      apply(state, op) {
        const text = stringArg(op.args, "text", "print").replace(/\n$/, "");
        return { ...state, output: [...state.output, ...text.split("\n")] };
      },
    },
  },

  prepare: loadHighlighter,

  init(spec, objectId) {
    const source = stringField(spec, "source", objectId).replace(/\n+$/, "");
    if (source.trim() === "") fail(`${objectId}: "source" must hold at least one line of code`);
    const declared = readDeclared(spec.vars, objectId);
    const lines = tokenizeCode(source, languageField(spec, objectId));
    return {
      lines,
      height: heightFor(lines),
      declared,
      frames: [newFrame(GLOBAL_FRAME, [])],
      currentLine: null,
      output: [],
      returned: null,
    };
  },

  size: (state) => ({ w: WIDTH, h: state.height }),

  draw(state) {
    return [...sourceDrawables(state), ...stackDrawables(state), ...variableDrawables(state), ...outputDrawables(state)];
  },
};
