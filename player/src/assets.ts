import { loadHighlighter } from "./highlight";

const KINDS = { code: new Set(["code", "primitive:code"]) };

function uses(value: unknown, names: Set<string>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if ((typeof entry.kind === "string" && names.has(entry.kind)) || (typeof entry.defKey === "string" && names.has(entry.defKey))) return true;
  if (typeof entry.lab === "string" && names.has(entry.lab)) return true;
  return Object.values(entry).some((child) => uses(child, names));
}

export const usesCode = (value: unknown) => uses(value, KINDS.code);

export async function prepareStepAssets(value: unknown): Promise<void> {
  if (usesCode(value)) await loadHighlighter();
}
