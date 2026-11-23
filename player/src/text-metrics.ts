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

function themesFor(theme: Theme | undefined): readonly Theme[] {
  return theme ? [theme] : shownIn;
}

export function textWidth(text: string, size: number, role: FontRole, theme?: Theme): number {
  return Math.max(...themesFor(theme).map((shown) => measure(shownText({ text, font: role }, shown)!, size, shown.fonts[role])));
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

export type TextAnchor = "start" | "middle" | "end";

export interface InkBox {
  left: number;
  right: number;
  above: number;
  below: number;
}

function anchorOffset(width: number, anchor: TextAnchor): number {
  return anchor === "start" ? 0 : anchor === "end" ? width : width / 2;
}

export function inkBox(text: string, size: number, role: FontRole, anchor: TextAnchor, theme?: Theme): InkBox {
  const inks = themesFor(theme).map((shown) => textInk(shownText({ text, font: role }, shown)!, size, shown.fonts[role]));
  return {
    left: Math.min(...inks.map((ink) => ink.left - anchorOffset(ink.width, anchor))),
    right: Math.max(...inks.map((ink) => ink.right - anchorOffset(ink.width, anchor))),
    above: Math.max(...inks.map((ink) => ink.above)),
    below: Math.max(...inks.map((ink) => ink.below)),
  };
}

export function wordCuts(text: string, size: number, role: FontRole, anchor: TextAnchor, theme?: Theme): number[] {
  const words = text.split(" ");
  return words.slice(0, -1).map((_, index) => {
    const said = words.slice(0, index + 1).join(" ");
    const edges = themesFor(theme).map((shown) => {
      const ink = (part: string) => textInk(shownText({ text: part, font: role }, shown)!, size, shown.fonts[role]);
      const origin = anchorOffset(ink(text).width, anchor);
      return { right: ink(said).right - origin, left: ink(`${said} `).width + ink(words[index + 1]!).left - origin };
    });
    return (Math.max(...edges.map((edge) => edge.right)) + Math.min(...edges.map((edge) => edge.left))) / 2;
  });
}

export function inkBelow(text: string, size: number, role: FontRole, theme?: Theme): number {
  return inkBox(text, size, role, "middle", theme).below;
}
