import { clamp01, type Drawable, type FontRole } from "../lab";
import { inkBox, textWidth, wordCuts } from "../text-metrics";
import type { Theme } from "../theme";

const BALANCE_STEPS = 20;
const SPOKEN_SECONDS_PER_CHARACTER = 0.05;
const WRITING_MARGIN = 12;

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

export function spokenSeconds(lines: string[]): number {
  return lines.join(" ").length * SPOKEN_SECONDS_PER_CHARACTER;
}

export function writtenShares(lines: string[], progress: number): number[] {
  const total = lines.join(" ").length;
  let start = 0;
  return lines.map((line) => {
    const share = clamp01((progress * total - start) / line.length);
    start += line.length + 1;
    return share;
  });
}

export function writtenLine(line: Drawable, share: number, theme: Theme | undefined): Drawable[] {
  if (share <= 0) return [];
  if (share >= 1) return [line];
  const text = line.text!;
  const anchor = line.anchor ?? "middle";
  const ink = inkBox(text, line.size!, line.font!, anchor, theme);
  const cuts = [ink.left - WRITING_MARGIN, ...wordCuts(text, line.size!, line.font!, anchor, theme), ink.right + WRITING_MARGIN];
  const starts = [0];
  for (const word of text.split(" ")) starts.push(starts.at(-1)! + word.length + 1);
  const reached = share * text.length;
  const saying = starts.findIndex((start) => start > reached) - 1;
  const band = (id: string, from: number, to: number, opacity: number): Drawable => ({
    ...line,
    id,
    opacity: (line.opacity ?? 1) * opacity,
    clip: { x: line.x + cuts[from]!, y: line.y - ink.above - WRITING_MARGIN, w: cuts[to]! - cuts[from]!, h: ink.above + ink.below + 2 * WRITING_MARGIN },
  });
  const said = saying > 0 ? [band(line.id, 0, saying, 1)] : [];
  return [...said, band(`${line.id}-word`, saying, saying + 1, (reached - starts[saying]!) / (starts[saying + 1]! - starts[saying]!))];
}
