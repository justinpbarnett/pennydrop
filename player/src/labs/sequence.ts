import { boxDrawable, clamp01, type Drawable, fail, type FontRole, type LabDef, type LabOp, lerp, type Paint, type Point, type Role, readsWords, stringArg, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

type Status = "flight" | "arrived" | "dropped";

interface MessageRow {
  kind: "message";
  from: number;
  to: number;
  label: string;
  status: Status;
  retry: boolean;
}

interface TimeoutRow {
  kind: "timeout";
  at: number;
  since: number;
}

type Row = MessageRow | TimeoutRow;

interface SequenceState {
  objectId: string;
  reading: boolean;
  participants: string[];
  rows: Row[];
}

interface SequenceSpec {
  participants?: unknown;
  reading?: unknown;
}

interface Columns {
  boxWidth: number;
  pitch: number;
}

interface Path {
  start: Point;
  end: Point;
}

interface Label {
  text: string;
  at: Point;
  size: number;
}

const SERIES: Role[] = ["series1", "series2", "series3", "series4", "series5", "series6"];
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 5;
const MAX_ROWS = 16;
const ROW_MIN_PITCH = 86;
const BOX_MIN_GAP = 24;

const WIDTH = 1480;
const HEIGHT = 780;
const HEAD_HEIGHT = 92;
const BOX_MAX_WIDTH = 340;
const BOX_SHARE = 0.5;
const BOX_TEXT_PADDING = 20;
const NAME_MAX_SIZE = 38;
const NAME_MIN_SIZE = 28;
const FIT_TOLERANCE = 0.5;

const ROW_TOP_PAD = 20;
const LABEL_MAX_SIZE = 30;
const LABEL_MIN_SIZE = 28;
const LABEL_LINE_CLEAR = 26;
const LABEL_SIDE_CLEAR = 30;
const LABEL_ABOVE_LINE = 28;
const LINE_BREAK_CLEAR = 12;
const ARRIVAL_PAD = 8;
const ARROW_SHORT = 6;
const START_OFFSET = ROW_TOP_PAD + LABEL_MAX_SIZE + LABEL_LINE_CLEAR;

const MESSAGE_STROKE = 3;
const LIFELINE_STROKE = 2;
const BOX_STROKE = 3;
const DOT_RADIUS = 9;
const CROSS_HALF = 12;
const CROSS_STROKE = 4;
const CLOCK_RADIUS = 20;
const CLOCK_STROKE = 3;
const HAND_LONG = 12;
const HAND_SHORT = 9;
const TIMER_STROKE = 6;
const TIMER_GAP = 14;
const TIMEOUT_TEXT = "timeout";
const TIMEOUT_SIZE = 28;
const TIMEOUT_GAP = 16;

function messageColor(row: MessageRow): Role {
  return row.retry ? "warn" : SERIES[row.from]!;
}

function markWidth(text: string, size: number, font: FontRole): number {
  return Math.max(textWidth(text, size, font), textWidth(text.toUpperCase(), size, font));
}

function fittedSize(text: string, maxSize: number, room: number, font: FontRole): number {
  return Math.min(maxSize, (room / markWidth(text, 100, font)) * 100);
}

function boxLimit(count: number): number {
  return (WIDTH - BOX_MIN_GAP * (count - 1)) / count;
}

function columns(names: string[]): Columns {
  const count = names.length;
  const base = Math.min(BOX_MAX_WIDTH, (WIDTH / count) * BOX_SHARE + BOX_TEXT_PADDING * 2);
  const needed = Math.max(0, ...names.map((name) => markWidth(name, NAME_MIN_SIZE, "mark") + BOX_TEXT_PADDING * 2));
  const boxWidth = Math.max(base, Math.min(boxLimit(count), needed));
  return { boxWidth, pitch: (WIDTH - boxWidth) / (count - 1) };
}

function nameRoom(boxWidth: number): number {
  return boxWidth - BOX_TEXT_PADDING * 2;
}

function nameFits(name: string, boxWidth: number): boolean {
  return markWidth(name, NAME_MIN_SIZE, "mark") <= nameRoom(boxWidth) + FIT_TOLERANCE;
}

function nameSize(name: string, boxWidth: number): number {
  return Math.max(NAME_MIN_SIZE, fittedSize(name, NAME_MAX_SIZE, nameRoom(boxWidth), "mark"));
}

function columnX(state: SequenceState, index: number): number {
  const { boxWidth, pitch } = columns(state.participants);
  return boxWidth / 2 + index * pitch;
}

function height(state: SequenceState): number {
  return Math.max(HEIGHT, HEAD_HEIGHT + state.rows.length * ROW_MIN_PITCH);
}

function rowPitch(state: SequenceState): number {
  return (height(state) - HEAD_HEIGHT) / Math.max(1, state.rows.length);
}

function rowTop(state: SequenceState, index: number): number {
  return HEAD_HEIGHT + index * rowPitch(state);
}

function direction(row: MessageRow): number {
  return row.to > row.from ? 1 : -1;
}

function messagePath(state: SequenceState, index: number, row: MessageRow): Path {
  const top = rowTop(state, index);
  const startY = top + START_OFFSET;
  const endY = Math.max(startY, top + rowPitch(state) - ARRIVAL_PAD);
  return {
    start: { x: columnX(state, row.from), y: startY },
    end: { x: columnX(state, row.to) - direction(row) * ARROW_SHORT, y: endY },
  };
}

function pointAlong(path: Path, share: number): Point {
  return { x: lerp(path.start.x, path.end.x, share), y: lerp(path.start.y, path.end.y, share) };
}

function labelRoom(names: string[], from: number, to: number): number {
  return columns(names).pitch * Math.abs(to - from) - LABEL_SIDE_CLEAR * 2;
}

function labelSize(names: string[], from: number, to: number, text: string): number {
  return Math.max(LABEL_MIN_SIZE, fittedSize(text, LABEL_MAX_SIZE, labelRoom(names, from, to), "read"));
}

function messageLabel(state: SequenceState, index: number, row: MessageRow): Label {
  const path = messagePath(state, index, row);
  const middle = pointAlong(path, 0.5);
  const size = labelSize(state.participants, row.from, row.to, row.label);
  const width = markWidth(row.label, size, "read");
  const slope = Math.abs((path.end.y - path.start.y) / (path.end.x - path.start.x));
  const rise = (slope * width) / 2;
  const x = Math.min(WIDTH - width / 2, Math.max(width / 2, middle.x));
  return { text: row.label, at: { x, y: middle.y - rise - LABEL_ABOVE_LINE - size / 2 }, size };
}

function readParticipants(raw: unknown, objectId: string): string[] {
  const example = '"participants": ["Client", "Server"]';
  if (!Array.isArray(raw)) fail(`${objectId}: "participants" must be a list of names such as ${example}`);
  if (raw.length < MIN_PARTICIPANTS || raw.length > MAX_PARTICIPANTS) fail(`${objectId}: "participants" needs ${MIN_PARTICIPANTS} to ${MAX_PARTICIPANTS} names, got ${raw.length}`);
  const names = raw.map((name, index) => {
    if (typeof name !== "string" || name.trim() === "") fail(`${objectId}: participants[${index}] must be a name as text, such as "Client"`);
    if (raw.indexOf(name) !== index) fail(`${objectId}: participant "${name}" appears twice; names must be unique`);
    return name as string;
  });
  const { boxWidth } = columns(names);
  for (const name of names)
    if (!nameFits(name, boxWidth)) fail(`${objectId}: participant name "${name}" is too long for ${names.length} participants; shorten it, such as "Auth" for "Authentication server"`);
  return names;
}

function readReading(raw: unknown, objectId: string): boolean {
  if (raw !== undefined && typeof raw !== "boolean") fail(`${objectId}: "reading" must be true or false`);
  return readsWords({ reading: raw });
}

function participantArg(state: SequenceState, op: LabOp, key: string): number {
  const name = stringArg(op.args, key, op.name);
  const index = state.participants.indexOf(name);
  if (index < 0) fail(`op "${op.name}": ${state.objectId} has no participant "${name}" for "${key}"; participants are ${state.participants.join(", ")}`);
  return index;
}

function withRow(state: SequenceState, op: LabOp, row: Row): SequenceState {
  if (state.rows.length >= MAX_ROWS)
    fail(`op "${op.name}": ${state.objectId} already shows ${MAX_ROWS} messages and timeouts, the most that fit; start a new Step that places a fresh sequence object`);
  return { ...state, rows: [...state.rows, row] };
}

function checkLabel(state: SequenceState, op: LabOp, from: number, to: number, label: string): void {
  if (label.trim() === "") fail(`op "${op.name}": "label" must not be empty, such as "SYN"`);
  if (markWidth(label, LABEL_MIN_SIZE, "read") > WIDTH)
    fail(`op "${op.name}": label "${label}" is too long to fit between ${state.participants[from]} and ${state.participants[to]}; shorten it to a few words, such as "SYN" or "ClientHello"`);
}

function messageRows(state: SequenceState): { row: MessageRow; index: number }[] {
  return state.rows.flatMap((row, index) => (row.kind === "message" ? [{ row, index }] : []));
}

function inFlightIndex(state: SequenceState, op: LabOp): number {
  const wanted = op.args.label;
  if (wanted !== undefined && typeof wanted !== "string") fail(`op "${op.name}": "label" must be the text of a message in flight`);
  const flying = messageRows(state).filter(({ row }) => row.status === "flight");
  if (flying.length === 0) fail(`op "${op.name}": no message is in flight on ${state.objectId}; use send or retransmit first`);
  if (wanted === undefined) return flying[0]!.index;
  const match = flying.find(({ row }) => row.label === wanted);
  if (!match) fail(`op "${op.name}": no message "${wanted}" is in flight; in flight: ${flying.map(({ row }) => `"${row.label}"`).join(", ")}`);
  return match.index;
}

function withStatus(state: SequenceState, op: LabOp, status: Status): SequenceState {
  const target = inFlightIndex(state, op);
  return { ...state, rows: state.rows.map((row, index) => (index === target && row.kind === "message" ? { ...row, status } : row)) };
}

function send(state: SequenceState, op: LabOp): SequenceState {
  const from = participantArg(state, op, "from");
  const to = participantArg(state, op, "to");
  if (from === to) fail(`op "send": "from" and "to" are both ${state.participants[from]}; a message goes to another participant`);
  const label = stringArg(op.args, "label", "send");
  checkLabel(state, op, from, to, label);
  return withRow(state, op, { kind: "message", from, to, label, status: "flight", retry: false });
}

function retransmit(state: SequenceState, op: LabOp): SequenceState {
  const wanted = op.args.label;
  if (wanted !== undefined && typeof wanted !== "string") fail(`op "retransmit": "label" must be the text of a message sent earlier, such as "SYN"`);
  const sent = messageRows(state);
  const lost = sent.filter(({ row }) => row.status === "dropped").pop() ?? sent.filter(({ row }) => row.status !== "flight").pop();
  const label = wanted ?? lost?.row.label ?? "";
  const earlier = sent.filter(({ row }) => row.label === label).pop();
  if (!earlier)
    fail(
      `op "retransmit": ${state.objectId} has sent no message "${label}"; send it first, or name one of ${
        messageRows(state)
          .map(({ row }) => `"${row.label}"`)
          .join(", ") || "no messages yet"
      }`,
    );
  if (earlier.row.status === "flight") fail(`op "retransmit": "${label}" is still in flight; receive or drop it first`);
  return withRow(state, op, { ...earlier.row, status: "flight", retry: true });
}

function timeout(state: SequenceState, op: LabOp): SequenceState {
  const at = participantArg(state, op, "at");
  const sent = messageRows(state)
    .filter(({ row }) => row.from === at)
    .pop();
  if (!sent) fail(`op "timeout": ${state.participants[at]} has sent nothing yet, so it has no timer running; send a message from ${state.participants[at]} first`);
  return withRow(state, op, { kind: "timeout", at, since: sent.index });
}

function changedRow(before: SequenceState, after: SequenceState): number {
  return after.rows.findIndex((row, index) => row !== before.rows[index]);
}

function headDrawables(state: SequenceState): Drawable[] {
  const { boxWidth } = columns(state.participants);
  return state.participants.flatMap((name, index): Drawable[] => {
    const center = { x: columnX(state, index), y: HEAD_HEIGHT / 2 };
    const box = boxDrawable(`head-${index}`, { x: center.x - boxWidth / 2, y: 0, w: boxWidth, h: HEAD_HEIGHT }, { fill: "fill", stroke: SERIES[index]!, strokeWidth: BOX_STROKE, radius: 1, z: 2 });
    if (!state.reading) return [box];
    return [box, textDrawable(`name-${index}`, name, center, { size: nameSize(name, boxWidth), font: "mark", z: 3 })];
  });
}

function lifelineBreaks(state: SequenceState, participant: number): [number, number][] {
  if (!state.reading) return [];
  const x = columnX(state, participant);
  return messageRows(state).flatMap(({ row, index }): [number, number][] => {
    const label = messageLabel(state, index, row);
    if (Math.abs(label.at.x - x) > markWidth(label.text, label.size, "read") / 2 + LINE_BREAK_CLEAR) return [];
    const half = label.size / 2 + LINE_BREAK_CLEAR;
    return [[label.at.y - half, label.at.y + half]];
  });
}

function lifelineDrawables(state: SequenceState): Drawable[] {
  return state.participants.flatMap((_, participant) => {
    const x = columnX(state, participant);
    const stops = [HEAD_HEIGHT, ...lifelineBreaks(state, participant).flat(), height(state)];
    return Array.from(
      { length: stops.length / 2 },
      (_, piece): Drawable => ({
        id: piece === 0 ? `life-${participant}` : `life-${participant}-${piece}`,
        kind: "line",
        x,
        y: stops[piece * 2]!,
        x2: x,
        y2: stops[piece * 2 + 1]!,
        stroke: "edge",
        strokeWidth: LIFELINE_STROKE,
        z: 0,
      }),
    );
  });
}

function segment(id: string, kind: "line" | "arrow", from: Point, to: Point, stroke: Paint, strokeWidth: number, z: number): Drawable {
  return { id, kind, x: from.x, y: from.y, x2: to.x, y2: to.y, stroke, strokeWidth, z };
}

function dotDrawable(id: string, at: Point, fill: Role, radius = DOT_RADIUS): Drawable {
  return { id, kind: "circle", x: at.x, y: at.y, r: radius, fill, stroke: "none", z: 5 };
}

function crossDrawables(id: string, at: Point, scale: number): Drawable[] {
  const reach = CROSS_HALF * scale;
  return [
    segment(`${id}-cross-a`, "line", { x: at.x - reach, y: at.y - reach }, { x: at.x + reach, y: at.y + reach }, "fault", CROSS_STROKE, 6),
    segment(`${id}-cross-b`, "line", { x: at.x - reach, y: at.y + reach }, { x: at.x + reach, y: at.y - reach }, "fault", CROSS_STROKE, 6),
  ];
}

function flightDrawables(id: string, path: Path, row: MessageRow, share: number): Drawable[] {
  const tip = pointAlong(path, share);
  return [segment(`${id}-path`, "line", path.start, tip, messageColor(row), MESSAGE_STROKE, 4), dotDrawable(`${id}-dot`, tip, messageColor(row))];
}

const MESSAGE_SHAPES: Record<Status, (id: string, path: Path, row: MessageRow) => Drawable[]> = {
  flight: (id, path, row) => flightDrawables(id, path, row, 0.5),
  arrived: (id, path, row) => [segment(`${id}-path`, "arrow", path.start, path.end, messageColor(row), MESSAGE_STROKE, 4)],
  dropped: (id, path) => [segment(`${id}-path`, "line", path.start, pointAlong(path, 0.5), "fault", MESSAGE_STROKE, 4), ...crossDrawables(id, pointAlong(path, 0.5), 1)],
};

function messageDrawables(state: SequenceState, index: number, row: MessageRow): Drawable[] {
  const id = `row-${index}`;
  const shapes = MESSAGE_SHAPES[row.status](id, messagePath(state, index, row), row);
  if (!state.reading) return shapes;
  const label = messageLabel(state, index, row);
  return [...shapes, textDrawable(`${id}-label`, label.text, label.at, { size: label.size, z: 5 })];
}

function clockCenter(state: SequenceState, index: number, row: TimeoutRow): Point {
  return { x: columnX(state, row.at), y: rowTop(state, index) + rowPitch(state) / 2 };
}

function labelSide(state: SequenceState, row: TimeoutRow): number {
  return row.at === state.participants.length - 1 ? -1 : 1;
}

function timerDrawable(state: SequenceState, index: number, row: TimeoutRow, share: number): Drawable {
  const sent = state.rows[row.since] as MessageRow;
  const top = messagePath(state, row.since, sent).start.y;
  const bottom = lerp(top, clockCenter(state, index, row).y - CLOCK_RADIUS, share);
  const x = columnX(state, row.at) - labelSide(state, row) * (TIMER_GAP + TIMER_STROKE / 2);
  return segment(`row-${index}-timer`, "line", { x, y: top }, { x, y: bottom }, "warn", TIMER_STROKE, 3);
}

function clockDrawables(state: SequenceState, index: number, row: TimeoutRow, scale: number): Drawable[] {
  const id = `row-${index}`;
  const center = clockCenter(state, index, row);
  const face: Drawable = { id: `${id}-clock`, kind: "circle", x: center.x, y: center.y, r: CLOCK_RADIUS * scale, fill: "fill", stroke: "warn", strokeWidth: CLOCK_STROKE, z: 6 };
  return [
    face,
    segment(`${id}-hand-a`, "line", center, { x: center.x, y: center.y - HAND_LONG * scale }, "warn", CLOCK_STROKE, 7),
    segment(`${id}-hand-b`, "line", center, { x: center.x + HAND_SHORT * scale, y: center.y }, "warn", CLOCK_STROKE, 7),
  ];
}

function timeoutLabel(state: SequenceState, index: number, row: TimeoutRow): Drawable {
  const center = clockCenter(state, index, row);
  const side = labelSide(state, row);
  const x = center.x + side * (CLOCK_RADIUS + TIMEOUT_GAP);
  return textDrawable(`row-${index}-label`, TIMEOUT_TEXT, { x, y: center.y }, { size: TIMEOUT_SIZE, anchor: side < 0 ? "end" : "start", fill: "muted", z: 5 });
}

function timeoutDrawables(state: SequenceState, index: number, row: TimeoutRow): Drawable[] {
  const marks = [timerDrawable(state, index, row, 1), ...clockDrawables(state, index, row, 1)];
  return state.reading ? [...marks, timeoutLabel(state, index, row)] : marks;
}

function rowDrawables(state: SequenceState, row: Row, index: number): Drawable[] {
  return row.kind === "message" ? messageDrawables(state, index, row) : timeoutDrawables(state, index, row);
}

function departing(_before: SequenceState, after: SequenceState, _op: LabOp, progress: number): Drawable[] {
  const index = after.rows.length - 1;
  const row = after.rows[index] as MessageRow;
  return flightDrawables(`row-${index}`, messagePath(after, index, row), row, lerp(0, 0.5, clamp01(progress)));
}

function arriving(before: SequenceState, after: SequenceState, _op: LabOp, progress: number): Drawable[] {
  const index = changedRow(before, after);
  const row = after.rows[index] as MessageRow;
  const path = messagePath(after, index, row);
  const share = lerp(0.5, 1, clamp01(progress));
  const clearedDot: Drawable = { ...dotDrawable(`row-${index}-dot`, pointAlong(path, 0.5), messageColor(row), 0), opacity: 0 };
  return [segment(`row-${index}-path`, "arrow", path.start, pointAlong(path, share), messageColor(row), MESSAGE_STROKE, 4), clearedDot];
}

function losing(before: SequenceState, after: SequenceState, _op: LabOp, progress: number): Drawable[] {
  const index = changedRow(before, after);
  const row = after.rows[index] as MessageRow;
  const mid = pointAlong(messagePath(after, index, row), 0.5);
  const fading = clamp01(1 - progress);
  return [dotDrawable(`row-${index}-dot`, mid, messageColor(row), DOT_RADIUS * fading), ...crossDrawables(`row-${index}`, mid, clamp01(progress))];
}

function timing(_before: SequenceState, after: SequenceState, _op: LabOp, progress: number): Drawable[] {
  const index = after.rows.length - 1;
  const row = after.rows[index] as TimeoutRow;
  const share = clamp01(progress);
  return [timerDrawable(after, index, row, share), ...clockDrawables(after, index, row, Math.max(0.1, share))];
}

export const lab: LabDef<SequenceSpec, SequenceState> = {
  id: "sequence",
  title: "Sequence diagram",
  reading: "optional",
  catalog: {
    summary:
      "A sequence diagram for protocols such as the TCP handshake, RPC, TLS and Kerberos: one lifeline per named participant, and each message an arrow that travels down and across from sender to receiver, so time runs top to bottom. A message can be lost mid-flight with a red cross, sent again, and a sender's timer can run out. Up to 16 messages and timeouts per object; every participant keeps one color.",
    spec: {
      participants: 'list of 2 to 5 short names, left to right, such as ["Client", "Server"]; each gets a lifeline and its own color',
      reading:
        "optional, default true; false draws no words: participants are told apart by color, a message by its arrow in the sender's color, a retransmit by a warn-colored arrow, a loss by a red cross and a timeout by a clock on the lifeline, so the narration must name them",
    },
    example: [
      '{"step":1,"say":"The client opens a connection with a SYN. The SYN is lost on the way, so the client\'s timer runs out and it sends the SYN again. This time the server gets it.","scene":{"tcp":{"lab":"sequence","participants":["Client","Server"]}},"do":[{"cue":"with a SYN","op":"send","on":["tcp"],"from":"Client","to":"Server","label":"SYN"},{"cue":"is lost","op":"drop","on":["tcp"]},{"cue":"timer runs out","op":"timeout","on":["tcp"],"at":"Client"},{"cue":"sends the SYN again","op":"retransmit","on":["tcp"],"label":"SYN"},{"cue":"server gets it","op":"receive","on":["tcp"]}]}',
    ],
  },

  init(spec, objectId) {
    return {
      objectId,
      reading: readReading(spec.reading, objectId),
      participants: readParticipants(spec.participants, objectId),
      rows: [],
    };
  },

  ops: {
    send: {
      doc: '{"from": "Client", "to": "Server", "label": "SYN"}; a new message row: the arrow leaves the sender and stops mid-flight, with its label over it; use receive or drop next. The label must be short (a few words) to fit between the two lifelines',
      seconds: 1.0,
      apply: send,
      during: departing,
    },
    receive: {
      doc: '{"label": "SYN"} optional; the message in flight reaches its receiver and gets its arrowhead; with no label, the oldest message in flight',
      seconds: 1.0,
      apply: (state, op) => withStatus(state, op, "arrived"),
      during: arriving,
    },
    drop: {
      doc: '{"label": "SYN"} optional; the message in flight is lost mid-flight: its line turns fault and a cross marks where it vanished; with no label, the oldest message in flight',
      seconds: 0.8,
      apply: (state, op) => withStatus(state, op, "dropped"),
      during: losing,
    },
    retransmit: {
      doc: '{"label": "SYN"} optional, default the latest dropped message; the latest message with that label is sent again between the same participants on a new row, drawn in the warn color and stopping mid-flight; then receive or drop it',
      seconds: 1.0,
      apply: retransmit,
      during: departing,
    },
    timeout: {
      doc: '{"at": "Client"}; a new row: a timer bar runs down the participant\'s lifeline from its last sent message to a clock marked "timeout"; the participant must have sent a message',
      seconds: 1.2,
      apply: timeout,
      during: timing,
    },
  },

  size(state) {
    return { w: WIDTH, h: height(state) };
  },

  draw(state) {
    return [...headDrawables(state), ...lifelineDrawables(state), ...state.rows.flatMap((row, index) => rowDrawables(state, row, index))];
  },
};
