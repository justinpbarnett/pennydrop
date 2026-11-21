import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type Step, parseJsonl } from "../src/format";
import { renderFrame } from "../src/frame";
import { definitionOf, startSceneOf } from "../src/scene";
import { THEMES } from "../src/theme";
import { Timeline } from "../src/timeline";
import { type Box, type Finding, boxOf, compositionFindings } from "./composition";
import { buildMinted } from "./mint-build";

const PLAYER_ROOT = resolve(import.meta.dir, "..");
const WORD_KINDS = ["text", "code", "math"];
const EDGE_TOLERANCE = { pixels: 10, share: 0.08 };

export function findComments(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let index = 0;
  let line = 1;
  let previous = "";
  let word = "";

  const regexAllowed = () => previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous) || ["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new"].includes(word);
  const skipQuoted = (quote: string) => {
    index += 1;
    while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1;
    index += 1;
  };
  const skipTemplate = () => {
    index += 1;
    while (index < source.length && source[index] !== "`") {
      if (source[index] === "\\") index += 2;
      else if (source[index] === "$" && source[index + 1] === "{") {
        index += 2;
        scan(true);
      } else {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
    }
    index += 1;
  };
  const skipRegex = () => {
    index += 1;
    let inClass = false;
    while (index < source.length && (source[index] !== "/" || inClass)) {
      if (source[index] === "\\") index += 1;
      else if (source[index] === "[") inClass = true;
      else if (source[index] === "]") inClass = false;
      index += 1;
    }
    index += 1;
  };
  const scan = (untilBrace: boolean) => {
    let depth = 0;
    while (index < source.length) {
      const char = source[index]!;
      const next = source[index + 1];
      if (char === "\n") {
        line += 1;
        index += 1;
      } else if (char === "/" && next === "/") {
        const end = source.indexOf("\n", index);
        found.push({ line, text: source.slice(index, end < 0 ? undefined : end).trim() });
        index = end < 0 ? source.length : end;
      } else if (char === "/" && next === "*") {
        const end = source.indexOf("*/", index + 2);
        const body = source.slice(index, end < 0 ? undefined : end + 2);
        found.push({ line, text: body.split("\n")[0]!.trim() });
        line += body.split("\n").length - 1;
        index += body.length;
      } else if (char === '"' || char === "'") {
        skipQuoted(char);
        previous = '"';
        word = "";
      } else if (char === "`") {
        skipTemplate();
        previous = '"';
        word = "";
      } else if (char === "/" && regexAllowed()) {
        skipRegex();
        previous = '"';
        word = "";
      } else if (/[A-Za-z0-9_$]/.test(char)) {
        let end = index;
        while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) end += 1;
        word = source.slice(index, end);
        previous = "a";
        index = end;
      } else {
        if (char === "{") depth += 1;
        if (char === "}") {
          if (untilBrace && depth === 0) {
            index += 1;
            return;
          }
          depth -= 1;
        }
        if (!/\s/.test(char)) {
          previous = char;
          word = "";
        }
        index += 1;
      }
    }
  };
  scan(false);
  return found;
}

function union(boxes: Box[]): Box {
  return { minX: Math.min(...boxes.map((box) => box.minX)), maxX: Math.max(...boxes.map((box) => box.maxX)), minY: Math.min(...boxes.map((box) => box.minY)), maxY: Math.max(...boxes.map((box) => box.maxY)) };
}

function extentFindings(id: string, lessonText: string): Finding[] {
  const lesson = parseJsonl("lesson", lessonText);
  const timeline = new Timeline(startSceneOf(lesson.lesson));
  const findings: Finding[] = [];
  for (const step of lesson.steps) {
    timeline.addStep(step);
    for (const object of timeline.finalScene.objects.filter((candidate) => candidate.defKey === `lab:${id}`)) {
      const size = definitionOf(object).size(object.state);
      const boxes = definitionOf(object).draw(object.state, { objectId: object.id, links: {} }).map(boxOf).filter((box): box is Box => box !== null);
      if (boxes.length === 0) {
        findings.push({ stage: "extent", message: `step ${step.step}: ${object.id} draws nothing measurable, but size() is ${size.w} by ${size.h}` });
        continue;
      }
      const extent = union(boxes);
      const slackX = EDGE_TOLERANCE.pixels + size.w * EDGE_TOLERANCE.share;
      const slackY = EDGE_TOLERANCE.pixels + size.h * EDGE_TOLERANCE.share;
      const problems = [
        extent.minX < -slackX && `its left edge is ${Math.round(-extent.minX)} px outside`,
        extent.maxX > size.w + slackX && `its right edge is ${Math.round(extent.maxX - size.w)} px outside`,
        extent.minY < -slackY && `its top edge is ${Math.round(-extent.minY)} px outside`,
        extent.maxY > size.h + slackY && `its bottom edge is ${Math.round(extent.maxY - size.h)} px outside`,
        extent.minX > slackX && `there is ${Math.round(extent.minX)} px of empty offset on the left`,
        extent.minY > slackY && `there is ${Math.round(extent.minY)} px of empty offset at the top`,
        size.w - extent.maxX > slackX && `there is ${Math.round(size.w - extent.maxX)} px of empty space on the right`,
        size.h - extent.maxY > slackY && `there is ${Math.round(size.h - extent.maxY)} px of empty space at the bottom`,
      ].filter(Boolean);
      if (problems.length) findings.push({ stage: "extent", message: `step ${step.step}: size() says ${Math.round(size.w)} by ${Math.round(size.h)} but the drawn extent is x ${Math.round(extent.minX)} to ${Math.round(extent.maxX)}, y ${Math.round(extent.minY)} to ${Math.round(extent.maxY)}: ${problems.join(", ")}. size() must be the true extent of what draw() paints, with the drawing starting at 0,0` });
    }
  }
  return findings;
}

function withoutReading(lessonText: string): { header: ReturnType<typeof parseJsonl>["lesson"]; steps: Step[] } {
  const lesson = parseJsonl("lesson", lessonText);
  const removed = new Set<string>();
  const steps = lesson.steps.map((step): Step => {
    const scene = Object.fromEntries(Object.entries(step.scene ?? {}).filter(([objectId, spec]) => {
      const wordy = spec !== null && typeof spec.kind === "string" && WORD_KINDS.includes(spec.kind);
      if (wordy) removed.add(objectId);
      return !wordy;
    }));
    const kept = (step.do ?? []).filter((op) => !(op.on ?? []).some((target) => removed.has(target.split("[")[0]!)));
    const { challenge: _challenge, ...rest } = step;
    return { ...rest, scene, do: kept };
  });
  return { header: { ...lesson.lesson, reading: false }, steps };
}

function readingFindings(lessonText: string): Finding[] {
  const quiet = withoutReading(lessonText);
  const timeline = new Timeline(startSceneOf(quiet.header));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const step of quiet.steps) {
    const span = timeline.addStep(step);
    span.errors.forEach((message) => findings.push({ stage: "reading", message: `with "reading": false, ${message}` }));
    if (span.errors.length) continue;
    for (const fraction of [0.02, 0.5, 0.98]) {
      for (const item of renderFrame(timeline, span.start + (span.end - span.start) * fraction, THEMES.plain).items) {
        const words = [item.text, item.latex, ...(item.spans ?? []).map((part) => part.text)].filter((text): text is string => typeof text === "string" && /[A-Za-z0-9]/.test(text));
        for (const word of words) {
          if (item.kind === "text" || item.kind === "math" || item.kind === "code") {
            const key = `${item.id}:${word}`;
            if (!seen.has(key)) findings.push({ stage: "reading", message: `step ${step.step}: with "reading": false the Lab still drew the word or number "${word}" (drawable "${item.id}"); spec.reading !== false must gate every word, number and unit` });
            seen.add(key);
          }
        }
      }
    }
  }
  return findings;
}

async function run(argv: string[], env: Record<string, string> = {}, cwd?: string): Promise<{ code: number; text: string }> {
  const process_ = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd, env: { ...process.env, ...env } });
  const [stdout, stderr] = await Promise.all([new Response(process_.stdout).text(), new Response(process_.stderr).text()]);
  return { code: await process_.exited, text: `${stdout}${stderr}`.trim() };
}

async function typecheck(workspace: string): Promise<Finding[]> {
  const { code, text } = await run([join(PLAYER_ROOT, "node_modules/.bin/tsc"), "-p", join(workspace, "tsconfig.json"), "--noEmit", "--pretty", "false"], {}, workspace);
  if (code === 0) return [];
  const lines = text.split("\n").filter((line) => line.trim());
  const outside = lines.find((line) => /^\.\.\//.test(line) || /^[^\s]+\.ts\(/.test(line) === false && /^error/.test(line));
  if (outside) return [{ stage: "tool", message: `the typecheck failed in a file outside the Lab, which is not the Lab's fault: ${outside}` }];
  return lines.slice(0, 25).map((message) => ({ stage: "typecheck", message }));
}

function commentFindings(source: string, path: string): Finding[] {
  return findComments(source).map(({ line, text }) => ({ stage: "comments", message: `${path}:${line}: comment ${JSON.stringify(text)}; delete it and make the code say it, because minted Labs carry no comments` }));
}

async function validateLesson(lessonPath: string, mintedDir: string, label: string): Promise<Finding[]> {
  const { code, text } = await run(["bun", join(PLAYER_ROOT, "tools/validate.ts"), lessonPath], { PENNYDROP_MINTED_DIR: mintedDir });
  if (code === 0) return [];
  return text.split("\n").filter((line) => line.trim() && !/^step \d+: ok$/.test(line)).map((message) => ({ stage: "validate", message: `${label}: ${message}` }));
}

interface Contract {
  findings: Finding[];
  exampleLesson: string | null;
}

async function contractOf(id: string, lessonText: string, mintedDir: string): Promise<Contract> {
  process.env.PENNYDROP_MINTED_DIR = mintedDir;
  const { registerAllLabs } = await import("./load");
  const { allDefinitions } = await import("../src/registry");
  await registerAllLabs();
  const entry = allDefinitions().find(({ key }) => key === `lab:${id}`);
  if (!entry) return { findings: [{ stage: "contract", message: `the module built from src/labs/${id}.ts registers no Lab with id "${id}": export const lab with id "${id}"` }], exampleLesson: null };
  const lesson = parseJsonl("lesson", lessonText);
  const usedOps = new Set(lesson.steps.flatMap((step) => (step.do ?? []).map((op) => op.op)));
  const usedByLab = lesson.steps.some((step) => Object.values(step.scene ?? {}).some((spec) => spec?.lab === id));
  const findings: Finding[] = [];
  if (!usedByLab) findings.push({ stage: "contract", message: `lesson.jsonl never puts an object with "lab": "${id}" in a scene` });
  for (const op of Object.keys(entry.def.ops)) {
    if (!usedOps.has(op)) findings.push({ stage: "contract", message: `lesson.jsonl never uses the catalog op "${op}"; the example Lesson must exercise every op so it is proven to work` });
  }
  const { example } = entry.def.catalog;
  if (example.length === 0) findings.push({ stage: "contract", message: "catalog.example is empty; give at least one complete Step line a writer can copy" });
  const exampleLesson = example.length ? [JSON.stringify({ lesson: { title: "catalog example" } }), ...example].join("\n") : null;
  return { findings, exampleLesson };
}

async function framesFindings(workspace: string, dist: string | undefined, mintedDir: string): Promise<Finding[]> {
  const frames = join(workspace, "frames");
  rmSync(frames, { recursive: true, force: true });
  const { code, text } = await run(["bun", join(PLAYER_ROOT, "tools/frames.ts"), "--lesson", join(workspace, "lesson.jsonl"), "--themes", "pattern,film,kids,plain", "--check", ...(dist ? ["--dist", dist] : []), "--minted", mintedDir, "--out", frames]);
  if (code === 0) return [];
  const differing = text.split("\n").filter((line) => line.startsWith("DIFF"));
  if (differing.length === 0) return [{ stage: "tool", message: `frames.ts failed before it could compare frames, which is not the Lab's fault: ${text.slice(-600)}` }];
  return differing.map((line) => ({ stage: "frames", message: `${line}: the same time rendered two different images, so something other than Lab state reaches the frame (Math.random, Date, performance.now, a mutable module variable, or an object iteration order that changes)` }));
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

export async function checkWorkspace(workspace: string, dist: string | undefined): Promise<Finding[]> {
  const id = basename(workspace);
  const sourcePath = join(workspace, "src/labs", `${id}.ts`);
  const lessonPath = join(workspace, "lesson.jsonl");
  const missing = [sourcePath, lessonPath].filter((path) => !existsSync(path));
  if (missing.length) return missing.map((path) => ({ stage: "files", message: `${path} does not exist; write it` }));
  const source = readFileSync(sourcePath, "utf8");
  const lessonText = readFileSync(lessonPath, "utf8");
  const mintedDir = join(workspace, "build");
  rmSync(mintedDir, { recursive: true, force: true });
  mkdirSync(mintedDir, { recursive: true });

  const findings = [...(await typecheck(workspace)), ...commentFindings(source, `src/labs/${id}.ts`)];
  if (findings.some(({ stage }) => stage === "tool")) return findings;
  const buildErrors = await buildMinted(sourcePath, join(mintedDir, `${id}.js`));
  findings.push(...buildErrors.map((message) => ({ stage: "build", message })));
  if (buildErrors.length) return findings;

  const loadFailures = await validateLesson(lessonPath, mintedDir, "lesson.jsonl");
  findings.push(...loadFailures);
  if (loadFailures.length) return findings;

  const contract = await contractOf(id, lessonText, mintedDir);
  findings.push(...contract.findings);
  if (contract.exampleLesson) {
    const examplePath = join(mintedDir, "catalog-example.jsonl");
    writeFileSync(examplePath, contract.exampleLesson);
    findings.push(...(await validateLesson(examplePath, mintedDir, "catalog.example")));
  }
  findings.push(...extentFindings(id, lessonText), ...(await compositionFindings(parseJsonl("lesson", lessonText), (key) => key === `lab:${id}`)), ...readingFindings(lessonText));
  if (findings.length === 0) findings.push(...(await framesFindings(workspace, dist, mintedDir)));
  return findings;
}

async function builtinCompositionFindings(): Promise<Finding[]> {
  const { registerAllLabs, LESSONS_ROOT } = await import("./load");
  const { allDefinitions } = await import("../src/registry");
  await registerAllLabs();
  const findings: Finding[] = [];
  const lessonFiles = [...new Bun.Glob("*.jsonl").scanSync(LESSONS_ROOT)].sort();
  for (const { key, def } of allDefinitions().filter(({ key }) => key.startsWith("lab:"))) {
    const { example } = def.catalog;
    if (example.length) findings.push(...(await compositionFindings(parseJsonl(key, [JSON.stringify({ lesson: { title: "catalog example" } }), ...example].join("\n")), (defKey) => defKey === key, `${key} catalog example, `)));
  }
  for (const file of lessonFiles) {
    const lesson = parseJsonl(file, readFileSync(join(LESSONS_ROOT, file), "utf8"));
    findings.push(...(await compositionFindings(lesson, (defKey) => defKey.startsWith("lab:"), `${file}, `)));
  }
  return findings;
}

if (import.meta.main && process.argv[2] === "--builtin") {
  const findings = await builtinCompositionFindings();
  findings.forEach(({ stage, message }) => console.log(`${stage}: ${message}`));
  console.log(`${findings.length} composition findings across the built-in Labs`);
  process.exit(findings.length ? 1 : 0);
}

if (import.meta.main) {
  const workspace = process.argv[2] ? resolve(process.argv[2]) : null;
  if (!workspace) {
    console.error("usage: bun player/tools/mint-check.ts <workspace> [--dist built-player-dir] [--json]");
    process.exit(2);
  }
  const dist = option("dist");
  const findings = await checkWorkspace(workspace, dist ? resolve(dist) : undefined);
  if (process.argv.includes("--json")) console.log(JSON.stringify(findings));
  else if (findings.length === 0) console.log(`ok: ${basename(workspace)} passes every check (the visual judge runs after you finish)`);
  else findings.forEach(({ stage, message }) => console.log(`${stage}: ${message}`));
  process.exit(findings.length ? 1 : 0);
}
