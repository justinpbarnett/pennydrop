import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vite";

const LESSONS_DIR = resolve(import.meta.dirname, "../lessons");
const SERVER = "http://127.0.0.1:8740";

function lessonTitle(id: string): string {
  const [header] = readFileSync(resolve(LESSONS_DIR, `${id}.jsonl`), "utf8").split("\n");
  return (JSON.parse(header!) as { lesson: { title: string } }).lesson.title;
}

const serveLessons: Connect.NextHandleFunction = (request, response, next) => {
  const url = new URL(request.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/lessons/")) return next();
  const name = url.pathname.slice("/lessons/".length);
  if (name === "index.json") {
    const ids = existsSync(LESSONS_DIR) ? readdirSync(LESSONS_DIR).filter((file) => file.endsWith(".jsonl")).map((file) => file.replace(/\.jsonl$/, "")) : [];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(ids.map((id) => ({ id, title: lessonTitle(id) }))));
    return;
  }
  const file = resolve(LESSONS_DIR, name);
  if (!file.startsWith(LESSONS_DIR) || !existsSync(file)) return next();
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(readFileSync(file));
};

const staticLessons: Plugin = {
  name: "pennydrop-static-lessons",
  configureServer: (server) => void server.middlewares.use(serveLessons),
  configurePreviewServer: (server) => void server.middlewares.use(serveLessons),
};

export default defineConfig({
  plugins: [staticLessons],
  server: { port: 5173, host: true, proxy: { "/api": SERVER, "/media": SERVER } },
  preview: { port: 4173, proxy: { "/api": SERVER, "/media": SERVER } },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: { input: { index: resolve(import.meta.dirname, "index.html"), frame: resolve(import.meta.dirname, "frame.html") } },
  },
});
