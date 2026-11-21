import { challengeProblems } from "./challenge";
import type { Step, StepOp } from "./format";
import { relationTargets } from "./relation";
import { applyLabOp, hasOp, LabError, type LabOp, opIsTrueTime, opSeconds } from "./lab";
import { narrate, resolveCues } from "./narration";
import { parseSelector } from "./selector";
import {
  applySceneSpecs, definitionOf, findObject, requireObject, type SceneState, upsertObject,
} from "./scene";
import { findVerb, type ParsedOp, type Touch, verbNames } from "./verbs";

export interface PlannedOp {
  op: ParsedOp;
  touches: Touch[];
  duration: number;
  trueTime: boolean;
  after: SceneState;
}

export interface StepPlan {
  afterSceneChange: SceneState;
  ops: PlannedOp[];
  final: SceneState;
  replaced: string[];
  errors: string[];
}

export function parseOp(index: number, raw: StepOp): ParsedOp {
  const { cue, op, on, ...args } = raw;
  if (typeof op !== "string" || !op) throw new LabError(`do[${index}] has no "op" name`);
  const selectors = (on ?? []).map(parseSelector);
  return { index, cue, name: op, selectors, args };
}

function labOpFor(op: ParsedOp, objectId: string): LabOp {
  const parts = op.selectors.filter((selector) => selector.id === objectId && selector.part !== null).map((selector) => selector.part!);
  return { name: op.name, parts, args: op.args };
}

function runLabOp(scene: SceneState, op: ParsedOp): PlannedOp {
  const objectIds = [...new Set(op.selectors.map((selector) => selector.id))];
  let next = scene;
  let duration = 0;
  let trueTime = false;
  const touches = objectIds.map((objectId): Touch => {
    const before = requireObject(next, objectId);
    const def = definitionOf(before);
    const labOp = labOpFor(op, objectId);
    const after = { ...before, state: applyLabOp(def, before.state, labOp) };
    next = upsertObject(next, after);
    const seconds = opSeconds(def, labOp, before.state);
    const own = opIsTrueTime(def, labOp.name);
    duration = Math.max(duration, seconds);
    trueTime ||= own;
    return { objectId, before, after, action: { type: "lab", name: labOp.name, parts: labOp.parts, args: labOp.args, seconds, trueTime: own } };
  });
  return { op, touches, duration, trueTime, after: next };
}

function handledByLab(scene: SceneState, op: ParsedOp): boolean {
  const first = op.selectors[0];
  const object = first && findObject(scene, first.id);
  return Boolean(object && hasOp(definitionOf(object), op.name));
}

function unknownOp(scene: SceneState, op: ParsedOp): LabError {
  const first = op.selectors[0];
  const object = first && findObject(scene, first.id);
  const own = object ? Object.keys(definitionOf(object).ops) : [];
  const owner = object ? ` on ${object.id} (${definitionOf(object).title})` : "";
  return new LabError(`unknown op "${op.name}"${owner}; ${own.length ? `${object!.id} knows ${own.join(", ")}; ` : ""}generic verbs: ${verbNames().join(", ")}`);
}

export function applyOp(scene: SceneState, op: ParsedOp): PlannedOp {
  if (handledByLab(scene, op)) return runLabOp(scene, op);
  const verb = findVerb(op.name);
  if (!verb) {
    if (op.selectors.length > 0) requireObject(scene, op.selectors[0]!.id);
    throw unknownOp(scene, op);
  }
  const result = verb.run(scene, op);
  return { op, touches: result.touches, duration: verb.duration, trueTime: false, after: result.scene };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function planStep(previous: SceneState, step: Step): StepPlan {
  const errors: string[] = [];
  const label = `step ${step.step}`;
  if (typeof step.say !== "string" || !step.say.trim()) errors.push(`${label}: "say" must be non-empty narration text`);

  let scene = previous;
  try {
    scene = applySceneSpecs(previous, step.scene ?? {});
  } catch (error) {
    errors.push(`${label} scene: ${describe(error)}`);
  }
  const afterSceneChange = scene;

  const rawOps = step.do ?? [];
  const cueMatches = resolveCues(narrate(step.say ?? ""), rawOps.map((raw) => raw.cue));
  const ops: PlannedOp[] = [];
  rawOps.forEach((raw, index) => {
    try {
      const parsed = parseOp(index, raw);
      if (cueMatches[index] === null) errors.push(`${label} do[${index}]: cue "${raw.cue}" is not in say; use a word or phrase from the narration, in order`);
      const planned = applyOp(scene, parsed);
      scene = planned.after;
      ops.push(planned);
    } catch (error) {
      errors.push(`${label} do[${index}] ${raw.op}: ${describe(error)}`);
    }
  });

  for (const object of scene.objects) {
    for (const target of relationTargets(object.at)) {
      if (!findObject(scene, target)) errors.push(`${label}: ${object.id} is placed relative to "${target}", which is not in the Scene`);
    }
  }
  if (step.challenge) errors.push(...challengeProblems(step.challenge).map((problem) => `${label}: ${problem}`));
  const replaced = Object.entries(step.scene ?? {}).filter(([id, spec]) => spec !== null && previous.objects.some((object) => object.id === id)).map(([id]) => id);
  return { afterSceneChange, ops, final: scene, replaced, errors };
}
