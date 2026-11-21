import type { AnyLabDef } from "./lab";
import { definitionIfRegistered } from "./registry";

function collectDefs(value: unknown, found: Set<AnyLabDef>): void {
  if (typeof value !== "object" || value === null) return;
  const entry = value as Record<string, unknown>;
  const keys = [
    typeof entry.defKey === "string" ? entry.defKey : null,
    typeof entry.lab === "string" ? `lab:${entry.lab}` : null,
    typeof entry.kind === "string" ? `primitive:${entry.kind}` : null,
  ];
  for (const key of keys) {
    const def = key === null ? undefined : definitionIfRegistered(key);
    if (def) found.add(def);
  }
  Object.values(entry).forEach((child) => collectDefs(child, found));
}

export async function prepareStepAssets(value: unknown): Promise<void> {
  const defs = new Set<AnyLabDef>();
  collectDefs(value, defs);
  await Promise.all([...defs].map((def) => def.prepare?.()));
}
