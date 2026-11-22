import { boxDrawable, type Drawable, fail, integerArg, integerField, type LabDef, type LabOp, type Point, readsWords, type Rect, type Role, stringField, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

type EventKind = "note" | "chord" | "rest";

interface MusicEvent {
  id: string;
  kind: EventKind;
  pitches: number[];
  start: number;
  length: number;
}

interface Scale {
  name: string;
  pitches: number[];
}

interface MusicState {
  objectId: string;
  reading: boolean;
  low: number;
  high: number;
  beats: number;
  tempo: number;
  events: MusicEvent[];
  scale: Scale | null;
  flats: number[];
}

interface MusicSpec {
  low?: unknown;
  high?: unknown;
  beats?: unknown;
  tempo?: unknown;
  reading?: unknown;
}

interface Layout {
  labelRight: number;
  keyLeft: number;
  gridLeft: number;
  gridTop: number;
  gridBottom: number;
  rowHeight: number;
  columnWidth: number;
  labelSize: number;
}

interface Played {
  midi: number;
  at: number;
  hold: number;
  volume: number;
}

const WIDTH = 1480;
const HEIGHT = 776;
const HEADER_HEIGHT = 64;
const HEADER_TEXT_Y = 18;
const HEADER_SIZE = 30;
const BEAT_BAND = 56;
const BEAT_LABEL_OFFSET = 28;
const BEAT_LABEL_SIZE = 26;
const KEY_WIDTH = 64;
const LABEL_GAP = 16;
const MAX_LABEL_SIZE = 28;
const LABEL_SHARE = 0.62;
const BAR_BEATS = 4;

const NOTE_INSET = 7;
const FRAME_INSET = 3;
const OUTLINE_INSET = 10;
const CHORD_PAD = 4;
const FRAME_STROKE = 2;
const REST_BAR_HEIGHT = 24;
const REST_BAR_SHARE = 0.6;
const REST_BAR_MAX = 96;
const REST_LABEL = "rest";
const REST_LABEL_SIZE = BEAT_LABEL_SIZE;
const PLAYHEAD_STROKE = 4;
const PLAYHEAD_Z = 2.5;
const PLAYHEAD_CLEAR = 6;
const BAND_CLEAR = 6;
const MIN_PIECE = 12;
const SCALE_BAND_STROKE = 3;
const KEY_DOT_SHARE = 0.32;
const KEY_DOT_MAX = 16;
const KEY_DOT_STROKE = 2;

const MIN_OCTAVE = 0;
const MAX_OCTAVE = 8;
const MAX_ROWS = 18;
const MIN_BEATS = 4;
const MAX_BEATS = 16;
const MIN_BPM = 40;
const MAX_BPM = 200;
const MAX_LENGTH = MAX_BEATS;
const MIN_CHORD = 2;
const MAX_CHORD = 6;

const NOTE_SECONDS = 0.7;
const CHORD_SECONDS = 0.9;
const REST_SECONDS = 0.6;
const SCALE_STEP_SECONDS = 0.5;
const SECONDS_PER_MINUTE = 60;

const NOTE_VOLUME = -8;
const CLICK_VOLUME = -22;
const CLICK_MIDI = 96;
const CLICK_HOLD = 0.04;

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const LETTER_STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL_STEPS: Record<string, number> = { "": 0, "#": 1, b: -1 };
const PITCH_PATTERN = /^([A-G])(#|b)?(\d)$/;

const SCALE_STEPS: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11, 12],
  minor: [0, 2, 3, 5, 7, 8, 10, 12],
  pentatonic: [0, 2, 4, 7, 9, 12],
};

const EVENT_COLOR: Record<EventKind, Role> = {
  note: "series1",
  chord: "series2",
  rest: "muted",
};

function pitchName(midi: number, flats: readonly number[] = []): string {
  const names = flats.includes(midi) ? FLAT_NAMES : SHARP_NAMES;
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function isBlackKey(midi: number): boolean {
  return SHARP_NAMES[midi % 12]!.endsWith("#");
}

function flatSpelled(value: unknown): boolean {
  return typeof value === "string" && PITCH_PATTERN.exec(value)?.[2] === "b";
}

function withFlats(state: MusicState, midis: number[]): MusicState {
  const flats = midis.filter(isBlackKey).filter((midi) => !state.flats.includes(midi));
  return flats.length === 0 ? state : { ...state, flats: [...state.flats, ...flats] };
}

function parsePitch(value: unknown, where: string): number {
  const match = typeof value === "string" ? PITCH_PATTERN.exec(value) : null;
  if (!match) fail(`${where} must be a pitch such as "C4", "F#3" or "Bb4" (a letter A to G, optional # or b, then an octave ${MIN_OCTAVE} to ${MAX_OCTAVE}), got ${JSON.stringify(value)}`);
  const octave = Number(match[3]);
  if (octave > MAX_OCTAVE) fail(`${where} must have an octave from ${MIN_OCTAVE} to ${MAX_OCTAVE}, got ${JSON.stringify(value)}`);
  return (octave + 1) * 12 + LETTER_STEPS[match[1]!]! + ACCIDENTAL_STEPS[match[2] ?? ""]!;
}

function rangeOf(spec: MusicSpec, objectId: string): { low: number; high: number } {
  const low = parsePitch(stringField(spec as Record<string, unknown>, "low", objectId, "C4"), `${objectId}: "low"`);
  const high = parsePitch(stringField(spec as Record<string, unknown>, "high", objectId, "C5"), `${objectId}: "high"`);
  if (high <= low) fail(`${objectId}: "high" (${pitchName(high)}) must be above "low" (${pitchName(low)})`);
  if (high - low + 1 > MAX_ROWS)
    fail(`${objectId}: "low" ${pitchName(low)} to "high" ${pitchName(high)} is ${high - low + 1} rows, but at most ${MAX_ROWS} fit; narrow the range, such as "low": "C4", "high": "F5"`);
  return { low, high };
}

function rowCount(state: MusicState): number {
  return state.high - state.low + 1;
}

function rowPitches(state: MusicState): number[] {
  return Array.from({ length: rowCount(state) }, (_, row) => state.high - row);
}

function widestLabel(state: MusicState, size: number): number {
  return Math.max(...rowPitches(state).map((midi) => textWidth(pitchName(midi, state.flats), size, "read")));
}

function layout(state: MusicState): Layout {
  const gridTop = state.reading ? HEADER_HEIGHT : 0;
  const gridBottom = HEIGHT - (state.reading ? BEAT_BAND : 0);
  const rowHeight = (gridBottom - gridTop) / rowCount(state);
  const labelSize = Math.min(MAX_LABEL_SIZE, rowHeight * LABEL_SHARE);
  const labelRight = state.reading ? widestLabel(state, labelSize) : 0;
  const keyLeft = state.reading ? labelRight + LABEL_GAP : 0;
  const gridLeft = keyLeft + KEY_WIDTH;
  return { labelRight, keyLeft, gridLeft, gridTop, gridBottom, rowHeight, columnWidth: (WIDTH - gridLeft) / state.beats, labelSize };
}

function rowTop(state: MusicState, frame: Layout, midi: number): number {
  return frame.gridTop + (state.high - midi) * frame.rowHeight;
}

function columnLeft(frame: Layout, beat: number): number {
  return frame.gridLeft + beat * frame.columnWidth;
}

function halfBeats(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value * 2);
}

function beatLabel(start: number): string {
  return String(start + 1);
}

function cursorOf(state: MusicState): number {
  return Math.max(0, ...state.events.map((event) => event.start + event.length));
}

function startArg(state: MusicState, op: LabOp): number {
  const beat = op.args.beat;
  if (beat === undefined) return cursorOf(state);
  if (!halfBeats(beat) || (beat as number) < 1 || (beat as number) > state.beats) {
    fail(`op "${op.name}": "beat" must be a beat from 1 to ${state.beats} (halves such as 2.5 allowed), got ${JSON.stringify(beat)}`);
  }
  return (beat as number) - 1;
}

function lengthArg(op: LabOp): number {
  const length = op.args.length ?? 1;
  if (!halfBeats(length) || (length as number) <= 0 || (length as number) > MAX_LENGTH) {
    fail(`op "${op.name}": "length" must be a number of beats such as 1, 2 or 0.5, got ${JSON.stringify(length)}`);
  }
  return length as number;
}

function onRoll(state: MusicState, value: unknown, where: string, opName: string): number {
  const midi = parsePitch(value, where);
  if (midi < state.low || midi > state.high) {
    const flats = flatSpelled(value) ? [...state.flats, midi] : state.flats;
    fail(`op "${opName}": ${pitchName(midi, flats)} is off the roll, which runs from ${pitchName(state.low, state.flats)} to ${pitchName(state.high, state.flats)}; pick a pitch in that range or widen "low" and "high" in the spec`);
  }
  return midi;
}

function overlaps(event: MusicEvent, start: number, length: number): boolean {
  return start < event.start + event.length && event.start < start + length;
}

function clashingEvent(state: MusicState, kind: EventKind, pitches: number[], start: number, length: number): MusicEvent | undefined {
  return state.events.find((event) => {
    if (!overlaps(event, start, length)) return false;
    if (kind === "rest" || event.kind === "rest") return true;
    return event.pitches.some((midi) => pitches.includes(midi));
  });
}

function freeBeats(state: MusicState, kind: EventKind, pitches: number[], length: number): number[] {
  return Array.from({ length: state.beats }, (_, start) => start).filter((start) => start + length <= state.beats && !clashingEvent(state, kind, pitches, start, length));
}

function freeBeatsAdvice(state: MusicState, kind: EventKind, pitches: number[], length: number): string {
  const subject = kind === "rest" ? "a rest" : pitches.map((midi) => pitchName(midi, state.flats)).join(" ");
  const free = freeBeats(state, kind, pitches, length).map(beatLabel);
  if (free.length === 0) return `no beat is free for ${subject} at length ${length}, and the roll has ${state.beats} beats; shorten "length", use other pitches, or raise "beats" in the spec`;
  return `pick one of the beats free for ${subject} at length ${length}: ${free.join(", ")}`;
}

function clashOf(state: MusicState, kind: EventKind, pitches: number[], start: number, length: number): string | null {
  const clash = clashingEvent(state, kind, pitches, start, length);
  if (!clash) return null;
  const what = clash.kind === "rest" ? "a rest" : clash.pitches.map((midi) => pitchName(midi, state.flats)).join(" ");
  return `${what} already fills beat ${beatLabel(clash.start)}; ${freeBeatsAdvice(state, kind, pitches, length)}`;
}

function placed(state: MusicState, op: LabOp, kind: EventKind, pitches: number[]): MusicState {
  const start = startArg(state, op);
  const length = lengthArg(op);
  if (start + length > state.beats) {
    fail(`op "${op.name}": ${length} beats from beat ${beatLabel(start)} runs past beat ${state.beats}, the last beat on the roll; shorten "length", start earlier, or raise "beats" in the spec`);
  }
  const clash = clashOf(state, kind, pitches, start, length);
  if (clash) fail(`op "${op.name}" at beat ${beatLabel(start)}: ${clash}`);
  const event: MusicEvent = { id: `e${state.events.length}`, kind, pitches, start, length };
  return { ...state, events: [...state.events, event] };
}

function notePitch(state: MusicState, op: LabOp): number {
  return onRoll(state, op.args.pitch, `op "note": "pitch"`, op.name);
}

function chordPitches(state: MusicState, op: LabOp): number[] {
  const raw = op.args.pitches;
  if (!Array.isArray(raw) || raw.length < MIN_CHORD || raw.length > MAX_CHORD) {
    fail(`op "chord" needs "pitches" as a list of ${MIN_CHORD} to ${MAX_CHORD} pitches, such as ["C4", "E4", "G4"]`);
  }
  const pitches = raw.map((value, index) => onRoll(state, value, `op "chord": pitches[${index}]`, op.name));
  if (new Set(pitches).size !== pitches.length) fail(`op "chord": "pitches" lists the same pitch twice; give each pitch once`);
  return [...pitches].sort((a, b) => b - a);
}

function scaleSteps(op: LabOp): number[] {
  const kind = op.args.kind ?? "major";
  const steps = typeof kind === "string" ? SCALE_STEPS[kind] : undefined;
  if (!steps) fail(`op "scale": "kind" must be one of ${Object.keys(SCALE_STEPS).join(", ")}, got ${JSON.stringify(kind)}`);
  return steps;
}

function rootLetter(root: unknown): string {
  return String(root).slice(0, -1);
}

function scaleOf(state: MusicState, op: LabOp): Scale {
  const root = parsePitch(op.args.root, `op "scale": "root"`);
  const steps = scaleSteps(op);
  const pitches = steps.map((step) => root + step);
  const top = pitches[pitches.length - 1]!;
  if (root < state.low || top > state.high) {
    fail(
      `op "scale": ${pitchName(root)} ${op.args.kind ?? "major"} runs from ${pitchName(root)} to ${pitchName(top)}, but the roll runs from ${pitchName(state.low)} to ${pitchName(state.high)}; pick another "root" or widen "low" and "high" in the spec`,
    );
  }
  return { name: `${rootLetter(op.args.root)} ${op.args.kind ?? "major"}`, pitches };
}

function noted(state: MusicState, op: LabOp): MusicState {
  const pitch = notePitch(state, op);
  return withFlats(placed(state, op, "note", [pitch]), flatSpelled(op.args.pitch) ? [pitch] : []);
}

function chorded(state: MusicState, op: LabOp): MusicState {
  const pitches = chordPitches(state, op);
  const spelledFlat = (op.args.pitches as unknown[]).filter(flatSpelled).map((value) => parsePitch(value, `op "chord": pitches`));
  return withFlats(placed(state, op, "chord", pitches), spelledFlat);
}

function scaled(state: MusicState, op: LabOp): MusicState {
  const scale = scaleOf(state, op);
  return withFlats({ ...state, scale }, flatSpelled(op.args.root) ? scale.pitches : []);
}

function tempoArg(op: LabOp): number {
  return integerArg(op.args, "bpm", op.name, MIN_BPM, MAX_BPM);
}

function secondsPerBeat(bpm: number): number {
  return SECONDS_PER_MINUTE / bpm;
}

function sweepSeconds(op: LabOp, state: MusicState): number {
  return state.beats * secondsPerBeat(tempoArg(op));
}

function scaleSeconds(op: LabOp): number {
  return scaleSteps(op).length * SCALE_STEP_SECONDS;
}

function rowDrawables(state: MusicState, frame: Layout): Drawable[] {
  return rowPitches(state).flatMap((midi): Drawable[] => {
    const top = rowTop(state, frame, midi);
    const sharp = isBlackKey(midi);
    const row = [
      boxDrawable(`row-${midi}`, { x: frame.gridLeft, y: top, w: WIDTH - frame.gridLeft, h: frame.rowHeight }, { fill: sharp ? "fill2" : "fill", stroke: "rule", strokeWidth: 1, z: 0 }),
      boxDrawable(`key-${midi}`, { x: frame.keyLeft, y: top, w: KEY_WIDTH, h: frame.rowHeight }, { fill: sharp ? "edge" : "fill2", stroke: "rule", strokeWidth: 1, z: 1 }),
    ];
    if (!state.reading) return row;
    const look = { size: frame.labelSize, font: "read" as const, anchor: "end" as const, fill: "ink" as const, z: 1 };
    return [...row, textDrawable(`label-${midi}`, pitchName(midi, state.flats), { x: frame.labelRight, y: top + frame.rowHeight / 2 }, look)];
  });
}

function beatLineDrawables(state: MusicState, frame: Layout): Drawable[] {
  return Array.from({ length: state.beats + 1 }, (_, beat): Drawable => {
    const x = columnLeft(frame, beat);
    const bar = beat % BAR_BEATS === 0;
    return { id: `beat-line-${beat}`, kind: "line", x, y: frame.gridTop, x2: x, y2: frame.gridBottom, stroke: bar ? "edge" : "rule", strokeWidth: bar ? 2 : 1, z: 2 };
  });
}

function beatLabelDrawables(state: MusicState, frame: Layout, playing: number | null): Drawable[] {
  if (!state.reading) return [];
  return Array.from({ length: state.beats }, (_, beat) => {
    const current = playing !== null && Math.floor(playing) === beat;
    const at = { x: columnLeft(frame, beat + 0.5), y: frame.gridBottom + BEAT_LABEL_OFFSET };
    return textDrawable(`beat-${beat}`, beatLabel(beat), at, { size: BEAT_LABEL_SIZE, font: current ? "mark" : "read", fill: current ? "ink" : "muted", z: 1 });
  });
}

function headerDrawables(state: MusicState): Drawable[] {
  if (!state.reading) return [];
  const tempo = textDrawable("tempo", `${state.tempo} beats per minute`, { x: 0, y: HEADER_TEXT_Y }, { size: HEADER_SIZE, anchor: "start", z: 1 });
  if (!state.scale) return [tempo];
  return [tempo, textDrawable("scale-name", `${state.scale.name} scale`, { x: WIDTH, y: HEADER_TEXT_Y }, { size: HEADER_SIZE, anchor: "end", fill: "muted", z: 1 })];
}

function columnSpan(frame: Layout, event: MusicEvent, inset: number, grown: number): Pick<Rect, "x" | "w"> {
  return { x: columnLeft(frame, event.start) + inset, w: Math.max(0, (event.length * frame.columnWidth - inset * 2) * grown) };
}

function noteDrawables(state: MusicState, frame: Layout, event: MusicEvent, span: Pick<Rect, "x" | "w">, sounding: boolean): Drawable[] {
  return event.pitches.map((midi, index) => {
    const rect = { ...span, y: rowTop(state, frame, midi) + NOTE_INSET, h: frame.rowHeight - NOTE_INSET * 2 };
    return boxDrawable(`${event.id}-${index}`, rect, { fill: sounding ? "ink" : EVENT_COLOR[event.kind], stroke: "none", radius: 1, z: 4 });
  });
}

function insetSpan(span: Pick<Rect, "x" | "w">, inset: number): Pick<Rect, "x" | "w"> {
  return { x: span.x + inset, w: Math.max(0, span.w - inset * 2) };
}

function chordDrawables(state: MusicState, frame: Layout, event: MusicEvent, grown: number, sounding: boolean): Drawable[] {
  const span = columnSpan(frame, event, OUTLINE_INSET, grown);
  const top = rowTop(state, frame, event.pitches[0]!) + NOTE_INSET - CHORD_PAD;
  const bottom = rowTop(state, frame, event.pitches[event.pitches.length - 1]!) + frame.rowHeight - NOTE_INSET + CHORD_PAD;
  const outline = boxDrawable(`${event.id}-frame`, { ...span, y: top, h: bottom - top }, { fill: "none", stroke: EVENT_COLOR.chord, strokeWidth: FRAME_STROKE, radius: 1, z: 3 });
  return [outline, ...noteDrawables(state, frame, event, insetSpan(span, CHORD_PAD), sounding)];
}

function restLabel(state: MusicState, event: MusicEvent, center: Point, grown: number): Drawable[] {
  if (!state.reading) return [];
  return [textDrawable(`${event.id}-label`, REST_LABEL, center, { size: REST_LABEL_SIZE, fill: "ink", opacity: grown, z: 4 })];
}

function restDrawables(state: MusicState, frame: Layout, event: MusicEvent, grown: number): Drawable[] {
  const span = columnSpan(frame, event, OUTLINE_INSET, grown);
  const outline = { ...span, y: frame.gridTop + FRAME_INSET, h: frame.gridBottom - frame.gridTop - FRAME_INSET * 2 };
  const barWidth = Math.min(REST_BAR_MAX, span.w * REST_BAR_SHARE);
  const labelRow = Math.floor(rowCount(state) / 2);
  const rowMiddle = (row: number) => frame.gridTop + (row + 0.5) * frame.rowHeight;
  const bar = { x: span.x + (span.w - barWidth) / 2, y: rowMiddle(labelRow - 1) - REST_BAR_HEIGHT / 2, w: barWidth, h: REST_BAR_HEIGHT };
  const labelAt = { x: span.x + span.w / 2, y: rowMiddle(labelRow) };
  return [
    boxDrawable(`${event.id}-frame`, outline, { fill: "fill", stroke: EVENT_COLOR.rest, strokeWidth: FRAME_STROKE, radius: 1, z: 3 }),
    boxDrawable(`${event.id}-bar`, bar, { fill: EVENT_COLOR.rest, stroke: "none", z: 4 }),
    ...restLabel(state, event, labelAt, grown),
  ];
}

function eventDrawables(state: MusicState, frame: Layout, event: MusicEvent, grown = 1, playing: number | null = null): Drawable[] {
  if (event.kind === "rest") return restDrawables(state, frame, event, grown);
  const sounding = playing !== null && playing >= event.start && playing < event.start + event.length;
  if (event.kind === "chord") return chordDrawables(state, frame, event, grown, sounding);
  return noteDrawables(state, frame, event, columnSpan(frame, event, NOTE_INSET, grown), sounding);
}

function keyDotDrawables(state: MusicState, frame: Layout, shown: number): Drawable[] {
  const scale = state.scale;
  if (!scale) return [];
  const lit = new Set(scale.pitches.slice(0, shown));
  const radius = Math.min(KEY_DOT_MAX, frame.rowHeight * KEY_DOT_SHARE);
  return rowPitches(state).map(
    (midi): Drawable => ({
      id: `key-dot-${midi}`,
      kind: "circle",
      x: frame.keyLeft + KEY_WIDTH / 2,
      y: rowTop(state, frame, midi) + frame.rowHeight / 2,
      r: radius,
      fill: lit.has(midi) ? "ok" : "none",
      stroke: lit.has(midi) ? "ground" : "ink",
      strokeWidth: KEY_DOT_STROKE,
      z: 5,
    }),
  );
}

type Span = [number, number];

function subtractSpans(from: Span, cuts: Span[]): Span[] {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const pieces: Span[] = [];
  let at = from[0];
  sorted.forEach(([start, end]) => {
    if (start > at) pieces.push([at, Math.min(start, from[1])]);
    at = Math.max(at, end);
  });
  if (at < from[1]) pieces.push([at, from[1]]);
  return pieces.filter(([start, end]) => end - start >= MIN_PIECE);
}

function barSpans(state: MusicState, frame: Layout): Span[] {
  const bars = Math.ceil(state.beats / BAR_BEATS);
  return Array.from({ length: bars }, (_, bar): Span => {
    const first = bar * BAR_BEATS;
    const last = Math.min(state.beats, first + BAR_BEATS);
    return [columnLeft(frame, first) + (bar === 0 ? FRAME_INSET : BAND_CLEAR), columnLeft(frame, last) - (last === state.beats ? FRAME_INSET : BAND_CLEAR)];
  });
}

function restCuts(state: MusicState, frame: Layout): Span[] {
  return state.events
    .filter((event) => event.kind === "rest")
    .map((event): Span => {
      const span = columnSpan(frame, event, OUTLINE_INSET, 1);
      return [span.x - BAND_CLEAR, span.x + span.w + BAND_CLEAR];
    });
}

function scaleBand(state: MusicState, frame: Layout, midi: number): Drawable[] {
  const y = rowTop(state, frame, midi) + FRAME_INSET;
  const h = frame.rowHeight - FRAME_INSET * 2;
  const cuts = restCuts(state, frame);
  const pieces = barSpans(state, frame).flatMap((bar) => subtractSpans(bar, cuts));
  return pieces.map(([start, end], index) =>
    boxDrawable(`scale-band-${index}`, { x: start, y, w: end - start, h }, { fill: "none", stroke: "accent", strokeWidth: SCALE_BAND_STROKE, radius: 1, z: 6 }),
  );
}

function scaleRun(after: MusicState, progress: number): Drawable[] {
  const frame = layout(after);
  const pitches = after.scale!.pitches;
  const step = Math.min(pitches.length - 1, Math.floor(progress * pitches.length));
  return [...scaleBand(after, frame, pitches[step]!), ...keyDotDrawables(after, frame, step + 1)];
}

function growLatest(after: MusicState, progress: number): Drawable[] {
  const frame = layout(after);
  return eventDrawables(after, frame, after.events[after.events.length - 1]!, progress);
}

function eventBlock(state: MusicState, frame: Layout, event: MusicEvent): Rect {
  const column = columnSpan(frame, event, event.kind === "note" ? NOTE_INSET : OUTLINE_INSET, 1);
  if (event.kind === "rest") return { ...column, y: frame.gridTop + FRAME_INSET, h: frame.gridBottom - frame.gridTop - FRAME_INSET * 2 };
  if (event.kind === "note") return { ...column, y: rowTop(state, frame, event.pitches[0]!) + NOTE_INSET, h: frame.rowHeight - NOTE_INSET * 2 };
  const top = rowTop(state, frame, event.pitches[0]!) + NOTE_INSET - CHORD_PAD;
  const bottom = rowTop(state, frame, event.pitches[event.pitches.length - 1]!) + frame.rowHeight - NOTE_INSET + CHORD_PAD;
  return { ...column, y: top, h: bottom - top };
}

function playheadLines(state: MusicState, frame: Layout, x: number): Drawable[] {
  const reach = PLAYHEAD_STROKE + PLAYHEAD_CLEAR;
  const cuts = state.events
    .map((event) => eventBlock(state, frame, event))
    .filter((block) => x + reach > block.x && x - reach < block.x + block.w)
    .map((block): Span => [block.y - reach, block.y + block.h + reach]);
  const pieces = subtractSpans([frame.gridTop + reach, frame.gridBottom - reach], cuts);
  return pieces.map(([top, bottom], index): Drawable => ({ id: `playhead-${index}`, kind: "line", x, y: top, x2: x, y2: bottom, stroke: "accent", strokeWidth: PLAYHEAD_STROKE, z: PLAYHEAD_Z }));
}

function playheadSweep(after: MusicState, progress: number): Drawable[] {
  const frame = layout(after);
  const playing = Math.min(after.beats - 1e-6, progress * after.beats);
  const x = columnLeft(frame, Math.floor(playing) + 0.5);
  const notes = after.events.filter((event) => event.kind !== "rest").flatMap((event) => eventDrawables(after, frame, event, 1, playing));
  return [...playheadLines(after, frame, x), ...notes, ...beatLabelDrawables(after, frame, playing)];
}

function heldNotes(event: MusicEvent, offset: number, beatSeconds: number): Played[] {
  return event.pitches.map((midi) => ({ midi, at: offset + event.start * beatSeconds, hold: event.length * beatSeconds, volume: NOTE_VOLUME }));
}

function clicks(count: number, from: number, beatSeconds: number): Played[] {
  return Array.from({ length: count }, (_, beat) => ({ midi: CLICK_MIDI, at: (from + beat) * beatSeconds, hold: CLICK_HOLD, volume: CLICK_VOLUME }));
}

function placedSound(state: MusicState, op: LabOp, pitches: number[]): Played[] {
  const event: MusicEvent = { id: "sound", kind: "note", pitches, start: 0, length: lengthArg(op) };
  return heldNotes(event, 0, secondsPerBeat(state.tempo));
}

async function play(notes: Played[]): Promise<void> {
  const tone = await import("tone");
  await tone.start();
  const now = tone.now();
  notes.forEach((note) => {
    const voice = new tone.Synth({ volume: note.volume }).toDestination();
    voice.onsilence = () => voice.dispose();
    voice.triggerAttackRelease(tone.Frequency(note.midi, "midi").toFrequency(), note.hold, now + note.at);
  });
}

export const lab: LabDef<MusicSpec, MusicState> = {
  id: "music",
  title: "Music",
  reading: "optional",
  catalog: {
    summary:
      "Music you see and hear: notes, rhythm and beats, tempo, scales, intervals, chords and harmony, and why a chord or melody sounds the way it does. A piano roll: rows are pitches named by letter and octave (high at the top; a black key reads as a sharp, such as D#4, until a note, chord or scale spells it with a flat, such as Eb4, and then that row reads Eb4), columns are numbered beats. Notes sit on their pitch row across their beats, rests are framed silent gaps, chords are stacked notes in one frame, tempo plays the roll back with a playhead, and a scale lights its notes in turn. Every op also sounds. Every op targets the whole roll object.",
    spec: {
      low: 'lowest pitch row, such as "C4" (letter A to G, optional # or b, octave 0 to 8); default "C4"',
      high: `highest pitch row, above low; default "C5"; low to high is at most ${MAX_ROWS} rows (semitones), so C4 to F5 is the widest from C4`,
      beats: `number of beat columns, a whole number from ${MIN_BEATS} to ${MAX_BEATS}; default 8; a thicker line marks every ${BAR_BEATS} beats`,
      tempo: `starting tempo in beats per minute, a whole number from ${MIN_BPM} to ${MAX_BPM}; default 90; shown at the top`,
      reading: "optional boolean, default true; false draws no pitch names, beat numbers or tempo, only rows, keys, notes, rests and the playhead",
    },
    example: [
      '{"step":1,"say":"Middle C on beat one, then E, then a beat of rest. Then C, E and G together make a chord.","scene":{"roll":{"lab":"music","low":"C4","high":"C5","beats":8,"tempo":90}},"do":[{"cue":"Middle C","op":"note","on":["roll"],"pitch":"C4","beat":1},{"cue":"then E","op":"note","on":["roll"],"pitch":"E4"},{"cue":"rest","op":"rest","on":["roll"]},{"cue":"together","op":"chord","on":["roll"],"pitches":["C4","E4","G4"],"beat":4,"length":2}]}',
    ],
  },

  init(spec, objectId) {
    const fields = spec as Record<string, unknown>;
    if (spec.reading !== undefined && typeof spec.reading !== "boolean") fail(`${objectId}: "reading" must be true or false`);
    return {
      objectId,
      reading: readsWords(fields),
      ...rangeOf(spec, objectId),
      beats: integerField(fields, "beats", 8, MIN_BEATS, MAX_BEATS, objectId),
      tempo: integerField(fields, "tempo", 90, MIN_BPM, MAX_BPM, objectId),
      events: [],
      scale: null,
      flats: [],
    };
  },

  ops: {
    note: {
      doc: '{"pitch": "E4", "beat": 3, "length": 1}; one note on its pitch row from that beat for "length" beats (default 1, halves such as 0.5 allowed); "beat" counts from 1 and defaults to the beat right after the last thing placed; the pitch must be on the roll and not already sounding then; if the beat is taken the error lists the beats that are free',
      seconds: NOTE_SECONDS,
      apply: (state, op) => noted(state, op),
      during: (_before, after, _op, progress) => growLatest(after, progress),
      sound: (op, state) => void play(placedSound(state, op, [notePitch(state, op)])),
    },
    rest: {
      doc: '{"beat": 4, "length": 1}; a framed silent gap across those beats, with nothing else sounding there; "beat" and "length" work as in note',
      seconds: REST_SECONDS,
      apply: (state, op) => placed(state, op, "rest", []),
      during: (_before, after, _op, progress) => growLatest(after, progress),
      sound: (op, state) => void play(clicks(Math.ceil(lengthArg(op)), 0, secondsPerBeat(state.tempo))),
    },
    chord: {
      doc: `{"pitches": ["C4", "E4", "G4"], "beat": 5, "length": 2}; ${MIN_CHORD} to ${MAX_CHORD} notes stacked in one column and framed together, sounding at once; "beat" and "length" work as in note`,
      seconds: CHORD_SECONDS,
      apply: (state, op) => chorded(state, op),
      during: (_before, after, _op, progress) => growLatest(after, progress),
      sound: (op, state) => void play(placedSound(state, op, chordPitches(state, op))),
    },
    tempo: {
      doc: `{"bpm": 120}; sets the tempo (${MIN_BPM} to ${MAX_BPM} beats per minute) and plays the whole roll once: a playhead sweeps the beats at that speed and each note lights as it sounds, so a faster tempo passes the same beats sooner`,
      seconds: sweepSeconds,
      trueTime: true,
      apply: (state, op) => ({ ...state, tempo: tempoArg(op) }),
      during: (_before, after, _op, progress) => playheadSweep(after, progress),
      sound(op, state) {
        const beatSeconds = secondsPerBeat(tempoArg(op));
        const notes = state.events.filter((event) => event.kind !== "rest").flatMap((event) => heldNotes(event, 0, beatSeconds));
        void play([...clicks(state.beats, 0, beatSeconds), ...notes]);
      },
    },
    scale: {
      doc: `{"root": "C4", "kind": "major"}; kind is ${Object.keys(SCALE_STEPS).join(", ")} (default major); the scale's notes are lit one at a time from the root upward, a band moving up row by row, and stay marked with a dot on their keys; every note must be on the roll`,
      seconds: scaleSeconds,
      apply: (state, op) => scaled(state, op),
      during: (_before, after, _op, progress) => scaleRun(after, progress),
      sound(op, state) {
        const notes = scaleOf(state, op).pitches.map((midi, index) => ({ midi, at: index * SCALE_STEP_SECONDS, hold: SCALE_STEP_SECONDS, volume: NOTE_VOLUME }));
        void play(notes);
      },
    },
  },

  size() {
    return { w: WIDTH, h: HEIGHT };
  },

  draw(state) {
    const frame = layout(state);
    return [
      ...headerDrawables(state),
      ...rowDrawables(state, frame),
      ...beatLineDrawables(state, frame),
      ...beatLabelDrawables(state, frame, null),
      ...state.events.flatMap((event) => eventDrawables(state, frame, event)),
      ...keyDotDrawables(state, frame, state.scale?.pitches.length ?? 0),
    ];
  },
};
