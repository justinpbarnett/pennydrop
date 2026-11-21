import { createInterface } from "node:readline";
import { usesCode } from "../src/assets";
import type { Step } from "../src/format";
import { renderFrame } from "../src/frame";
import { loadHighlighter } from "../src/highlight";
import { LabError } from "../src/lab";
import { EMPTY_SCENE, type SceneState } from "../src/scene";
import { THEMES } from "../src/theme";
import { Timeline } from "../src/timeline";
import { readLessonFile, registerAllLabs } from "./load";

interface Request {
  id?: string;
  scene?: SceneState | null;
  step?: Step;
}

interface StepResult {
  step: number;
  ok: boolean;
  errors: string[];
}

async function checkStep(timeline: Timeline, step: Step): Promise<StepResult> {
  if (usesCode(step)) await loadHighlighter();
  const span = timeline.addStep(step);
  const errors = [...span.errors];
  if (errors.length === 0) {
    try {
      for (const fraction of [0.02, 0.5, 0.98]) renderFrame(timeline, span.start + (span.end - span.start) * fraction, THEMES.pattern);
    } catch (error) {
      errors.push(`step ${step.step} draw: ${error instanceof LabError ? error.message : (error as Error).stack ?? String(error)}`);
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
  const timeline = new Timeline(lesson.lesson.start_scene);
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
  const timeline = new Timeline(start);
  const result = await checkStep(timeline, step);
  return { id, ...result, scene: result.ok ? timeline.finalScene : start };
}

async function serve(): Promise<void> {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let reply: object;
    try {
      reply = await answer(JSON.parse(line) as Request);
    } catch (error) {
      reply = { ok: false, errors: [`request could not be read: ${(error as Error).message}`], scene: null };
    }
    console.log(JSON.stringify(reply));
  }
}

await registerAllLabs();
const file = process.argv[2];
if (file) process.exit((await validateFile(file)) ? 0 : 1);
await serve();
