import { resolve } from "node:path";
import { parseJsonl } from "../src/format";
import { registerModules } from "../src/registry";

const SOURCE_ROOT = resolve(import.meta.dir, "../src");
export const LESSONS_ROOT = resolve(import.meta.dir, "../../lessons");

export async function registerAllLabs(): Promise<void> {
  const modules: Record<string, never> = {};
  for (const pattern of ["labs/*.ts", "primitives/*.ts"]) {
    for await (const file of new Bun.Glob(pattern).scan(SOURCE_ROOT)) {
      modules[file] = (await import(resolve(SOURCE_ROOT, file))) as never;
    }
  }
  registerModules(modules);
}

export async function readLessonFile(pathOrId: string) {
  const path = pathOrId.endsWith(".jsonl") ? resolve(pathOrId) : resolve(LESSONS_ROOT, `${pathOrId}.jsonl`);
  const id = path.split("/").pop()!.replace(/\.jsonl$/, "");
  return parseJsonl(id, await Bun.file(path).text());
}
