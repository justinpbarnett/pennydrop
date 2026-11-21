import { createInterface } from "node:readline";
import type { Step } from "../src/format";
import { renderFrame } from "../src/frame";
import { LabError } from "../src/lab";
import { THEMES } from "../src/theme";
import { Timeline } from "../src/timeline";
import { readLessonFile, registerAllLabs } from "./load";

interface StepResult {
  step: number;
  ok: boolean;
  errors: string[];
}

class Session {
  private timeline = new Timeline();

  reset(): void {
    this.timeline = new Timeline();
  }

  add(step: Step): StepResult {
    const span = this.timeline.addStep(step);
    const errors = [...span.errors];
    if (errors.length === 0) {
      try {
        for (const fraction of [0.02, 0.5, 0.98]) renderFrame(this.timeline, span.start + (span.end - span.start) * fraction, THEMES.pattern);
      } catch (error) {
        errors.push(`step ${step.step} draw: ${error instanceof LabError ? error.message : (error as Error).stack ?? String(error)}`);
      }
    }
    return { step: step.step, ok: errors.length === 0, errors };
  }
}

async function validateFile(path: string): Promise<boolean> {
  const lesson = await readLessonFile(path);
  const session = new Session();
  let allOk = true;
  for (const step of lesson.steps) {
    const result = session.add(step);
    allOk &&= result.ok;
    console.log(result.ok ? `step ${result.step}: ok` : `step ${result.step}: ${result.errors.join("\n  ")}`);
  }
  return allOk;
}

async function serve(): Promise<void> {
  const session = new Session();
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let reply: unknown;
    try {
      const message = JSON.parse(line) as { reset?: boolean; step?: Step };
      if (message.reset) session.reset();
      reply = message.step ? session.add(message.step) : { ok: true, errors: [] };
    } catch (error) {
      reply = { ok: false, errors: [`request is not valid JSON: ${(error as Error).message}`] };
    }
    console.log(JSON.stringify(reply));
  }
}

await registerAllLabs();
const file = process.argv[2];
if (file) process.exit((await validateFile(file)) ? 0 : 1);
await serve();
