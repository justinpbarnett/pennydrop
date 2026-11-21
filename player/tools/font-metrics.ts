import { dirname, resolve } from "node:path";
import { openSync } from "fontkit";

const ROOT = resolve(import.meta.dir, "..");
const FONTS_CSS = resolve(ROOT, "src/fonts.css");
const OUTPUT = resolve(ROOT, "src/font-metrics.json");
const INK_OUTPUT = resolve(ROOT, "src/font-ink.json");
const EXTRA_CHARACTERS = "²³·×÷−–\u2014…≤≥≠≈→←⇒'";

const characters = [...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)), ...EXTRA_CHARACTERS];

function fontFaces(css: string): { family: string; weight: number; file: string }[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].filter(([, body]) => !/font-style:\s*italic/.test(body!)).map(([, body]) => {
    const family = /font-family:\s*"([^"]+)"/.exec(body!)![1]!;
    const weight = Number(/font-weight:\s*(\d+)/.exec(body!)![1]);
    const url = /url\("([^"]+)"\)/.exec(body!)![1]!;
    const file = url.startsWith("/") ? resolve(ROOT, "public", url.slice(1)) : resolve(dirname(FONTS_CSS), url);
    return { family, weight, file };
  });
}

const metrics: Record<string, Record<string, number>> = {};
const inks: Record<string, { ascent: number; descent: number; kerning: Record<string, number>; glyphs: Record<string, [advance: number, bottom: number, top: number, left: number, right: number]> }> = {};
const round = (value: number) => Number(value.toFixed(4));
const escape = (value: unknown) => JSON.stringify(value).replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
for (const { family, weight, file } of fontFaces(await Bun.file(FONTS_CSS).text())) {
  const font = openSync(file);
  const advances: Record<string, number> = {};
  const lineBox = (font as unknown as { hhea: { ascent: number; descent: number } }).hhea;
  const ink = { ascent: round(lineBox.ascent / font.unitsPerEm), descent: round(-lineBox.descent / font.unitsPerEm), kerning: {} as Record<string, number>, glyphs: {} as Record<string, [number, number, number, number, number]> };
  for (const character of characters) {
    const glyph = font.glyphForCodePoint(character.codePointAt(0)!);
    if (glyph.id === 0) continue;
    advances[character] = round(glyph.advanceWidth / font.unitsPerEm);
    const shaped = (font as unknown as { layout(text: string, features: Record<string, boolean>): { glyphs: { advanceWidth: number; bbox: { minX: number; maxX: number; minY: number; maxY: number } }[] } }).layout(character, { lnum: true, tnum: true }).glyphs[0]!;
    const { minX, maxX, minY, maxY } = shaped.bbox;
    ink.glyphs[character] = [round(shaped.advanceWidth / font.unitsPerEm), round(minY / font.unitsPerEm), round(maxY / font.unitsPerEm), round(minX / font.unitsPerEm), round(maxX / font.unitsPerEm)];
  }
  const layoutOf = font as unknown as { layout(text: string, features: Record<string, boolean>): { positions: { xAdvance: number }[] } };
  const advanceOf = (text: string) => layoutOf.layout(text, { lnum: true, tnum: true, liga: false, clig: false }).positions.reduce((total, position) => total + position.xAdvance, 0);
  const alone = Object.fromEntries(Object.keys(ink.glyphs).map((character) => [character, advanceOf(character)]));
  for (const first of Object.keys(ink.glyphs)) for (const second of Object.keys(ink.glyphs)) {
    const adjustment = advanceOf(first + second) - alone[first]! - alone[second]!;
    if (adjustment !== 0) ink.kerning[first + second] = round(adjustment / font.unitsPerEm);
  }
  metrics[`${family}|${weight}`] = advances;
  inks[`${family}|${weight}`] = ink;
}

await Bun.write(OUTPUT, `${escape(metrics)}\n`);
await Bun.write(INK_OUTPUT, `${escape(inks)}\n`);
console.log(`wrote ${Object.keys(metrics).length} fonts to ${OUTPUT} and ${INK_OUTPUT}`);
