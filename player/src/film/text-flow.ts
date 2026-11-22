import type { FontRole } from "../lab";
import { textWidth } from "../text-metrics";

const BALANCE_STEPS = 20;

function greedyLines(words: string[], size: number, font: FontRole, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && textWidth(candidate, size, font) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function wrapText(text: string, size: number, font: FontRole, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const count = greedyLines(words, size, font, maxWidth).length;
  let narrow = 0;
  let wide = maxWidth;
  for (let step = 0; step < BALANCE_STEPS; step += 1) {
    const middle = (narrow + wide) / 2;
    if (greedyLines(words, size, font, middle).length > count) narrow = middle;
    else wide = middle;
  }
  return greedyLines(words, size, font, wide);
}

export function groupDigits(value: number, decimals: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
