import { createInterface } from "node:readline";
import { prepareStepAssets } from "../src/assets";
import type { Step } from "../src/format";
import { renderFrame } from "../src/frame";
import { LabError } from "../src/lab";
import { crowdedSceneError } from "../src/layout";
import { EMPTY_SCENE, type SceneState, startSceneOf } from "../src/scene";
import { THEMES } from "../src/theme";
import { Timeline } from "../src/timeline";
import { readLessonFile, registerAllLabs } from "./load";

interface Request {
  id?: string;
  scene?: SceneState | null;
  step?: Step;
  reading?: boolean;
}

interface StepResult {
  step: number;
  ok: boolean;
  errors: string[];
}

async function checkStep(timeline: Timeline, step: Step): Promise<StepResult> {
  await prepareStepAssets(step);
  const span = timeline.addStep(step);
  const errors = [...span.errors];
  if (errors.length === 0) {
    try {
      for (const fraction of [0.02, 0.5, 0.98]) renderFrame(timeline, span.start + (span.end - span.start) * fraction, THEMES.pattern);
      const scenes = [...timeline.segments.filter((segment) => segment.start >= span.start && segment.start < span.end).map((segment) => segment.after), timeline.finalScene];
      const crowded = scenes.map((scene) => crowdedSceneError(scene, THEMES.pattern)).find((message) => message !== null);
      if (crowded) errors.push(`step ${step.step} draw: ${crowded}`);
    } catch (error) {
      if (!(error instanceof LabError)) throw error;
      errors.push(`step ${step.step} draw: ${error.message}`);
    }
  }
  return { step: step.step, ok: errors.length === 0, errors };
}

function isScene(value: unknown): value is SceneState {
  const scene = value as SceneState | null;
  return typeof scene === "object" && scene !== null && Array.isArray(scene.objects) && "focus" in scene;
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
  const start = request.scene ?? EMPTY_SCENE;
  if (!step) return { id, ok: false, errors: ['request needs a "step"; send {"id": "...", "scene": <SceneState or null>, "step": {...}}'], scene: start };
  if (!isScene(start)) return { id, step: step.step, ok: false, errors: ['"scene" must be null or a SceneState with "objects" and "focus", as an earlier reply returned it'], scene: null };
  const scene = request.reading === undefined ? start : { ...start, reading: request.reading };
  await prepareStepAssets(scene);
  const timeline = new Timeline(scene);
  const result = await checkStep(timeline, step);
  return { id, ...result, scene: result.ok ? timeline.finalScene : start };
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
