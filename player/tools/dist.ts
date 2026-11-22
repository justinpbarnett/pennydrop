import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export const PLAYER_ROOT = resolve(import.meta.dir, "..");
const MEDIA_ROOT = resolve(PLAYER_ROOT, "../data/media");
const MINTED_ROOT = resolve(PLAYER_ROOT, "../data/minted-labs");
const LAND_FILE = resolve(PLAYER_ROOT, "../data/mint/_land/land.json");
const BUILD_CACHE = join(PLAYER_ROOT, "node_modules/.cache/pennydrop-dist");
const BUILD_INPUTS = ["src", "public", "index.html", "frame.html", "film.html", "tools/film.vite.config.ts", "vite.config.ts", "package.json", "tsconfig.json"];
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

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

export async function builtPlayer(): Promise<string> {
  const target = join(BUILD_CACHE, sourceHash());
  if (existsSync(target)) return target;
  mkdirSync(BUILD_CACHE, { recursive: true });
  const staging = mkdtempSync(join(BUILD_CACHE, "building-"));
  const vite = Bun.spawn([join(PLAYER_ROOT, "node_modules/.bin/vite"), "build", "--config", join(PLAYER_ROOT, "tools/film.vite.config.ts"), "--logLevel", "error", "--outDir", staging, "--emptyOutDir"], { cwd: PLAYER_ROOT, stdout: "inherit", stderr: "inherit" });
  if ((await vite.exited) !== 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error("vite build failed");
  }
  try {
    renameSync(staging, target);
  } catch {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

export function serveDist(dist: string) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/land") return existsSync(LAND_FILE) ? new Response(Bun.file(LAND_FILE), { headers: { "content-type": "application/json" } }) : new Response("not found", { status: 404 });
      if (path === "/api/minted-labs") {
        const ids = existsSync(MINTED_ROOT) ? readdirSync(MINTED_ROOT).filter((file) => file.endsWith(".js")).map((file) => file.replace(/\.js$/, "")) : [];
        return Response.json(ids.map((id) => ({ id, url: `/api/minted-labs/${id}.js` })));
      }
      const [root, relativePath] = path.startsWith("/media/")
        ? [MEDIA_ROOT, path.slice("/media".length)]
        : path.startsWith("/api/minted-labs/")
          ? [MINTED_ROOT, path.slice("/api/minted-labs".length)]
          : [dist, path === "/" ? "index.html" : path];
      const file = join(root, relativePath);
      if (!file.startsWith(root) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file), { headers: { "content-type": CONTENT_TYPES[extname(file)] ?? "text/javascript" } });
    },
  });
}
