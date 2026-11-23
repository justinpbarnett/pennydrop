import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseJsonl } from "../src/format";
import { registerMinted } from "../src/minted";
import { allDefinitions, registerModules } from "../src/registry";

const SOURCE_ROOT = resolve(import.meta.dir, "../src");
export const LESSONS_ROOT = resolve(import.meta.dir, "../../lessons");

const MINTED_DIR = process.env.PENNYDROP_MINTED_DIR ?? resolve(import.meta.dir, "../../data/minted-labs/dist");
export const mintedIds: string[] = [];

async function registerMintedLabs(): Promise<void> {
  const registered = new Set(allDefinitions().map(({ key }) => key));
  const listing = [];
  if (!existsSync(MINTED_DIR)) return;
  for await (const file of new Bun.Glob("*.js").scan({ cwd: MINTED_DIR, onlyFiles: true })) {
    const id = file.replace(/\.js$/, "");
    if (!registered.has(`lab:${id}`)) listing.push({ id, url: resolve(MINTED_DIR, file) });
  }
  mintedIds.push(...(await registerMinted(listing, (url) => import(url))));
}

async function registerSources(patterns: string[]): Promise<void> {
  const modules: Record<string, never> = {};
  for (const pattern of patterns) {
    for await (const file of new Bun.Glob(pattern).scan(SOURCE_ROOT)) {
      modules[file] = (await import(resolve(SOURCE_ROOT, file))) as never;
    }
  }
  registerModules(modules);
}

export async function registerAllLabs(): Promise<void> {
  await registerSources(["labs/*.ts", "primitives/*.ts"]);
  await registerMintedLabs();
}

export async function readLessonFile(pathOrId: string) {
  const path = pathOrId.endsWith(".jsonl") ? resolve(pathOrId) : resolve(LESSONS_ROOT, `${pathOrId}.jsonl`);
  const id = path.split("/").pop()!.replace(/\.jsonl$/, "");
  return parseJsonl(id, await Bun.file(path).text());
}
