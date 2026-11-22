import { resolve } from "node:path";
import { defineConfig } from "vite";
import base from "../vite.config";

export default defineConfig({
  ...base,
  build: { ...base.build, rollupOptions: { input: { film: resolve(import.meta.dirname, "../film.html") } } },
});
