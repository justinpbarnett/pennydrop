import { boxDrawable, clamp01, type Drawable, fail, fitText, type LabDef, type LabOp, lerp, numberArg, type Paint, type Point, type Role, segmentDrawable, stringArg, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

interface Process {
  id: string;
  burst: number;
  arrive: number;
  io: number | null;
  color: Role;
  remaining: number;
  level: number;
  blockedAt: number;
}

interface Slice {
  process: string | null;
  start: number;
  end: number;
}

interface Axis {
  end: number;
  step: number;
}

interface SchedulerState {
  objectId: string;
  policy: string | null;
  processes: Process[];
  levels: number;
  axis: Axis;
  incoming: string[];
  lanes: string[][];
  cpu: string | null;
  waiting: string[];
  finished: string[];
  clock: number;
  slices: Slice[];
}

interface SchedulerSpec {
  processes?: unknown;
  queues?: unknown;
  policy?: unknown;
}

type Area = "incoming" | "ready" | "cpu" | "io" | "finished";

interface Place {
  area: Area;
  level: number;
  index: number;
}

interface CardFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  compact: boolean;
  running: boolean;
}

const SERIES: Role[] = ["series1", "series2", "series3", "series4", "series5", "series6"];
const MAX_PROCESSES = SERIES.length;
const MAX_QUEUES = 4;
const MIN_AXIS_END = 6;
const AXIS_STEPS = [1, 2, 5, 10, 20, 50];
const MIN_TICK_PITCH = 48;

const WIDTH = 1480;
const HEADER_HEIGHT = 56;
const LANES_TOP = 76;
const LANE_HEIGHT = 104;
const LANE_GAP = 8;
const LANES_RIGHT = 940;
const AREA_LEFT_MARGIN = 16;
const BAND_GAP = 24;
const BAND_HEIGHT = 112;
const SIDE_LEFT = 1000;
const SIDE_WIDTH = WIDTH - SIDE_LEFT;
const GANTT_GAP = 32;
const TRACK_HEIGHT = 64;
const TRACK_LEFT = 84;
const TRACK_WIDTH = 1380;
const TICK_LENGTH = 10;
const TICK_LABEL_OFFSET = 32;
const BOTTOM_MARGIN = 50;

const CARD_WIDTH = 128;
const CARD_HEIGHT = 80;
const CARD_PITCH = CARD_WIDTH + 12;
const WAITING_FIRST_LEFT = 100;
const COMPACT_SIZE = 52;
const INCOMING_PITCH = 56;
const FINISHED_FIRST_LEFT = SIDE_LEFT + 104;
const FINISHED_PITCH = 60;

const BAR_INSET = 6;
const BAR_LABEL_SIZE = 22;
const BAR_LABEL_PADDING = 14;

function formatTime(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function positiveNumber(value: unknown, what: string, objectId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${objectId}: ${what} must be a positive number`);
  return value;
}

function readProcesses(raw: unknown, objectId: string): Omit<Process, "color" | "remaining" | "level" | "blockedAt">[] {
  const example = '"processes": [{"id":"P1","burst":5},{"id":"P2","burst":3,"arrive":2,"io":2}]';
  if (!Array.isArray(raw) || raw.length === 0) fail(`${objectId}: "processes" must be a non-empty list such as ${example}`);
  if (raw.length > MAX_PROCESSES) fail(`${objectId}: at most ${MAX_PROCESSES} processes fit on screen, got ${raw.length}; drop some`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const where = `processes[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail(`${objectId}: ${where} must be an object such as {"id":"P1","burst":5}`);
    const { id, burst, arrive, io } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "") fail(`${objectId}: ${where} needs an "id" as text, such as "P1"`);
    if (seen.has(id)) fail(`${objectId}: process id "${id}" appears twice; ids must be unique`);
    seen.add(id);
    if (arrive !== undefined && (typeof arrive !== "number" || !Number.isFinite(arrive) || arrive < 0)) fail(`${objectId}: ${where} "arrive" must be a time of 0 or more`);
    return {
      id,
      burst: positiveNumber(burst, `${where} "burst" (CPU time needed)`, objectId),
      arrive: (arrive as number | undefined) ?? 0,
      io: io === undefined ? null : positiveNumber(io, `${where} "io" (how long its I/O takes)`, objectId),
    };
  });
}

function readQueues(raw: unknown, objectId: string): number {
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_QUEUES) fail(`${objectId}: "queues" must be a whole number from 1 to ${MAX_QUEUES}`);
  return raw;
}

function timeAxis(processes: { burst: number; arrive: number; io: number | null }[]): Axis {
  const bound = processes.reduce((sum, process) => sum + process.burst + (process.io ?? 0), 0) + Math.max(...processes.map((process) => process.arrive));
  const raw = Math.max(MIN_AXIS_END, Math.ceil(bound));
  const step = AXIS_STEPS.find((candidate) => (candidate * TRACK_WIDTH) / raw >= MIN_TICK_PITCH) ?? AXIS_STEPS[AXIS_STEPS.length - 1]!;
  return { end: Math.ceil(raw / step) * step, step };
}

function processOf(state: SchedulerState, id: string): Process {
  return state.processes.find((process) => process.id === id)!;
}

function locate(state: SchedulerState, id: string): Place {
  const incoming = state.incoming.indexOf(id);
  if (incoming >= 0) return { area: "incoming", level: 0, index: incoming };
  for (let level = 0; level < state.lanes.length; level++) {
    const index = state.lanes[level]!.indexOf(id);
    if (index >= 0) return { area: "ready", level, index };
  }
  if (state.cpu === id) return { area: "cpu", level: 0, index: 0 };
  const waiting = state.waiting.indexOf(id);
  if (waiting >= 0) return { area: "io", level: 0, index: waiting };
  return { area: "finished", level: 0, index: state.finished.indexOf(id) };
}

function describePlace(state: SchedulerState, id: string): string {
  const place = locate(state, id);
  switch (place.area) {
    case "incoming": return `has not arrived yet (it arrives at t=${processOf(state, id).arrive}; use arrive)`;
    case "ready": return `is waiting in ready queue ${place.level}`;
    case "cpu": return "is on the CPU";
    case "io": return "is blocked on I/O (it needs wake first)";
    case "finished": return "has finished";
  }
}

function requireArea(state: SchedulerState, id: string, area: Area, opName: string, requirement: string): void {
  if (locate(state, id).area !== area) fail(`op "${opName}": ${id} ${describePlace(state, id)}, but ${requirement}`);
}

function processArg(state: SchedulerState, op: LabOp): string {
  const id = stringArg(op.args, "p", op.name);
  if (!state.processes.some((process) => process.id === id)) fail(`op "${op.name}": ${state.objectId} has no process "${id}"; processes are ${state.processes.map((process) => process.id).join(", ")}`);
  return id;
}

function levelArg(state: SchedulerState, op: LabOp, fallback: number): number {
  const level = op.args.level;
  if (level === undefined) return fallback;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level >= state.levels) fail(`op "${op.name}": "level" must be a whole number from 0 to ${state.levels - 1}`);
  return level;
}

function timeArg(state: SchedulerState, op: LabOp): number {
  const until = numberArg(op.args, "until", op.name);
  if (until <= state.clock) fail(`op "${op.name}": "until" must be later than the clock (t=${formatTime(state.clock)}), got ${until}`);
  if (until > state.axis.end) fail(`op "${op.name}": "until" ${until} is past the end of the time axis (t=${state.axis.end}); the axis fits the bursts, so check the bursts add up`);
  return until;
}

function withProcess(state: SchedulerState, id: string, change: Partial<Process>): SchedulerState {
  return { ...state, processes: state.processes.map((process) => (process.id === id ? { ...process, ...change } : process)) };
}

function enqueue(state: SchedulerState, id: string, level: number): SchedulerState {
  const lanes = state.lanes.map((lane, index) => (index === level ? [...lane, id] : lane));
  return { ...withProcess(state, id, { level }), lanes };
}

function dequeue(state: SchedulerState, id: string): SchedulerState {
  return { ...state, lanes: state.lanes.map((lane) => lane.filter((member) => member !== id)) };
}

function requireRunning(state: SchedulerState, op: LabOp): string {
  const id = processArg(state, op);
  requireArea(state, id, "cpu", op.name, `only the process on the CPU can ${op.name}`);
  return id;
}

function arrive(state: SchedulerState, op: LabOp): SchedulerState {
  const id = processArg(state, op);
  requireArea(state, id, "incoming", "arrive", "only a process that has not arrived can arrive");
  const { arrive: arrivalTime } = processOf(state, id);
  if (state.clock < arrivalTime) fail(`op "arrive": ${id} arrives at t=${arrivalTime} but the clock is t=${formatTime(state.clock)}; run or idle until then`);
  return enqueue({ ...state, incoming: state.incoming.filter((member) => member !== id) }, id, levelArg(state, op, 0));
}

function run(state: SchedulerState, op: LabOp): SchedulerState {
  const id = processArg(state, op);
  if (state.cpu !== null && state.cpu !== id) fail(`op "run": ${state.cpu} is on the CPU; preempt, block or finish it first`);
  requireArea(state, id, "ready", "run", "only a ready process can run");
  const until = timeArg(state, op);
  const process = processOf(state, id);
  const span = until - state.clock;
  if (span > process.remaining + 1e-9) fail(`op "run": ${id} has ${formatTime(process.remaining)} left, so it cannot run ${formatTime(span)} units to t=${until}; run until at most t=${formatTime(state.clock + process.remaining)}`);
  const slices = [...state.slices, { process: id, start: state.clock, end: until }];
  return { ...withProcess(dequeue(state, id), id, { remaining: Math.max(0, process.remaining - span) }), cpu: id, clock: until, slices };
}

function idle(state: SchedulerState, op: LabOp): SchedulerState {
  if (state.cpu !== null) fail(`op "idle": ${state.cpu} is on the CPU; the CPU can only idle when no process is on it`);
  const until = timeArg(state, op);
  return { ...state, clock: until, slices: [...state.slices, { process: null, start: state.clock, end: until }] };
}

function preempt(state: SchedulerState, op: LabOp): SchedulerState {
  const id = requireRunning(state, op);
  const process = processOf(state, id);
  if (process.remaining <= 0) fail(`op "preempt": ${id} has no burst left; use finish`);
  return enqueue({ ...state, cpu: null }, id, levelArg(state, op, process.level));
}

function block(state: SchedulerState, op: LabOp): SchedulerState {
  const id = requireRunning(state, op);
  if (processOf(state, id).remaining <= 0) fail(`op "block": ${id} has no burst left; use finish`);
  return { ...withProcess({ ...state, cpu: null }, id, { blockedAt: state.clock }), waiting: [...state.waiting, id] };
}

function wake(state: SchedulerState, op: LabOp): SchedulerState {
  const id = processArg(state, op);
  requireArea(state, id, "io", "wake", "only a process blocked on I/O can wake");
  const process = processOf(state, id);
  if (process.io !== null && state.clock < process.blockedAt + process.io) fail(`op "wake": ${id}'s I/O takes ${process.io} and started at t=${formatTime(process.blockedAt)}, so it is done at t=${formatTime(process.blockedAt + process.io)}; the clock is t=${formatTime(state.clock)}, run or idle until then`);
  return enqueue({ ...state, waiting: state.waiting.filter((member) => member !== id) }, id, levelArg(state, op, process.level));
}

function finish(state: SchedulerState, op: LabOp): SchedulerState {
  const id = requireRunning(state, op);
  const { remaining } = processOf(state, id);
  if (remaining > 1e-9) fail(`op "finish": ${id} still has ${formatTime(remaining)} left; run it until its burst is done, or preempt or block it`);
  return { ...state, cpu: null, finished: [...state.finished, id] };
}

function boost(state: SchedulerState): SchedulerState {
  const lanes = state.lanes.map((_, level) => (level === 0 ? state.lanes.flat() : []));
  const boosted = state.processes.map((process) => (locate(state, process.id).area === "finished" ? process : { ...process, level: 0 }));
  return { ...state, lanes, processes: boosted };
}

function geometry(levels: number) {
  const lanesBottom = LANES_TOP + levels * LANE_HEIGHT + (levels - 1) * LANE_GAP;
  const bandTop = lanesBottom + BAND_GAP;
  const trackTop = bandTop + BAND_HEIGHT + GANTT_GAP;
  const trackBottom = trackTop + TRACK_HEIGHT;
  return { lanesBottom, bandTop, trackTop, trackBottom, height: trackBottom + BOTTOM_MARGIN };
}

function laneTop(level: number): number {
  return LANES_TOP + level * (LANE_HEIGHT + LANE_GAP);
}

function fullFrame(left: number, top: number, running = false): CardFrame {
  return { x: left + CARD_WIDTH / 2, y: top + CARD_HEIGHT / 2, w: CARD_WIDTH, h: CARD_HEIGHT, compact: false, running };
}

function compactFrame(left: number, centerY: number): CardFrame {
  return { x: left + COMPACT_SIZE / 2, y: centerY, w: COMPACT_SIZE, h: COMPACT_SIZE, compact: true, running: false };
}

function cardFrame(state: SchedulerState, id: string): CardFrame {
  const { bandTop, lanesBottom } = geometry(state.levels);
  const place = locate(state, id);
  switch (place.area) {
    case "incoming": {
      const stagedIds = state.processes.filter((process) => process.arrive > 0).map((process) => process.id);
      const slot = stagedIds.indexOf(id);
      return compactFrame(WIDTH - COMPACT_SIZE - (stagedIds.length - 1 - slot) * INCOMING_PITCH, HEADER_HEIGHT / 2);
    }
    case "ready": return fullFrame(LANES_RIGHT - AREA_LEFT_MARGIN - CARD_WIDTH - place.index * CARD_PITCH, laneTop(place.level) + (LANE_HEIGHT - CARD_HEIGHT) / 2);
    case "cpu": return fullFrame(SIDE_LEFT + (SIDE_WIDTH - CARD_WIDTH) / 2, (LANES_TOP + lanesBottom) / 2 - CARD_HEIGHT / 2, true);
    case "io": return fullFrame(WAITING_FIRST_LEFT + place.index * CARD_PITCH, bandTop + (BAND_HEIGHT - CARD_HEIGHT) / 2);
    case "finished": return compactFrame(FINISHED_FIRST_LEFT + place.index * FINISHED_PITCH, bandTop + BAND_HEIGHT / 2);
  }
}

function lerpFrame(from: CardFrame, to: CardFrame, progress: number): CardFrame {
  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    w: lerp(from.w, to.w, progress),
    h: lerp(from.h, to.h, progress),
    compact: progress < 0.5 ? from.compact : to.compact,
    running: to.running,
  };
}

function cardDrawables(state: SchedulerState, id: string, frame: CardFrame, remaining: number): Drawable[] {
  const process = processOf(state, id);
  const part = `${state.objectId}[${id}]`;
  const room = frame.w - 16;
  const card: Drawable = { id: `card-${id}`, kind: "rect", x: frame.x, y: frame.y, w: frame.w, h: frame.h, fill: frame.running ? "fill2" : "fill", stroke: process.color, strokeWidth: frame.running ? 4 : 2.5, radius: 1, z: frame.running ? 6 : 4, part };
  const textZ = frame.running ? 7 : 5;
  if (frame.compact) {
    return [card, textDrawable(`card-${id}-name`, id, frame, { size: fitText(id, 24, room, "mark"), font: "mark", fill: process.color, z: textZ, part })];
  }
  const left = `${formatTime(remaining)} left`;
  return [
    card,
    textDrawable(`card-${id}-name`, id, { x: frame.x, y: frame.y - 14 }, { size: fitText(id, 34, room, "mark"), font: "mark", fill: process.color, z: textZ, part }),
    textDrawable(`card-${id}-left`, left, { x: frame.x, y: frame.y + 20 }, { size: fitText(left, 22, room, "read"), fill: "muted", z: textZ, part }),
  ];
}

function named(id: string, drawable: Drawable): Drawable {
  return { ...drawable, id };
}

function areaBox(id: string, left: number, top: number, w: number, h: number): Drawable {
  return boxDrawable(id, { x: left, y: top, w, h }, { fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1, z: 0 });
}

function areaLabel(id: string, text: string, at: Point): Drawable {
  return textDrawable(id, text, at, { size: 22, font: "mark", fill: "muted", z: 1, anchor: "start" });
}

function clockDrawables(state: SchedulerState, time: number): Drawable[] {
  const header = [textDrawable("clock", `t = ${formatTime(time)}`, { x: 0, y: HEADER_HEIGHT / 2 }, { size: 40, anchor: "start", z: 1 })];
  if (state.policy) header.push(textDrawable("policy", state.policy, { x: 250, y: HEADER_HEIGHT / 2 }, { size: 26, anchor: "start", fill: "muted", z: 1 }));
  return header;
}

function areaDrawables(state: SchedulerState): Drawable[] {
  const { lanesBottom, bandTop } = geometry(state.levels);
  const lanes = state.lanes.flatMap((_, level): Drawable[] => [
    areaBox(`lane-${level}`, 0, laneTop(level), LANES_RIGHT, LANE_HEIGHT),
    areaLabel(`lane-${level}-label`, state.levels === 1 ? "Ready" : `Q${level}`, { x: AREA_LEFT_MARGIN, y: laneTop(level) + LANE_HEIGHT / 2 }),
  ]);
  const cpuCenter = { x: SIDE_LEFT + SIDE_WIDTH / 2, y: (LANES_TOP + lanesBottom) / 2 };
  const areas: Drawable[] = [
    areaBox("cpu-box", SIDE_LEFT, LANES_TOP, SIDE_WIDTH, lanesBottom - LANES_TOP),
    areaLabel("cpu-label", "CPU", { x: SIDE_LEFT + AREA_LEFT_MARGIN, y: LANES_TOP + 26 }),
    named("to-cpu", segmentDrawable("arrow", { x: LANES_RIGHT + 6, y: cpuCenter.y }, { x: SIDE_LEFT - 6, y: cpuCenter.y }, "edge", 2.5, 1)),
    areaBox("io-box", 0, bandTop, LANES_RIGHT, BAND_HEIGHT),
    areaLabel("io-label", "I/O", { x: AREA_LEFT_MARGIN, y: bandTop + BAND_HEIGHT / 2 }),
    areaBox("finished-box", SIDE_LEFT, bandTop, SIDE_WIDTH, BAND_HEIGHT),
    areaLabel("finished-label", "Done", { x: SIDE_LEFT + AREA_LEFT_MARGIN, y: bandTop + BAND_HEIGHT / 2 }),
  ];
  if (state.cpu === null) areas.push(textDrawable("cpu-idle", "idle", cpuCenter, { size: 28, fill: "muted", z: 1 }));
  if (state.incoming.length > 0) {
    const stagedCount = state.processes.filter((process) => process.arrive > 0).length;
    areas.push(textDrawable("incoming-label", "Not yet arrived", { x: WIDTH - COMPACT_SIZE - (stagedCount - 1) * INCOMING_PITCH - 16, y: HEADER_HEIGHT / 2 }, { size: 22, anchor: "end", fill: "muted", z: 1 }));
  }
  return [...lanes, ...areas];
}

function scaleOf(state: SchedulerState): number {
  return TRACK_WIDTH / state.axis.end;
}

function sliceDrawables(state: SchedulerState, index: number, slice: Slice, end: number): Drawable[] {
  const { trackTop } = geometry(state.levels);
  const scale = scaleOf(state);
  const left = TRACK_LEFT + slice.start * scale;
  const width = Math.max(0, (end - slice.start) * scale);
  const process = slice.process === null ? null : processOf(state, slice.process);
  const labelText = process?.id ?? "idle";
  const fits = clamp01((width - textWidth(labelText, BAR_LABEL_SIZE, "mark")) / BAR_LABEL_PADDING);
  const center = { x: left + width / 2, y: trackTop + TRACK_HEIGHT / 2 };
  const fill: Paint = process?.color ?? "fill2";
  return [
    boxDrawable(`slice-${index}`, { x: left, y: trackTop + BAR_INSET, w: width, h: TRACK_HEIGHT - 2 * BAR_INSET }, { fill, stroke: "ground", strokeWidth: 2, radius: 0.5, z: 2 }),
    textDrawable(`slice-${index}-label`, labelText, center, { size: BAR_LABEL_SIZE, font: "mark", fill: process ? "ground" : "muted", opacity: fits, z: 3 }),
  ];
}

function ganttDrawables(state: SchedulerState): Drawable[] {
  const { trackTop, trackBottom } = geometry(state.levels);
  const scale = scaleOf(state);
  const ticks = Array.from({ length: state.axis.end / state.axis.step + 1 }, (_, index) => index * state.axis.step);
  return [
    areaLabel("gantt-label", "CPU", { x: 0, y: trackTop + TRACK_HEIGHT / 2 }),
    boxDrawable("track", { x: TRACK_LEFT, y: trackTop, w: TRACK_WIDTH, h: TRACK_HEIGHT }, { fill: "fill", stroke: "rule", strokeWidth: 1, radius: 0.5, z: 0 }),
    ...ticks.flatMap((time): Drawable[] => {
      const x = TRACK_LEFT + time * scale;
      return [
        { id: `tick-${time}`, kind: "line", x, y: trackBottom, x2: x, y2: trackBottom + TICK_LENGTH, stroke: "edge", strokeWidth: 1.5, z: 1 },
        textDrawable(`tick-${time}-label`, String(time), { x, y: trackBottom + TICK_LABEL_OFFSET }, { size: 22, fill: "muted", z: 1 }),
        ...(time === 0 || time === state.axis.end ? [] : [{ id: `grid-${time}`, kind: "line" as const, x, y: trackTop, x2: x, y2: trackBottom, stroke: "rule" as const, strokeWidth: 1, z: 1 }]),
      ];
    }),
    ...state.slices.flatMap((slice, index) => sliceDrawables(state, index, slice, slice.end)),
  ];
}

function runSeconds(op: LabOp, state: SchedulerState): number {
  const until = op.args.until;
  const span = typeof until === "number" ? Math.max(0, until - state.clock) : 1;
  return Math.min(3.4, 0.9 + 0.3 * span);
}

function clockAdvance(before: SchedulerState, after: SchedulerState, _op: LabOp, progress: number): Drawable[] {
  const growth = clamp01(progress);
  const grown = lerp(before.clock, after.clock, growth);
  const slice = after.slices[after.slices.length - 1]!;
  const out = [...clockDrawables(after, grown), ...sliceDrawables(after, after.slices.length - 1, slice, grown)];
  if (slice.process !== null) {
    const id = slice.process;
    const remaining = lerp(processOf(before, id).remaining, processOf(after, id).remaining, growth);
    out.push(...cardDrawables(after, id, lerpFrame(cardFrame(before, id), cardFrame(after, id), progress), remaining));
  }
  return out;
}

export const lab: LabDef<SchedulerSpec, SchedulerState> = {
  id: "scheduler",
  title: "Scheduler",
  reading: "required",
  catalog: {
    summary: "A CPU scheduler: ready queue lanes (one per MLFQ level), a CPU, an I/O area, a Done area and a Gantt chart with a clock. You say which process moves and the Lab checks it is legal; every process keeps one color.",
    spec: {
      processes: 'list of up to 6 {"id":"P1","burst":5,"arrive":0,"io":2}; burst is CPU time needed; arrive > 0 holds the process off stage until an arrive op, otherwise it starts ready in queue 0 in list order; io is how long its I/O takes, so wake is legal only that long after block',
      queues: "optional number of ready queues, 1 to 4 (default 1); 2 or more draws MLFQ levels Q0 (top) down",
      policy: 'optional label shown on screen only, such as "Round robin, quantum 2"',
    },
    example: [
      '{"step":1,"say":"Two jobs share the CPU with a quantum of two. P1 runs two ticks, then goes to the back so P2 gets a turn.","scene":{"sched":{"lab":"scheduler","policy":"Round robin, quantum 2","processes":[{"id":"P1","burst":3},{"id":"P2","burst":2}]}},"do":[{"cue":"P1 runs","op":"run","on":["sched"],"p":"P1","until":2},{"cue":"goes to the back","op":"preempt","on":["sched"],"p":"P1"},{"cue":"P2 gets a turn","op":"run","on":["sched"],"p":"P2","until":4},{"cue":"P2 gets a turn","op":"finish","on":["sched"],"p":"P2"}]}',
    ],
  },

  init(spec, objectId) {
    const declared = readProcesses(spec.processes, objectId);
    const levels = readQueues(spec.queues, objectId);
    if (spec.policy !== undefined && typeof spec.policy !== "string") fail(`${objectId}: "policy" must be text`);
    const processes = declared.map((process, index): Process => ({ ...process, color: SERIES[index]!, remaining: process.burst, level: 0, blockedAt: 0 }));
    const ready = processes.filter((process) => process.arrive <= 0).map((process) => process.id);
    return {
      objectId,
      policy: spec.policy ?? null,
      processes,
      levels,
      axis: timeAxis(processes),
      incoming: processes.filter((process) => process.arrive > 0).map((process) => process.id),
      lanes: Array.from({ length: levels }, (_, level) => (level === 0 ? ready : [])),
      cpu: null,
      waiting: [],
      finished: [],
      clock: 0,
      slices: [],
    };
  },

  ops: {
    arrive: {
      doc: '{"p": "P3", "level": 0}; a staged process (arrive > 0) joins the back of a ready queue; legal once the clock has reached its arrive time',
      seconds: 0.8,
      apply: arrive,
    },
    run: {
      doc: '{"p": "P1", "until": 4}; a ready process moves to the CPU and the Gantt bar grows from the clock to "until"; until must be later than the clock and no more than its burst left',
      seconds: runSeconds,
      apply: run,
      during: clockAdvance,
    },
    idle: {
      doc: '{"until": 6}; nothing is on the CPU and the clock moves on, drawn as an idle gap',
      seconds: runSeconds,
      apply: idle,
      during: clockAdvance,
    },
    preempt: {
      doc: '{"p": "P1", "level": 1}; the process on the CPU goes to the back of a ready queue; optional level demotes or promotes it, default its current level',
      seconds: 0.9,
      apply: preempt,
    },
    block: {
      doc: '{"p": "P2"}; the process on the CPU goes to the I/O area',
      seconds: 0.9,
      apply: block,
    },
    wake: {
      doc: '{"p": "P2", "level": 0}; an I/O process goes to the back of a ready queue once its io time has passed',
      seconds: 0.9,
      apply: wake,
    },
    finish: {
      doc: '{"p": "P1"}; the process on the CPU with no burst left moves to Done',
      seconds: 0.8,
      apply: finish,
    },
    boost: {
      doc: "no args; every unfinished process returns to queue 0, queue order kept",
      seconds: 1.2,
      apply: boost,
    },
  },

  size(state) {
    return { w: WIDTH, h: geometry(state.levels).height };
  },

  draw(state) {
    return [
      ...clockDrawables(state, state.clock),
      ...areaDrawables(state),
      ...state.processes.flatMap((process) => cardDrawables(state, process.id, cardFrame(state, process.id), process.remaining)),
      ...ganttDrawables(state),
    ];
  },
};
