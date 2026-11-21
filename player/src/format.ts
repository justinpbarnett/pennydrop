import { fail } from "./lab";
import type { SceneState } from "./scene";

export interface Voice {
  url: string;
  duration: number;
  words: { word: string; start: number; end: number }[];
}

export type Relation =
  | "center" | "top" | "bottom" | "left" | "right"
  | { below: string } | { above: string } | { "left of": string } | { "right of": string } | { "next to": string }
  | { row: string[] } | { column: string[] } | { grid: string[] } | { ring: string[] } | { timeline: string[] }
  | { tree: Record<string, string[]> };

export interface ObjectSpec {
  lab?: string;
  kind?: string;
  at?: Relation;
  [field: string]: unknown;
}

export interface StepOp {
  cue?: string;
  op: string;
  on?: string[];
  [arg: string]: unknown;
}

export type Challenge =
  | { kind: "predict"; type: "number"; prompt?: string; answer: number }
  | { kind: "predict"; type: "choice"; prompt?: string; choices: string[]; answer: string }
  | { kind: "predict"; type: "click"; prompt?: string; answer: string | string[] }
  | { kind: "predict"; type: "order"; prompt?: string; choices: string[]; answer: string[] }
  | { kind: "predict"; type: "match"; prompt?: string; pairs: [string, string][]; answer?: [string, string][] };

export interface Step {
  step: number;
  say: string;
  scene?: Record<string, ObjectSpec | null>;
  do?: StepOp[];
  challenge?: Challenge;
  voice?: Voice;
}

export interface LessonHeader {
  title: string;
  goal?: string;
  labs?: string[];
  reading?: boolean;
  start_scene?: SceneState;
}

export interface LessonSource {
  id: string;
  lesson: LessonHeader;
  steps: Step[];
  done: boolean;
}

export function parseJsonl(id: string, text: string): LessonSource {
  let lesson: LessonHeader | null = null;
  const steps: Step[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: { lesson?: LessonHeader } & Partial<Step>;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      fail(`lesson ${id} line ${index + 1} is not valid JSON: ${(error as Error).message}`);
    }
    if (parsed.lesson) lesson = parsed.lesson;
    else steps.push(parsed as Step);
  });
  if (!lesson) fail(`lesson ${id} has no {"lesson": ...} header line`);
  return { id, lesson, steps, done: true };
}

export function relationTargets(at: Relation | undefined): string[] {
  if (!at || typeof at === "string") return [];
  if ("tree" in at) return Object.entries(at.tree).flatMap(([parent, children]) => [parent, ...children]);
  const [value] = Object.values(at);
  return Array.isArray(value) ? value : [value as string];
}

export const SCENE_RULES = [
  'A Step\'s "scene" entry for an id that already exists replaces that object: the old one fades out and the new one fades in, with no motion between them; use the "morph" verb when the object should change shape in place.',
];

export const DO_RULES = [
  'Each "do" entry may carry a "cue": a word or phrase from "say" that fires it when spoken. Cues must appear in the narration, in order.',
  "Entries that share one cue start together.",
  "An entry with no cue starts when the previous entry ends. The first entry with no cue starts with the Step.",
  "A run of cue-less entries that would outlast the narration is sped up evenly to end with it, down to 0.12 seconds each, and then the Step grows.",
];
