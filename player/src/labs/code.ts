import { CODE_LANGUAGES, codeListing, elideMiddle, topLevelItems, languageField, loadHighlighter, NUMBER_SCALE, tokenizeCode } from "../highlight";
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
  printsOutput: boolean;
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
  output?: unknown;
}

const WIDTH = 1480;
const MAX_HEIGHT = 720;
const MIN_HEIGHT = 540;
const GAP = 24;
const SOURCE_WIDTH = 700;
const RIGHT_X = SOURCE_WIDTH + GAP;
const STACK_WIDTH = 360;
const VARIABLES_X = RIGHT_X + STACK_WIDTH + GAP;
const OUTPUT_LINES = 4;
const PANEL_PAD = 18;
const HEADER_HEIGHT = 56;
const TEXT_SIZE = 24;
const ROW_HEIGHT = 38;
const OUTPUT_ROW_HEIGHT = 34;
const SOURCE_PAD = 22;
const MAX_CODE_SIZE = 28;
const MIN_CODE_SIZE = 24;
const LINE_HEIGHT_PER_SIZE = 1.75;
const NUMBER_GAP = 18;
const BAND_OPACITY = 0.16;
const GLOBAL_FRAME = "global";
const UNSET = "–";
const CARD_GAP = 8;
const CARD_PAD = 10;
const CARD_LINE = 30;
const FOOTER_LINE = 30;
const NAME_SHARE = 0.4;
const TITLE_SPREAD = 1.2;
const NOTE_HEIGHT = 34;
const OUTPUT_CALLS = /\b(print|printf|puts|putchar|fputs|fprintf|cout|println|write)\b/;

type PanelKey = "source" | "stack" | "variables" | "output";

function panelsFor(height: number, withOutput: boolean): Record<PanelKey, Rect> {
  const outputHeight = HEADER_HEIGHT + OUTPUT_LINES * OUTPUT_ROW_HEIGHT + PANEL_PAD;
  const top = withOutput ? height - outputHeight - GAP : height;
  return {
    source: { x: 0, y: 0, w: SOURCE_WIDTH, h: height },
    stack: { x: RIGHT_X, y: 0, w: STACK_WIDTH, h: top },
    variables: { x: VARIABLES_X, y: 0, w: WIDTH - VARIABLES_X, h: top },
    output: { x: RIGHT_X, y: top + GAP, w: WIDTH - RIGHT_X, h: outputHeight },
  };
}

function panelsOf(state: CodeStepperState): Record<PanelKey, Rect> {
  return panelsFor(state.height, state.printsOutput);
}

function heightFor(lines: Span[][]): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(lines.length * MAX_CODE_SIZE * LINE_HEIGHT_PER_SIZE + SOURCE_PAD * 2)));
}

const PANEL_TITLES = { stack: "Call stack", variables: "Variables", output: "Output" } as const;

function variableCapacity(state: CodeStepperState): number {
  return Math.floor((panelsOf(state).variables.h - HEADER_HEIGHT - 12 - PANEL_PAD) / ROW_HEIGHT);
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

function readDeclared(vars: unknown, objectId: string): string[] {
  if (vars === undefined) return [];
  if (!Array.isArray(vars) || vars.some((name) => typeof name !== "string" || name === "")) fail(`${objectId}: "vars" must be a list of variable names such as ["n", "result"]`);
  return vars as string[];
}

function readOutputFlag(value: unknown, objectId: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${objectId}: "output" must be true or false`);
  return value as boolean;
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

function writeVariable(state: CodeStepperState, frame: Frame, name: string, value: string): Frame {
  const exists = frame.variables.some((variable) => variable.name === name);
  if (!exists && frame.variables.length >= variableCapacity(state)) fail(`frame ${frame.label} already shows ${variableCapacity(state)} variables; the table has no room for "${name}"`);
  const variables = exists ? frame.variables.map((variable) => (variable.name === name ? { name, value } : variable)) : [...frame.variables, { name, value }];
  return { ...frame, variables, changed: name };
}

function codeMetrics(lines: Span[][], height: number) {
  const innerHeight = height - SOURCE_PAD * 2;
  const widest = Math.max(...lines.map((line) => textWidth(line.map((span) => span.text).join(""), 1, "code")), 1);
  const gutterPerSize = textWidth(String(lines.length), NUMBER_SCALE, "code");
  const byHeight = innerHeight / lines.length / LINE_HEIGHT_PER_SIZE;
  const byWidth = (SOURCE_WIDTH - SOURCE_PAD * 2 - NUMBER_GAP - 8) / (widest + gutterPerSize);
  const size = Math.max(MIN_CODE_SIZE, Math.min(MAX_CODE_SIZE, byHeight, Math.max(byWidth, MIN_CODE_SIZE)));
  const gutter = gutterPerSize * size + NUMBER_GAP;
  return { size, gutter, lineWidth: SOURCE_WIDTH - SOURCE_PAD * 2 - gutter, lineHeight: Math.min(size * LINE_HEIGHT_PER_SIZE, innerHeight / lines.length) };
}

function panelBox(id: string, rect: Rect, fill: Paint, stroke: Paint, z: number, extras: BoxLook = {}): Drawable {
  return boxDrawable(id, rect, { fill, stroke, strokeWidth: 1, radius: 1, z, ...extras });
}

function codeText(id: string, text: string, x: number, y: number, size: number, fill: Paint, extras: Partial<TextLook> = {}): Drawable {
  return textDrawable(id, text, { x, y }, { size, font: "code", fill, anchor: "start", z: 2, ...extras });
}

function panelDrawables(state: CodeStepperState, key: keyof typeof PANEL_TITLES, trailing?: string): Drawable[] {
  const rect = panelsOf(state)[key];
  const out: Drawable[] = [
    panelBox(`${key}-panel`, rect, "fill", "rule", 0),
    textDrawable(`${key}-title`, PANEL_TITLES[key], { x: rect.x + PANEL_PAD, y: rect.y + HEADER_HEIGHT / 2 }, { size: TEXT_SIZE, font: "mark", fill: "muted", anchor: "start", z: 2 }),
    { ...segmentDrawable("line", { x: rect.x + PANEL_PAD, y: rect.y + HEADER_HEIGHT }, { x: rect.x + rect.w - PANEL_PAD, y: rect.y + HEADER_HEIGHT }, "rule", 1, 1), id: `${key}-rule` },
  ];
  const room = rect.w - PANEL_PAD * 2 - textWidth(PANEL_TITLES[key].toUpperCase(), TEXT_SIZE * TITLE_SPREAD, "mark") - PANEL_PAD;
  if (trailing && textWidth(trailing, TEXT_SIZE, "code") <= room) {
    out.push(codeText(`${key}-trailing`, trailing, rect.x + rect.w - PANEL_PAD, rect.y + HEADER_HEIGHT / 2, TEXT_SIZE, "muted", { anchor: "end" }));
  }
  return out;
}

function bandDrawable(id: string, panel: Rect, y: number, height: number, opacity: number): Drawable {
  return panelBox(id, { x: panel.x + 1, y: y - height / 2, w: panel.w - 2, h: height }, "active", "none", 1, { opacity, radius: 0 });
}

function sourceDrawables(state: CodeStepperState): Drawable[] {
  const { size, lineHeight, gutter, lineWidth } = codeMetrics(state.lines, state.height);
  const panels = panelsOf(state);
  const lineY = (line: number) => SOURCE_PAD + (line - 0.5) * lineHeight;
  const marked = state.currentLine !== null;
  const barY = lineY(state.currentLine ?? 1);
  return [
    panelBox("source-panel", panels.source, "fill", "rule", 0),
    bandDrawable("line-bar", panels.source, barY, lineHeight, marked ? BAND_OPACITY : 0),
    panelBox("line-marker", { x: 1, y: barY - lineHeight / 2, w: 6, h: lineHeight }, "active", "none", 1, { opacity: marked ? 1 : 0, radius: 0 }),
    ...codeListing(state.lines, { left: SOURCE_PAD, top: SOURCE_PAD, size, lineHeight, gutter, lineWidth }),
  ];
}

function variableRowGeometry(state: CodeStepperState) {
  const rect = panelsOf(state).variables;
  const inner = rect.w - PANEL_PAD * 2;
  const nameWidth = inner * NAME_SHARE;
  return { top: rect.y + HEADER_HEIGHT + 12, left: rect.x + PANEL_PAD, inner, nameWidth };
}

function variableRowY(state: CodeStepperState, index: number): number {
  return variableRowGeometry(state).top + (index + 0.5) * ROW_HEIGHT;
}

function variableDrawables(state: CodeStepperState): Drawable[] {
  const frame = topFrame(state);
  const { left, inner, nameWidth } = variableRowGeometry(state);
  const panel = panelsOf(state).variables;
  const out = panelDrawables(state, "variables", frame.label === GLOBAL_FRAME ? undefined : frame.label.replace(/\(.*$/, ""));
  if (frame.variables.length === 0) out.push(codeText("variables-empty", "nothing yet", left, variableRowY(state, 0), TEXT_SIZE, "muted"));
  frame.variables.forEach((variable, index) => {
    const y = variableRowY(state, index);
    const changed = frame.changed === variable.name;
    const unset = variable.value === null;
    const valueWidth = inner - nameWidth;
    if (changed) out.push(bandDrawable(`row-${variable.name}-tint`, panel, y, ROW_HEIGHT, BAND_OPACITY));
    out.push(
      codeText(`row-${variable.name}-name`, elideMiddle(variable.name, TEXT_SIZE, nameWidth - 12), left, y, TEXT_SIZE, "ink"),
      codeText(`row-${variable.name}-value`, unset ? UNSET : elideMiddle(variable.value!, TEXT_SIZE, valueWidth), left + nameWidth, y, TEXT_SIZE, unset ? "muted" : changed ? "active" : "ink"),
    );
  });
  return out;
}

function cardLines(frame: Frame, width: number): string[] {
  const whole = frame.label;
  if (textWidth(whole, TEXT_SIZE, "code") <= width) return [whole];
  const open = whole.indexOf("(");
  const close = whole.lastIndexOf(")");
  if (open < 0 || close < open) return [elideMiddle(whole, TEXT_SIZE, width)];
  const args = topLevelItems(whole.slice(open + 1, close)).filter((arg) => arg.length > 0);
  const room = width - 24 - textWidth(",", TEXT_SIZE, "code");
  const pieces = [`${whole.slice(0, open + 1)}`, ...args.map((arg, index) => `${elideMiddle(arg, TEXT_SIZE, room)}${index < args.length - 1 ? "," : ")"}`)];
  const lines: string[] = [];
  for (const piece of pieces) {
    const last = lines[lines.length - 1];
    const joined = last === undefined ? piece : `${last}${last.endsWith("(") ? "" : " "}${piece}`;
    if (last !== undefined && textWidth(joined, TEXT_SIZE, "code") <= width) lines[lines.length - 1] = joined;
    else lines.push(piece);
  }
  return lines.map((line, index) => elideMiddle(line, TEXT_SIZE, width - (index > 0 ? 24 : 0)));
}

function stackDrawables(state: CodeStepperState): Drawable[] {
  const rect = panelsOf(state).stack;
  const left = rect.x + PANEL_PAD;
  const width = rect.w - PANEL_PAD * 2;
  const footer = state.returned ? FOOTER_LINE * 2 + CARD_GAP : 0;
  const top = rect.y + HEADER_HEIGHT + 14;
  const bottom = rect.y + rect.h - PANEL_PAD - footer;
  const cards = state.frames.map((frame) => {
    const lines = cardLines(frame, width - 28);
    return { frame, lines, height: lines.length * CARD_LINE + CARD_PAD * 2 };
  });
  const fitting = (room: number) => {
    let used = 0;
    let count = 0;
    for (const card of [...cards].reverse()) {
      const next = used + card.height + (count > 0 ? CARD_GAP : 0);
      if (next > room) break;
      used = next;
      count += 1;
    }
    return Math.max(count, 1);
  };
  const full = fitting(bottom - top);
  const shown = full === cards.length ? full : fitting(bottom - top - NOTE_HEIGHT);
  const hidden = cards.length - shown;
  const out = panelDrawables(state, "stack");
  if (hidden > 0) out.push(codeText("stack-older", `+${hidden} older`, left, top + NOTE_HEIGHT / 2 - 4, TEXT_SIZE, "muted"));
  let y = bottom;
  cards.slice(hidden).forEach((card, offset) => {
    const index = hidden + offset;
    const isTop = index === cards.length - 1;
    y -= card.height;
    out.push(panelBox(`frame-${index}`, { x: left, y, w: width, h: card.height }, isTop ? "fill2" : "none", isTop ? "active" : "rule", 1, { strokeWidth: isTop ? 2 : 1 }));
    card.lines.forEach((line, lineIndex) => out.push(codeText(`frame-${index}-label${lineIndex === 0 ? "" : `-${lineIndex}`}`, line, left + 14 + (lineIndex > 0 ? 24 : 0), y + CARD_PAD + (lineIndex + 0.5) * CARD_LINE, TEXT_SIZE, isTop ? "ink" : "muted")));
    y -= CARD_GAP;
  });
  if (state.returned) {
    const text = `${state.returned.function} returned${state.returned.value === null ? "" : ` ${state.returned.value}`}`;
    const lines = textWidth(text, TEXT_SIZE, "code") <= width ? [text] : [`${state.returned.function} returned`, elideMiddle(state.returned.value ?? "", TEXT_SIZE, width)];
    lines.forEach((line, index) => out.push(codeText(`returned${index === 0 ? "" : `-${index}`}`, elideMiddle(line, TEXT_SIZE, width), left, rect.y + rect.h - PANEL_PAD - footer + CARD_GAP + (index + 0.5) * FOOTER_LINE, TEXT_SIZE, "ok")));
  }
  return out;
}

function outputDrawables(state: CodeStepperState): Drawable[] {
  if (!state.printsOutput) return [];
  const rect = panelsOf(state).output;
  const first = Math.max(0, state.output.length - OUTPUT_LINES);
  const out = panelDrawables(state, "output", first > 0 ? `+${first} earlier` : undefined);
  state.output.slice(first).forEach((text, offset) => {
    out.push(codeText(`output-${first + offset}`, elideMiddle(text, TEXT_SIZE, rect.w - PANEL_PAD * 2), rect.x + PANEL_PAD, rect.y + HEADER_HEIGHT + (offset + 0.5) * OUTPUT_ROW_HEIGHT, TEXT_SIZE, "ink"));
  });
  return out;
}

function setPulse(before: CodeStepperState, after: CodeStepperState, progress: number): Drawable[] {
  const frame = topFrame(after);
  const index = frame.variables.findIndex((variable) => variable.name === frame.changed);
  if (index < 0 || topFrame(before).label !== frame.label) return [];
  return [{ ...bandDrawable("row-pulse", panelsOf(after).variables, variableRowY(after, index), ROW_HEIGHT, 0.5 * Math.sin(Math.PI * progress)), z: 3 }];
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
      output: "optional true or false; whether the Output panel is drawn, default true when the source calls print, printf, puts or the like",
      vars: 'optional names every function call frame lists from the start, such as ["n","result"], shown as – until set; the global frame never lists them, so a global appears only when a "set" op or the trace directive writes it',
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
        return withTopFrame(state, writeVariable(state, topFrame(state), name, valueArg(op.args, "value", "set")));
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
        if (frame.variables.length > variableCapacity(state)) fail(`op "call" ${name} would list ${frame.variables.length} variables; the table shows at most ${variableCapacity(state)}`);
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
        if (!state.printsOutput) fail('op "print" needs the Output panel, but the source never prints; set "output": true in the object spec');
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
      printsOutput: readOutputFlag(spec.output, objectId) ?? OUTPUT_CALLS.test(source),
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
