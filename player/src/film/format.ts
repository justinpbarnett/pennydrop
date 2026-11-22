import type { ObjectSpec, StepOp, Voice } from "../format";
import { fail } from "../lab";
import { isThemeId, THEME_IDS, type ThemeId } from "../theme";

export const FILM_FPS = 30;
export const CAMERA_VIEWS = ["wide", "fit", "close"] as const;
export type CameraView = (typeof CAMERA_VIEWS)[number];

export interface CameraMove {
  cue?: string;
  go: string;
  view?: CameraView;
  elevation?: number;
  seconds?: number;
  focus?: { x: number; y: number; zoom: number };
}

export interface SoundAccent {
  cue?: string;
  tone: string;
  gain?: number;
}

export interface FilmLine {
  line: number;
  say: string;
  scene?: Record<string, ObjectSpec | null>;
  do?: StepOp[];
  camera?: CameraMove[];
  sound?: SoundAccent[];
  voice?: Voice;
}

export interface FilmHeader {
  title: string;
  theme: ThemeId;
  thread?: string;
  lead?: number;
  tail?: number;
  start?: Record<string, ObjectSpec>;
  opening?: Omit<CameraMove, "cue" | "seconds">;
}

export interface FilmSource {
  header: FilmHeader;
  lines: FilmLine[];
}

export function parseFilm(text: string): FilmSource {
  let header: FilmHeader | null = null;
  const lines: FilmLine[] = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    let parsed: { film?: FilmHeader } & Partial<FilmLine>;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(`film line ${index + 1} is not valid JSON: ${(error as Error).message}`);
    }
    if (parsed.film) header = parsed.film;
    else lines.push(parsed as FilmLine);
  });
  if (!header) fail(`the film has no {"film": ...} header line`);
  const checked: FilmHeader = header;
  if (!checked.title) fail(`the film header needs a "title"`);
  if (!isThemeId(checked.theme)) fail(`the film header "theme" must be one of ${THEME_IDS.join(", ")}`);
  if (lines.length === 0) fail("the film has no lines");
  lines.forEach((line, position) => {
    if (typeof line.line !== "number") fail(`film line ${position + 1} needs a numeric "line"`);
    if (typeof line.say !== "string" || !line.say.trim()) fail(`line ${line.line} needs "say" narration text`);
  });
  return { header: checked, lines };
}
