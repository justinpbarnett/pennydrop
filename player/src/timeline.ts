import type { Step } from "./format";
import { clamp01, LabError } from "./lab";
import { type Narration, narrate, resolveCues } from "./narration";
import { planStep, type PlannedOp } from "./plan";
import { definitionOf, EMPTY_SCENE, type SceneState } from "./scene";
import { arrivedObjects, buildStage, movedObjects, reshapedDrawables, type Stage } from "./stage";
import { layoutScene } from "./layout";
import { THEMES } from "./theme";
import type { Touch } from "./verbs";

export type Ease = (progress: number) => number;

export interface Carried {
  touch: Touch;
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  lead: number;
  clear: number;
  exits: boolean;
  relayout: boolean;
  baseDuration: number;
  trueSeconds: number;
  cutAt: number;
  before: SceneState;
  after: SceneState;
  touches: Touch[];
  carried: Carried[];
  replaced: string[];
}

export interface SegmentProgress {
  exit: number;
  shift: number;
  move: number;
  eased: number;
  elapsed: number;
  done: boolean;
}

export interface StepSpan {
  step: Step;
  start: number;
  narration: Narration;
  narrationEnd: number;
  end: number;
  opStarts: { index: number; time: number }[];
  errors: string[];
}

export interface Located {
  before: SceneState;
  after: SceneState;
  progress: SegmentProgress;
  touches: Touch[];
  carried: Carried[];
  replaced: string[];
  exits: boolean;
  relayout: boolean;
}

const SCENE_CHANGE_SECONDS = 0.9;
const STEP_TAIL_SECONDS = 0.5;
const STEP_SETTLE_SECONDS = 0.2;
const EXIT_SHARE = 0.38;
const ROOM_MAKING_MOVE = 8;
const SAME_TIME = 1e-6;

export function segmentProgress(segment: Segment, time: number, motionScale: number, ease: Ease): SegmentProgress {
  const elapsed = time - segment.start;
  const moveSpan = (segment.baseDuration - segment.clear) * motionScale;
  const moveEnd = Math.min(segment.start + moveSpan, segment.cutAt);
  if (time >= Math.max(moveEnd, segment.start + segment.trueSeconds)) return { exit: 1, shift: 1, move: 1, eased: 1, elapsed, done: true };
  const exit = segment.lead > 0 ? clamp01((elapsed + segment.lead) / segment.lead) : Number(elapsed >= 0);
  const shiftStart = segment.start - segment.lead;
  const shiftEnd = segment.relayout ? Math.min(shiftStart + segment.clear, moveEnd) : segment.start;
  const arrivalStart = Math.max(segment.start, shiftEnd);
  const span = moveEnd - arrivalStart;
  const move = time < arrivalStart ? 0 : span < SAME_TIME ? 1 : clamp01((time - arrivalStart) / span);
  const eased = move >= 1 ? 1 : ease(move);
  const shift = segment.relayout ? ease(clamp01((time - shiftStart) / Math.max(shiftEnd - shiftStart, SAME_TIME))) : eased;
  return { exit, shift, move, eased, elapsed, done: false };
}

export function trueProgress(progress: SegmentProgress, seconds: number): number {
  return clamp01(progress.elapsed / seconds);
}

interface Clearing {
  exits: boolean;
  relayout: boolean;
}

const NO_CLEARING: Clearing = { exits: false, relayout: false };

export const measuredStage = (scene: SceneState): Stage => buildStage(scene, layoutScene, THEMES.pattern);

function clearingOf(before: SceneState, after: SceneState, replaced: string[], measure: (scene: SceneState) => Stage): Clearing {
  if (before === after) return { exits: replaced.length > 0, relayout: false };
  const [from, to] = [measure(before), measure(after)];
  const kept = new Set(to.objects.flatMap((object) => object.drawables.map((drawable) => drawable.id)));
  const exits = replaced.length > 0 || from.objects.some((object) => object.drawables.some((drawable) => !kept.has(drawable.id)));
  return {
    exits,
    relayout: arrivedObjects(from, to).size > 0 ? reshapedDrawables(from, to) : !exits && movedObjects(from, to, ROOM_MAKING_MOVE).size > 0,
  };
}

interface Claim {
  objectId: string | null;
  part: string | null;
}

interface Hold extends Claim {
  until: number;
}

const EVERYTHING: Claim = { objectId: null, part: null };

function claimsOf(touch: Touch): Claim[] {
  if (touch.action.type === "effect") return [];
  if (touch.action.type === "scene") return [{ objectId: touch.objectId, part: null }];
  const object = touch.after ?? touch.before;
  if (!object || !definitionOf(object).concurrentParts) return [EVERYTHING];
  return touch.action.parts.length ? touch.action.parts.map((part) => ({ objectId: touch.objectId, part })) : [{ objectId: touch.objectId, part: null }];
}

function clash(a: Claim, b: Claim): boolean {
  if (a.objectId === null || b.objectId === null) return true;
  return a.objectId === b.objectId && (a.part === null || b.part === null || a.part === b.part);
}

function realTimeRuns(segment: Segment): Carried[] {
  return segment.touches.flatMap((touch) => (touch.action.type === "lab" && touch.action.trueTime ? [{ touch, start: segment.start, end: segment.start + touch.action.seconds }] : []));
}

interface OpEvent {
  time: number;
  planned: PlannedOp;
}

const MIN_RUN_SLOT_SECONDS = 0.12;

function opEvents(step: Step, start: number, narration: Narration, ops: PlannedOp[]): OpEvent[] {
  const matches = resolveCues(narration, (step.do ?? []).map((raw) => raw.cue));
  const narrationEnd = start + narration.duration;
  const events: OpEvent[] = [];
  let floor = start;
  let previousEnd = start;
  let index = 0;
  while (index < ops.length) {
    const match = matches[ops[index]!.op.index];
    if (match) {
      const time = Math.max(floor, start + narration.words[match.startWord]!.start);
      const end = time + ops[index]!.duration;
      const joinsPrevious = events.length > 0 && Math.abs(events.at(-1)!.time - time) < SAME_TIME;
      previousEnd = joinsPrevious ? Math.max(previousEnd, end) : end;
      floor = time;
      events.push({ time, planned: ops[index]! });
      index += 1;
      continue;
    }
    let runEnd = index;
    while (runEnd < ops.length && !matches[ops[runEnd]!.op.index]) runEnd += 1;
    const run = ops.slice(index, runEnd);
    const runStart = Math.max(floor, previousEnd);
    const natural = run.reduce((total, planned) => total + planned.duration, 0);
    const evenSlot = Math.max(MIN_RUN_SLOT_SECONDS, (narrationEnd - runStart) / run.length);
    const compress = runStart + natural > narrationEnd;
    let time = runStart;
    for (const planned of run) {
      events.push({ time, planned });
      floor = time;
      previousEnd = time + planned.duration;
      time += compress ? evenSlot : planned.duration;
    }
    index = runEnd;
  }
  return events;
}

function sharedStart(touches: Touch[]): Touch[] {
  const starts = new Map<string, Touch["before"]>();
  for (const touch of touches) if (!starts.has(touch.objectId)) starts.set(touch.objectId, touch.before);
  return touches.map((touch) => (touch.action.type === "lab" ? { ...touch, before: starts.get(touch.objectId) ?? null } : touch));
}

export class Timeline {
  readonly steps: StepSpan[] = [];
  readonly segments: Segment[] = [];
  done = false;
  private scene: SceneState;
  private holds: Hold[] = [];

  constructor(
    readonly startScene: SceneState = EMPTY_SCENE,
    private readonly measure: (scene: SceneState) => Stage = measuredStage,
  ) {
    this.scene = startScene;
  }

  get finalScene(): SceneState {
    return this.scene;
  }

  get duration(): number {
    return this.steps.at(-1)?.end ?? 0;
  }

  get practiceStart(): number | null {
    return this.steps.find((span) => span.step.form)?.start ?? null;
  }

  get stepStills(): number[] {
    return this.steps.map((span, index) => {
      const next = this.steps[index + 1];
      const exit = next && this.segments.find((segment) => segment.start >= next.start);
      return exit ? Math.min(span.end, exit.start - exit.lead) : span.end;
    });
  }

  addStep(step: Step): StepSpan {
    const start = this.duration;
    const narration = narrate(typeof step.say === "string" ? step.say : "", step.voice);
    const plan = planStep(this.scene, step, narration);
    const events = opEvents(step, start, narration, plan.ops);
    const sceneChanged = plan.afterSceneChange !== this.scene;
    const errors = [...plan.errors];
    this.holds = this.holds.filter((hold) => hold.until > start);

    let cursor = this.scene;
    let lastSegmentEnd = start;
    const opStarts: StepSpan["opStarts"] = [];
    const groups: { time: number; ops: PlannedOp[] }[] = sceneChanged ? [{ time: start, ops: [] }] : [];
    for (const event of events) {
      const group = groups.find((candidate) => Math.abs(candidate.time - event.time) < SAME_TIME);
      if (group) group.ops.push(event.planned);
      else groups.push({ time: event.time, ops: [event.planned] });
    }
    groups.forEach((group, index) => {
      const before = cursor;
      const isSceneGroup = sceneChanged && index === 0;
      const after = group.ops.at(-1)?.after ?? (isSceneGroup ? plan.afterSceneChange : cursor);
      const replaced = isSceneGroup ? plan.replaced : [];
      const baseDuration = Math.max(isSceneGroup ? SCENE_CHANGE_SECONDS : 0, ...group.ops.map((planned) => planned.duration));
      const trueSeconds = Math.max(0, ...group.ops.filter((planned) => planned.trueTime).map((planned) => planned.duration));
      const touches = sharedStart(group.ops.flatMap((planned) => planned.touches));
      const wanted = isSceneGroup ? [EVERYTHING] : touches.flatMap(claimsOf);
      const heldUntil = Math.max(0, ...this.holds.filter((hold) => hold.objectId === null || wanted.some((claim) => clash(claim, hold))).map((hold) => hold.until));
      const { exits, relayout } = this.clearingOf(before, after, replaced, errors, step);
      const previous = this.segments.at(-1);
      const previousStart = previous?.start ?? 0;
      const clear = exits || relayout ? EXIT_SHARE * Math.min(baseDuration, SCENE_CHANGE_SECONDS) : 0;
      const afterChallenge = index === 0 && Boolean(this.steps.at(-1)?.step.challenge);
      const earliestExit = afterChallenge ? start : previousStart;
      const time = Math.max(group.time, heldUntil + clear, earliestExit + (afterChallenge ? clear : 0));
      const lead = Math.min(clear, time - earliestExit);
      if (previous) previous.cutAt = time - lead;
      const carried = previous ? [...previous.carried, ...realTimeRuns(previous)].filter((run) => run.end > time - lead) : [];
      this.segments.push({ start: time, lead, clear, exits, relayout, baseDuration, trueSeconds, cutAt: Infinity, before, after, touches, carried, replaced });
      opStarts.push(...group.ops.map((planned) => ({ index: planned.op.index, time })));
      cursor = after;
      for (const touch of touches) {
        const { action } = touch;
        if (action.type === "lab" && action.trueTime) this.holds.push(...claimsOf(touch).map((claim) => ({ ...claim, until: time + action.seconds })));
      }
      lastSegmentEnd = Math.max(lastSegmentEnd, time + Math.max(baseDuration, trueSeconds));
    });
    this.scene = plan.final;

    const narrationEnd = start + narration.duration;
    const span: StepSpan = {
      step,
      start,
      narration,
      narrationEnd,
      end: Math.max(narrationEnd + STEP_TAIL_SECONDS, lastSegmentEnd + STEP_SETTLE_SECONDS),
      opStarts,
      errors,
    };
    this.steps.push(span);
    return span;
  }

  private clearingOf(before: SceneState, after: SceneState, replaced: string[], errors: string[], step: Step): Clearing {
    if (errors.length > 0) return NO_CLEARING;
    try {
      return clearingOf(before, after, replaced, this.measure);
    } catch (error) {
      if (!(error instanceof LabError)) throw error;
      errors.push(`step ${step.step} draw: ${error.message}`);
      return NO_CLEARING;
    }
  }

  finish(): void {
    this.done = true;
  }

  segmentsStartingIn(from: number, to: number): Segment[] {
    return this.segments.filter((segment) => segment.start >= from && segment.start < to);
  }

  stepIndexAt(time: number): number {
    const index = this.steps.findIndex((span) => time < span.end);
    return index < 0 ? Math.max(0, this.steps.length - 1) : index;
  }

  locate(time: number, motionScale: number, ease: Ease): Located {
    const first = this.segments[0];
    if (!first || time < first.start - first.lead) return this.still(first?.before ?? this.scene);
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = this.segments[middle]!;
      if (candidate.start - candidate.lead <= time) low = middle;
      else high = middle - 1;
    }
    const segment = this.segments[low]!;
    const progress = segmentProgress(segment, time, motionScale, ease);
    const carried = segment.carried.filter((run) => run.end > time);
    if (progress.done) return this.still(segment.after, carried);
    return { before: segment.before, after: segment.after, progress, touches: segment.touches, carried, replaced: segment.replaced, exits: segment.exits, relayout: segment.relayout };
  }

  private still(scene: SceneState, carried: Carried[] = []): Located {
    return { before: scene, after: scene, progress: { exit: 1, shift: 1, move: 1, eased: 1, elapsed: 0, done: true }, touches: [], carried, replaced: [], exits: false, relayout: false };
  }
}
