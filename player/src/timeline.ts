import type { Step } from "./format";
import { type Narration, narrate, resolveCues } from "./narration";
import { planStep, type PlannedOp } from "./plan";
import { EMPTY_SCENE, type SceneState } from "./scene";
import type { Touch } from "./verbs";

export interface Segment {
  start: number;
  baseDuration: number;
  before: SceneState;
  after: SceneState;
  touches: Touch[];
  replaced: string[];
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
  progress: number;
  touches: Touch[];
  replaced: string[];
}

const SCENE_CHANGE_SECONDS = 0.9;
const STEP_TAIL_SECONDS = 0.5;
const SAME_TIME = 1e-6;

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

export class Timeline {
  readonly steps: StepSpan[] = [];
  readonly segments: Segment[] = [];
  done = false;
  private scene: SceneState;

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
      const baseDuration = Math.max(isSceneGroup ? SCENE_CHANGE_SECONDS : 0, ...group.ops.map((planned) => planned.duration));
      this.segments.push({ start: group.time, baseDuration, before, after, touches: group.ops.flatMap((planned) => planned.touches), replaced: isSceneGroup ? plan.replaced : [] });
      cursor = after;
      lastSegmentEnd = Math.max(lastSegmentEnd, group.time + baseDuration);
    });
    this.scene = plan.final;

    const narrationEnd = start + narration.duration;
    const span: StepSpan = {
      step,
      start,
      narrationEnd,
      end: Math.max(narrationEnd + STEP_TAIL_SECONDS, lastSegmentEnd + 0.2),
      errors: plan.errors,
    };
    this.steps.push(span);
    return span;
  }

  finish(): void {
    this.done = true;
  }

  stepIndexAt(time: number): number {
    const index = this.steps.findIndex((span) => time < span.end);
    return index < 0 ? Math.max(0, this.steps.length - 1) : index;
  }

  locate(time: number, motionScale: number): Located {
    const first = this.segments[0];
    if (!first || time < first.start) return { before: first?.before ?? this.scene, after: first?.before ?? this.scene, progress: 1, touches: [], replaced: [] };
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.segments[middle]!.start <= time) low = middle;
      else high = middle - 1;
    }
    const segment = this.segments[low]!;
    const next = this.segments[low + 1];
    const naturalEnd = segment.start + segment.baseDuration * motionScale;
    const end = next ? Math.min(naturalEnd, next.start) : naturalEnd;
    if (time >= end || end - segment.start < SAME_TIME) return { before: segment.after, after: segment.after, progress: 1, touches: [], replaced: [] };
    return { before: segment.before, after: segment.after, progress: (time - segment.start) / (end - segment.start), touches: segment.touches, replaced: segment.replaced };
  }
}
