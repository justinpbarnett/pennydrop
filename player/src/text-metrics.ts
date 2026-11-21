import type { FontRole } from "./lab";
import metrics from "./font-metrics.json";
import { THEMES, type ThemeFont } from "./theme";

const advancesByFont = metrics as Record<string, Record<string, number>>;

function familyName(font: ThemeFont): string {
  return font.family.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
}

function advancesFor(font: ThemeFont): Record<string, number> {
  const available = Object.keys(advancesByFont).filter((key) => key.startsWith(`${familyName(font)}|`));
  const nearest = available.sort((a, b) => Math.abs(Number(a.split("|")[1]) - font.weight) - Math.abs(Number(b.split("|")[1]) - font.weight))[0];
  return nearest ? advancesByFont[nearest]! : {};
}

function measure(text: string, size: number, font: ThemeFont): number {
  const advances = advancesFor(font);
  const known = Object.values(advances);
  const fallback = known.length ? known.reduce((sum, advance) => sum + advance, 0) / known.length : 0.58;
  return [...text].reduce((total, character) => total + ((advances[character] ?? fallback) + font.tracking) * size, 0);
}

export function textWidth(text: string, size: number, role: FontRole): number {
  return Math.max(...Object.values(THEMES).map((theme) => measure(text, size, theme.fonts[role])));
}
