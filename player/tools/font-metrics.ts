import { dirname, resolve } from "node:path";
import { openSync } from "fontkit";

const ROOT = resolve(import.meta.dir, "..");
const FONTS_CSS = resolve(ROOT, "src/fonts.css");
const OUTPUT = resolve(ROOT, "src/font-metrics.json");
const EXTRA_CHARACTERS = "²³·×÷−–\u2014…≤≥≠≈→←⇒'";

const characters = [...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)), ...EXTRA_CHARACTERS];

function fontFaces(css: string): { family: string; weight: number; file: string }[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
    const family = /font-family:\s*"([^"]+)"/.exec(body!)![1]!;
    const weight = Number(/font-weight:\s*(\d+)/.exec(body!)![1]);
    const url = /url\("([^"]+)"\)/.exec(body!)![1]!;
    const file = url.startsWith("/") ? resolve(ROOT, "public", url.slice(1)) : resolve(dirname(FONTS_CSS), url);
    return { family, weight, file };
  });
}

const metrics: Record<string, Record<string, number>> = {};
for (const { family, weight, file } of fontFaces(await Bun.file(FONTS_CSS).text())) {
  const font = openSync(file);
  const advances: Record<string, number> = {};
  for (const character of characters) {
    const glyph = font.glyphForCodePoint(character.codePointAt(0)!);
    if (glyph.id !== 0) advances[character] = Number((glyph.advanceWidth / font.unitsPerEm).toFixed(4));
  }
  metrics[`${family}|${weight}`] = advances;
}

const escaped = JSON.stringify(metrics).replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
await Bun.write(OUTPUT, `${escaped}\n`);
console.log(`wrote ${Object.keys(metrics).length} fonts to ${OUTPUT}`);
