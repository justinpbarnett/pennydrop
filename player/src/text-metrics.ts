import type { FontRole } from "./lab";
import metrics from "./font-metrics.json";
import inks from "./font-ink.json";
import { shownText, type Theme, THEMES, type ThemeFont } from "./theme";

const advancesByFont = metrics as Record<string, Record<string, number>>;

interface FontInk {
  ascent: number;
  descent: number;
  kerning: Record<string, number>;
  glyphs: Record<string, [advance: number, bottom: number, top: number, left: number, right: number]>;
}

const inkByFont = inks as unknown as Record<string, FontInk>;

let shownIn: readonly Theme[] = Object.values(THEMES);

export function layOutFor(themes: readonly Theme[]): void {
  shownIn = themes;
}

function familyName(font: ThemeFont): string {
  return font.family.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
}

function nearestKey(font: ThemeFont): string | undefined {
  const available = Object.keys(advancesByFont).filter((key) => key.startsWith(`${familyName(font)}|`));
  return available.sort((a, b) => Math.abs(Number(a.split("|")[1]) - font.weight) - Math.abs(Number(b.split("|")[1]) - font.weight))[0];
}

function advancesFor(font: ThemeFont): Record<string, number> {
  const key = nearestKey(font);
  return key ? advancesByFont[key]! : {};
}

function fallbackAdvance(advances: Record<string, number>): number {
  const known = Object.values(advances);
  return known.length ? known.reduce((sum, advance) => sum + advance, 0) / known.length : 0.58;
}

function measure(text: string, size: number, font: ThemeFont): number {
  const advances = advancesFor(font);
  const fallback = fallbackAdvance(advances);
  return [...text].reduce((total, character) => total + ((advances[character] ?? fallback) + font.tracking) * size, 0);
}

export function textWidth(text: string, size: number, role: FontRole): number {
  return Math.max(...shownIn.map((theme) => measure(shownText({ text, font: role }, theme)!, size, theme.fonts[role])));
}

export interface TextInk {
  width: number;
  left: number;
  right: number;
  above: number;
  below: number;
}

export function textInk(text: string, size: number, font: ThemeFont): TextInk {
  const key = nearestKey(font);
  const ink = key ? inkByFont[key] : undefined;
  const characters = [...text];
  const fallback = fallbackAdvance(advancesFor(font));
  const advances = [0];
  characters.forEach((character, at) => advances.push(advances[at]! + ((ink?.glyphs[character]?.[0] ?? fallback) + (ink?.kerning[character + characters[at + 1]] ?? 0) + font.tracking) * size));
  const advanceTo = (index: number) => advances[index]!;
  const width = advanceTo(characters.length);
  const drawn = ink ? characters.filter((character) => ink.glyphs[character] && ink.glyphs[character]![2] > ink.glyphs[character]![1]) : [];
  if (!ink || drawn.length === 0) return { width, left: 0, right: width, above: size / 2, below: size / 2 };
  const glyph = (character: string) => ink.glyphs[character]!;
  const first = characters.findIndex((character) => drawn.includes(character));
  const last = characters.length - 1 - [...characters].reverse().findIndex((character) => drawn.includes(character));
  const baseline = (Math.round(ink.ascent * size) - Math.round(ink.descent * size)) / 2;
  return {
    width,
    left: advanceTo(first) + glyph(characters[first]!)[3] * size,
    right: advanceTo(last) + glyph(characters[last]!)[4] * size,
    above: Math.max(...drawn.map((character) => glyph(character)[2])) * size - baseline,
    below: baseline - Math.min(...drawn.map((character) => glyph(character)[1])) * size,
  };
}

export function inkBelow(text: string, size: number, role: FontRole): number {
  return Math.max(...shownIn.map((theme) => textInk(text, size, theme.fonts[role]).below));
}
