import { loadHighlighter } from "./highlight";
import { loadTypesetter } from "./typeset";

const KINDS = { code: new Set(["code", "primitive:code"]), math: new Set(["math", "primitive:math"]) };

function uses(value: unknown, names: Set<string>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if ((typeof entry.kind === "string" && names.has(entry.kind)) || (typeof entry.defKey === "string" && names.has(entry.defKey))) return true;
  return Object.values(entry).some((child) => uses(child, names));
}

export const usesCode = (value: unknown) => uses(value, KINDS.code);
export const usesMath = (value: unknown) => uses(value, KINDS.math);

export async function prepareStepAssets(value: unknown): Promise<void> {
  await Promise.all([usesCode(value) ? loadHighlighter() : null, usesMath(value) ? loadTypesetter() : null]);
}
