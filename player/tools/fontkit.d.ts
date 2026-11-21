declare module "fontkit" {
  interface Glyph {
    id: number;
    advanceWidth: number;
  }
  interface Font {
    unitsPerEm: number;
    glyphForCodePoint(codePoint: number): Glyph;
  }
  export function openSync(path: string): Font;
}
