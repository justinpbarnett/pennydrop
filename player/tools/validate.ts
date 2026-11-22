import { createInterface } from "node:readline";
import { prepareStepAssets } from "../src/assets";
import type { Step } from "../src/format";
import { type Painted, renderFrame } from "../src/frame";
import { LabError } from "../src/lab";
import { crowdedSceneError } from "../src/layout";
import { EMPTY_SCENE, type SceneSnapshot, sceneFromSnapshot, type SceneState, snapshotOf, startSceneOf } from "../src/scene";
import { THEMES } from "../src/theme";
import { Timeline } from "../src/timeline";
import { readLessonFile, registerAllLabs } from "./load";

const VISIBLE_OPACITY = 0.05;
const SETTLED_AFTER = 1;
const MAX_LISTED_PARTS = 16;

interface Request {
  id?: string;
  scene?: SceneSnapshot | null;
  step?: Step;
  reading?: boolean;
  replay?: boolean;
}

interface StepResult {
  step: number;
  ok: boolean;
  errors: string[];
}

async function checkStep(timeline: Timeline, step: Step, replay = false): Promise<StepResult> {
  await prepareStepAssets(step);
  const span = timeline.addStep(step);
  const errors = [...span.errors];
  if (errors.length === 0) {
    try {
      for (const fraction of [0.02, 0.5, 0.98]) renderFrame(timeline, span.start + (span.end - span.start) * fraction, THEMES.pattern);
      const settled = renderFrame(timeline, span.end + SETTLED_AFTER, THEMES.pattern).items;
      if (!replay && !settled.some((item) => item.opacity > VISIBLE_OPACITY)) errors.push(`step ${step.step} draw: nothing is on stage when this Step ends; show something the narration talks about, such as a shape, a picture or a Lab figure`);
      const untappable = untappableAnswer(step, settled);
      if (untappable) errors.push(untappable);
      const scenes = [...timeline.segments.filter((segment) => segment.start >= span.start && segment.start < span.end).map((segment) => segment.after), timeline.finalScene];
      const crowded = scenes.map((scene) => crowdedSceneError(scene, THEMES.pattern)).find((message) => message !== null);
      if (crowded && !replay) errors.push(`step ${step.step} draw: ${crowded}`);
    } catch (error) {
      if (!(error instanceof LabError)) throw error;
      errors.push(`step ${step.step} draw: ${error.message}`);
    }
  }
  return { step: step.step, ok: errors.length === 0, errors };
}

function untappableAnswer(step: Step, settled: Painted[]): string | null {
  if (step.challenge?.type !== "click") return null;
  const tappable = new Set(settled.flatMap((item) => (item.part ? [item.part] : [])));
  const answers = new Set([step.challenge.answer].flat());
  const missing = [...answers].filter((answer) => !tappable.has(answer));
  if (missing.length === 0 && tappable.size > 1 && [...tappable].every((part) => answers.has(part))) {
    return `step ${step.step} challenge: every thing the learner can tap (${[...tappable].join(", ")}) is a right answer, so the tap asks nothing; make the scene differ so only some of them are right, or use no Challenge`;
  }
  if (missing.length === 0) return null;
  const offer = tappable.size > 0 ? `a tap can name ${[...tappable].slice(0, MAX_LISTED_PARTS).join(", ")}` : "nothing on the stage answers a tap, so use another Challenge type, or none";
  return `step ${step.step} challenge: ${missing.join(", ")} is not something the learner can tap when this Step ends; ${offer}`;
}

async function validateFile(path: string): Promise<boolean> {
  const lesson = await readLessonFile(path);
  const start = startSceneOf(lesson.lesson);
  await prepareStepAssets(start);
  const timeline = new Timeline(start);
  let allOk = true;
  for (const step of lesson.steps) {
    const result = await checkStep(timeline, step);
    allOk &&= result.ok;
    console.log(result.ok ? `step ${result.step}: ok` : `step ${result.step}: ${result.errors.join("\n  ")}`);
  }
  return allOk;
}

async function answer(request: Request): Promise<object> {
  const { id, step } = request;
  if (!step) return { id, ok: false, errors: ['request needs a "step"; send {"id": "...", "scene": <scene snapshot or null>, "step": {...}}'], scene: request.scene ?? snapshotOf(EMPTY_SCENE) };
  let start: SceneState;
  try {
    start = request.scene ? sceneFromSnapshot(request.scene) : EMPTY_SCENE;
  } catch (error) {
    if (!(error instanceof LabError)) throw error;
    return { id, step: step.step, ok: false, errors: [`"scene" must be null or a scene snapshot, as an earlier reply returned it: ${error.message}`], scene: null };
  }
  const scene = request.reading === undefined ? start : { ...start, reading: request.reading };
  await prepareStepAssets(scene);
  const timeline = new Timeline(scene);
  const result = await checkStep(timeline, step, request.replay === true);
  return { id, ...result, scene: snapshotOf(result.ok ? timeline.finalScene : start) };
}

function crashMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const location = error.stack?.split("\n").find((line) => line.trim().startsWith("at "));
  return location ? `${error.message} ${location.trim()}` : error.message;
}

async function serve(): Promise<void> {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let reply: object;
    let id: string | undefined;
    try {
      const request = JSON.parse(line) as Request;
      id = request.id;
      reply = await answer(request);
    } catch (error) {
      reply = { id, ok: false, crash: crashMessage(error) };
    }
    console.log(JSON.stringify(reply));
  }
}

await registerAllLabs();
const file = process.argv[2];
if (file) process.exit((await validateFile(file)) ? 0 : 1);
await serve();
