import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { BunPlugin } from "bun";
import { SHARED_GLOBAL, SHARED_MODULES } from "../src/minted";

const OWN_ASSET_IMPORT = /^\.\/assets\/[a-z0-9-]+\/[\w.-]+\.json$/;
const SHARED_IMPORT = new RegExp(`^\\.\\./(${Object.keys(SHARED_MODULES).join("|")})$`);

function sharedModuleSource(name: string): string {
  const exports = Object.keys(SHARED_MODULES[name]!);
  return [`const shared = globalThis.${SHARED_GLOBAL}[${JSON.stringify(name)}];`, ...exports.map((key) => `export const ${key} = shared.${key};`)].join("\n");
}

const sharedPlugin: BunPlugin = {
  name: "pennydrop-shared",
  setup(build) {
    build.onResolve({ filter: SHARED_IMPORT }, (args) => ({ path: args.path.slice(3), namespace: "shared" }));
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (args.importer.includes("/node_modules/") || OWN_ASSET_IMPORT.test(args.path)) return undefined;
      throw new Error(`${args.importer} imports "${args.path}": a minted Lab may import only ${Object.keys(SHARED_MODULES).map((name) => `"../${name}"`).join(" and ")} from the player, plus npm packages and the JSON files under "./assets/<id>/"`);
    });
    build.onLoad({ filter: /.*/, namespace: "shared" }, (args) => ({ contents: sharedModuleSource(args.path), loader: "js" }));
  },
};

export async function buildMinted(source: string, output: string): Promise<string[]> {
  const result = await Bun.build({ entrypoints: [source], target: "browser", format: "esm", plugins: [sharedPlugin], throw: false });
  if (!result.success || result.outputs.length !== 1) {
    return result.logs.filter((log) => log.level === "error").map((log) => `${log.position ? `${log.position.file}:${log.position.line}: ` : ""}${log.message}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  await Bun.write(output, await result.outputs[0]!.text());
  return [];
}

if (import.meta.main) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) {
    console.error("usage: bun player/tools/mint-build.ts <lab.ts> <out.js>");
    process.exit(2);
  }
  const errors = await buildMinted(source, output);
  errors.forEach((error) => console.error(error));
  process.exit(errors.length ? 1 : 0);
}
