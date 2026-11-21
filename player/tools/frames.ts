import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { chromium } from "playwright-core";
import { isThemeId, THEME_IDS, type ThemeId } from "../src/theme";
import { LESSONS_ROOT } from "./load";

const PLAYER_ROOT = resolve(import.meta.dir, "..");
const BUILD_CACHE = join(PLAYER_ROOT, "node_modules/.cache/pennydrop-frames");
const BUILD_INPUTS = ["src", "public", "index.html", "frame.html", "vite.config.ts", "package.json", "tsconfig.json"];
const STALE_BUILD_MS = 60 * 60 * 1000;
const WIDTH = 1600;
const HEIGHT = 900;
const DEFAULT_FRAME_COUNT = 8;
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml" };

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function usage(message: string): never {
  console.error(`${message}\nusage: bun player/tools/frames.ts --lesson <id|file> [--theme pattern | --themes pattern,film] [--times 1,2.5,8] [--out dir] [--check]`);
  process.exit(2);
}

function themesFromArgs(): ThemeId[] {
  const names = (option("themes") ?? option("theme") ?? "pattern").split(",");
  const bad = names.filter((name) => !isThemeId(name));
  if (bad.length) usage(`unknown theme ${bad.join(", ")}; use ${THEME_IDS.join(", ")}`);
  return names as ThemeId[];
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)]));
}

function sourceHash(): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const files = BUILD_INPUTS.flatMap((input) => (input.includes(".") ? [join(PLAYER_ROOT, input)] : filesUnder(join(PLAYER_ROOT, input)))).filter(existsSync).sort();
  for (const file of files) hasher.update(relative(PLAYER_ROOT, file)).update(readFileSync(file));
  return hasher.digest("hex").slice(0, 16);
}

function pruneBuildCache(keep: string): void {
  const cutoff = Date.now() - STALE_BUILD_MS;
  for (const entry of readdirSync(BUILD_CACHE)) {
    const path = join(BUILD_CACHE, entry);
    if (path !== keep && statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
  }
}

async function builtPlayer(): Promise<string> {
  const target = join(BUILD_CACHE, sourceHash());
  mkdirSync(BUILD_CACHE, { recursive: true });
  pruneBuildCache(target);
  if (existsSync(target)) {
    utimesSync(target, new Date(), new Date());
    return target;
  }
  const staging = mkdtempSync(join(BUILD_CACHE, "building-"));
  const vite = Bun.spawn([join(PLAYER_ROOT, "node_modules/.bin/vite"), "build", "--logLevel", "error", "--outDir", staging, "--emptyOutDir"], { cwd: PLAYER_ROOT, stdout: "inherit", stderr: "inherit" });
  if ((await vite.exited) !== 0) {
    rmSync(staging, { recursive: true, force: true });
    usage("vite build failed");
  }
  try {
    renameSync(staging, target);
  } catch {
    rmSync(staging, { recursive: true, force: true });
  }
  utimesSync(target, new Date(), new Date());
  return target;
}

function serveDist(dist: string) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const file = join(dist, path === "/" ? "index.html" : path);
      if (!file.startsWith(dist) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file), { headers: { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" } });
    },
  });
}

const lessonArg = option("lesson") ?? usage("--lesson is required");
const lessonPath = lessonArg.endsWith(".jsonl") ? resolve(lessonArg) : join(LESSONS_ROOT, `${lessonArg}.jsonl`);
if (!existsSync(lessonPath)) usage(`no lesson file at ${lessonPath}`);
const lessonName = lessonPath.split("/").pop()!.replace(/\.jsonl$/, "");
const themes = themesFromArgs();
const outDir = resolve(option("out") ?? join(PLAYER_ROOT, ".frames"));
mkdirSync(outDir, { recursive: true });
const server = serveDist(await builtPlayer());
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
await page.goto(`http://localhost:${server.port}/frame.html`);
await page.evaluate(() => window.pennydrop.ready);
const lessonText = await Bun.file(lessonPath).text();
await page.evaluate((text) => window.pennydrop.load(text), lessonText);
const stepErrors = await page.evaluate(() => window.pennydrop.stepErrors());
if (stepErrors.length) {
  stepErrors.forEach((message) => console.error(message));
  await browser.close();
  server.stop();
  process.exit(1);
}
const duration = await page.evaluate(() => window.pennydrop.duration());

const times = option("times")
  ? option("times")!.split(",").map(Number)
  : Array.from({ length: DEFAULT_FRAME_COUNT }, (_, index) => +(((index + 0.5) / DEFAULT_FRAME_COUNT) * duration).toFixed(2));
if (times.some(Number.isNaN)) usage("--times must be comma separated seconds");

async function shoot(theme: ThemeId, time: number): Promise<Buffer> {
  await page.evaluate(([id, at]) => { window.pennydrop.setTheme(id as ThemeId); window.pennydrop.seek(at as number); }, [theme, time]);
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot();
}

console.log(`${lessonName}: ${duration.toFixed(2)} s, ${times.length} times, themes ${themes.join(", ")}`);
let differing = 0;
for (const theme of themes) {
  for (const time of times) {
    const first = await shoot(theme, time);
    const file = join(outDir, `${lessonName}-${theme}-${time.toFixed(2)}.png`);
    await Bun.write(file, first);
    if (!process.argv.includes("--check")) {
      console.log(file);
      continue;
    }
    const other = THEME_IDS.find((id) => id !== theme)!;
    await shoot(other, (time + duration / 2) % duration);
    const again = await shoot(theme, time);
    const same = first.equals(again);
    differing += same ? 0 : 1;
    console.log(`${same ? "SAME" : "DIFF"} ${theme} t=${time.toFixed(2)}`);
  }
}
await browser.close();
server.stop();
process.exit(differing ? 1 : 0);
