import type { Step } from "./format";
import { clamp01, LabError } from "./lab";
import { type Narration, narrate, resolveCues } from "./narration";
import { planStep, type PlannedOp } from "./plan";
import { EMPTY_SCENE, type SceneState } from "./scene";
import { buildStage } from "./stage";
import type { Touch } from "./verbs";

export type Ease = (progress: number) => number;

export interface Segment {
  start: number;
  lead: number;
  exits: boolean;
  baseDuration: number;
  trueSeconds: number;
  cutAt: number;
  before: SceneState;
  after: SceneState;
  touches: Touch[];
  replaced: string[];
}

export interface SegmentProgress {
  exit: number;
  move: number;
  eased: number;
  elapsed: number;
  done: boolean;
}

export interface StepSpan {
  step: Step;
  start: number;
  narrationEnd: number;
  end: number;
  errors: string[];
}

export interface Located {
  before: SceneState;
  after: SceneState;
  progress: SegmentProgress;
  touches: Touch[];
  replaced: string[];
  exits: boolean;
}

const SCENE_CHANGE_SECONDS = 0.9;
const STEP_TAIL_SECONDS = 0.5;
const STEP_SETTLE_SECONDS = 0.2;
const EXIT_SHARE = 0.38;
const SAME_TIME = 1e-6;

export function segmentProgress(segment: Segment, time: number, motionScale: number, ease: Ease): SegmentProgress {
  const elapsed = time - segment.start;
  const moveSpan = segment.baseDuration * motionScale * (segment.exits ? 1 - EXIT_SHARE : 1);
  const moveEnd = Math.min(segment.start + moveSpan, segment.cutAt);
  if (time >= Math.max(moveEnd, segment.start + segment.trueSeconds)) return { exit: 1, move: 1, eased: 1, elapsed, done: true };
  const exit = segment.lead > 0 ? clamp01((elapsed + segment.lead) / segment.lead) : Number(elapsed >= 0);
  const span = moveEnd - segment.start;
  const move = elapsed < 0 ? 0 : span < SAME_TIME ? 1 : clamp01(elapsed / span);
  return { exit, move, eased: move >= 1 ? 1 : ease(move), elapsed, done: false };
}

export function trueProgress(progress: SegmentProgress, seconds: number): number {
  return clamp01(progress.elapsed / seconds);
}

function vanishes(before: SceneState, after: SceneState, replaced: string[]): boolean {
  if (replaced.length > 0) return true;
  if (before === after) return false;
  const kept = new Set(buildStage(after).objects.flatMap((object) => object.drawables.map((drawable) => drawable.id)));
  return buildStage(before).objects.some((object) => object.drawables.some((drawable) => !kept.has(drawable.id)));
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
  private trueEnd = 0;

  constructor(readonly startScene: SceneState = EMPTY_SCENE) {
    this.scene = startScene;
  }

  get finalScene(): SceneState {
    return this.scene;
  }

  get duration(): number {
    return this.steps.at(-1)?.end ?? 0;
  }

  addStep(step: Step): StepSpan {
    const start = this.duration;
    const narration = narrate(step.say, step.voice);
    const plan = planStep(this.scene, step);
    const events = opEvents(step, start, narration, plan.ops);
    const sceneChanged = plan.afterSceneChange !== this.scene;
    const errors = [...plan.errors];

    let cursor = this.scene;
    let lastSegmentEnd = start;
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
      const exits = this.exitsOf(before, after, replaced, errors, step);
      const previous = this.segments.at(-1);
      const previousStart = previous?.start ?? 0;
      const naturalLead = exits ? EXIT_SHARE * baseDuration : 0;
      const time = Math.max(group.time, this.trueEnd + naturalLead, previousStart);
      const lead = Math.min(naturalLead, time - previousStart);
      if (previous) previous.cutAt = time - lead;
      this.segments.push({ start: time, lead, exits, baseDuration, trueSeconds, cutAt: Infinity, before, after, touches: sharedStart(group.ops.flatMap((planned) => planned.touches)), replaced });
      cursor = after;
      if (trueSeconds > 0) this.trueEnd = Math.max(this.trueEnd, time + trueSeconds);
      lastSegmentEnd = Math.max(lastSegmentEnd, time + Math.max(baseDuration, trueSeconds));
    });
    this.scene = plan.final;

    const narrationEnd = start + narration.duration;
    const span: StepSpan = {
      step,
      start,
      narrationEnd,
      end: Math.max(narrationEnd + STEP_TAIL_SECONDS, lastSegmentEnd + STEP_SETTLE_SECONDS),
      errors,
    };
    this.steps.push(span);
    return span;
  }

  private exitsOf(before: SceneState, after: SceneState, replaced: string[], errors: string[], step: Step): boolean {
    if (errors.length > 0) return false;
    try {
      return vanishes(before, after, replaced);
    } catch (error) {
      if (!(error instanceof LabError)) throw error;
      errors.push(`step ${step.step} draw: ${error.message}`);
      return false;
    }
  }

  finish(): void {
    this.done = true;
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
    if (progress.done) return this.still(segment.after);
    return { before: segment.before, after: segment.after, progress, touches: segment.touches, replaced: segment.replaced, exits: segment.exits };
  }

  private still(scene: SceneState): Located {
    return { before: scene, after: scene, progress: { exit: 1, move: 1, eased: 1, elapsed: 0, done: true }, touches: [], replaced: [], exits: false };
  }
}
