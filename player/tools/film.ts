import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import type { FilmManifest } from "../src/film/main";
import { isThemeId, THEME_IDS, THEMES } from "../src/theme";
import { builtPlayer, serveDist } from "./dist";

const WIDTH = 1920;
const HEIGHT = 1080;
const DEFAULT_WORKERS = 4;
const REGION_PROBE_SECONDS = 0.5;
const CRF = "14";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function usage(message: string): never {
  console.error(`${message}\nusage:\n  bun player/tools/film.ts theme <theme>\n  bun player/tools/film.ts plan --film <film.jsonl>\n  bun player/tools/film.ts audit --film <film.jsonl>\n  bun player/tools/film.ts stills --film <film.jsonl> --dir <directory> --times <seconds,...>\n  bun player/tools/film.ts render --film <film.jsonl> --out <video.mp4> [--workers 4] [--seconds N]`);
  process.exit(2);
}

async function openPage(browser: Browser, origin: string, text: string): Promise<{ page: Page; manifest: FilmManifest }> {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(`${origin}/film.html`);
  await page.evaluate(() => window.film.ready);
  const manifest = await page.evaluate((source) => window.film.load(source), text);
  return { page, manifest };
}

async function withFilm<T>(text: string, count: number, use: (pages: Page[], manifest: FilmManifest) => Promise<T>): Promise<T> {
  const server = serveDist(await builtPlayer());
  const browser = await chromium.launch();
  try {
    const opened = await Promise.all(Array.from({ length: count }, () => openPage(browser, `http://localhost:${server.port}`, text)));
    return await use(opened.map((entry) => entry.page), opened[0]!.manifest);
  } finally {
    await browser.close();
    server.stop();
  }
}

async function annotate(page: Page, manifest: FilmManifest): Promise<FilmManifest> {
  const cues = [];
  for (const cue of manifest.cues) {
    const regions = cue.kind === "do" ? await page.evaluate((time) => window.film.regions(time), cue.opStart + REGION_PROBE_SECONDS) : {};
    cues.push({ ...cue, region: cue.object ? (regions[cue.object] ?? null) : null });
  }
  return { ...manifest, cues };
}

const command = process.argv[2];
if (command === "theme") {
  const id = process.argv[3] ?? "";
  if (!isThemeId(id)) usage(`unknown theme "${id}"; use ${THEME_IDS.join(", ")}`);
  console.log(JSON.stringify({ id, film: THEMES[id].film ?? null, ground: THEMES[id].colors.ground }));
  process.exit(0);
}

const filmPath = option("film") ?? usage("--film is required");
const text = await Bun.file(resolve(filmPath)).text();

if (command === "plan") {
  const manifest = await withFilm(text, 1, async ([page], planned) => annotate(page!, planned));
  console.log(JSON.stringify(manifest));
  process.exit(0);
}

if (command === "audit") {
  const report = await withFilm(text, 1, async ([page]) => page!.evaluate(() => window.film.audit()));
  console.log(JSON.stringify(report));
  process.exit(0);
}

if (command === "stills") {
  const directory = resolve(option("dir") ?? usage("--dir is required"));
  const times = (option("times") ?? usage("--times is required")).split(",").map(Number);
  mkdirSync(directory, { recursive: true });
  await withFilm(text, 1, async ([page]) => {
    for (const time of times) {
      await page!.evaluate((at) => window.film.seek(at), time);
      writeFileSync(`${directory}/f${time}.png`, await page!.screenshot({ type: "png" }));
    }
  });
  process.exit(0);
}

if (command !== "render") usage(`unknown command "${command}"`);
const out = resolve(option("out") ?? usage("--out is required"));
const workers = Number(option("workers") ?? DEFAULT_WORKERS);
mkdirSync(dirname(out), { recursive: true });

await withFilm(text, workers, async (pages, planned) => {
  const manifest = await annotate(pages[0]!, planned);
  const limit = option("seconds") ? Math.min(manifest.duration, Number(option("seconds"))) : manifest.duration;
  const frames = Math.ceil(limit * manifest.fps);
  const ffmpeg = Bun.spawn(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(manifest.fps), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", CRF, "-vf", "scale=in_range=full:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart", out],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  const ready = new Map<number, Buffer>();
  let nextToWrite = 0;
  let waiting: (() => void) | null = null;
  const drain = async () => {
    while (ready.has(nextToWrite)) {
      ffmpeg.stdin.write(ready.get(nextToWrite)!);
      ready.delete(nextToWrite);
      nextToWrite += 1;
    }
    await ffmpeg.stdin.flush();
    waiting?.();
  };
  let nextToRender = 0;
  const started = performance.now();
  await Promise.all(
    pages.map(async (page) => {
      for (;;) {
        const index = nextToRender++;
        if (index >= frames) return;
        while (index - nextToWrite > workers * 4) await new Promise<void>((resume) => (waiting = resume));
        await page.evaluate((time) => window.film.seek(time), index / manifest.fps);
        ready.set(index, await page.screenshot({ type: "jpeg", quality: 97 }));
        await drain();
        if (index % 60 === 0) process.stderr.write(`\rframe ${index}/${frames}`);
      }
    }),
  );
  ffmpeg.stdin.end();
  if ((await ffmpeg.exited) !== 0) throw new Error("ffmpeg failed");
  const seconds = (performance.now() - started) / 1000;
  writeFileSync(`${out}.manifest.json`, JSON.stringify(manifest));
  console.log(`\nrendered ${frames} frames in ${seconds.toFixed(1)} s: ${(frames / seconds).toFixed(2)} frames per second with ${workers} pages -> ${out}`);
});
process.exit(0);
