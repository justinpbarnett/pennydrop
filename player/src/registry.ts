import { type AnyLabDef, fail, LabError } from "./lab";
import type { ObjectSpec } from "./format";

export interface LabModule {
  lab?: AnyLabDef;
  primitive?: AnyLabDef;
  primitives?: AnyLabDef[];
}

const definitions = new Map<string, AnyLabDef>();

const labKey = (id: string) => `lab:${id}`;
const primitiveKey = (kind: string) => `primitive:${kind}`;

export function registerModules(modules: Record<string, LabModule>): void {
  for (const [path, module] of Object.entries(modules)) {
    if (module.lab) definitions.set(labKey(module.lab.id), module.lab);
    for (const primitive of [module.primitive, ...(module.primitives ?? [])]) {
      if (primitive) definitions.set(primitiveKey(primitive.id), primitive);
    }
    if (!module.lab && !module.primitive && !module.primitives) {
      fail(`${path} exports no "lab", "primitive" or "primitives"`);
    }
  }
}

export function allDefinitions(): { key: string; def: AnyLabDef }[] {
  return [...definitions.entries()].map(([key, def]) => ({ key, def }));
}

export function definitionByKey(key: string): AnyLabDef {
  const def = definitions.get(key);
  if (!def) throw new LabError(`no Lab or primitive registered as "${key}"`);
  return def;
}

export function definitionIfRegistered(key: string): AnyLabDef | undefined {
  return definitions.get(key);
}

export function specText(key: string): string {
  const [type, id] = key.split(":");
  return `"${type === "lab" ? "lab" : "kind"}": "${id}"`;
}

export function wordlessKeys(): string[] {
  return allDefinitions().filter(({ def }) => def.reading === "optional").map(({ key }) => specText(key));
}

function known(prefix: string): string {
  return [...definitions.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).join(", ");
}

export function definitionKeyForSpec(objectId: string, spec: ObjectSpec): string {
  if (typeof spec.lab === "string") {
    if (!definitions.has(labKey(spec.lab))) fail(`${objectId}: unknown lab "${spec.lab}"; available Labs: ${known("lab:")}`);
    return labKey(spec.lab);
  }
  if (typeof spec.kind === "string") {
    if (!definitions.has(primitiveKey(spec.kind))) fail(`${objectId}: unknown kind "${spec.kind}"; available kinds: ${known("primitive:")}`);
    return primitiveKey(spec.kind);
  }
  return fail(`${objectId} needs "lab" (one of ${known("lab:")}) or "kind" (one of ${known("primitive:")})`);
}
