import { fail } from "./lab";
import type { Relation } from "./relation";
import type { SceneSnapshot } from "./scene";

export const lessonTitle = (title: string | null): string => title ?? "a removed Lesson";

export interface Voice {
  url: string;
  duration: number;
  words: { word: string; start: number; end: number }[];
}

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
  | { kind: "predict"; type: "match"; prompt?: string; pairs: [string, string][]; answer?: [string, string][] }
  | { kind: "predict"; type: "yesno"; prompt?: string; answer: "yes" | "no" }
  | { kind: "explain"; type: "words"; prompt?: string };

export type Form = "say" | "applies" | "fresh";

export interface Step {
  step: number;
  say: string;
  scene?: Record<string, ObjectSpec | null>;
  do?: StepOp[];
  challenge?: Challenge;
  voice?: Voice;
  form?: Form;
  direction?: "forward" | "back";
  case_id?: number;
  reveal?: { say: string; do?: StepOp[]; scene?: Record<string, ObjectSpec | null>; voice?: Voice };
}

export function playedSteps(item: Step): Step[] {
  const { reveal, ...asked } = item;
  return reveal ? [asked, { ...reveal, step: item.step, form: item.form }] : [asked];
}

export interface Practice {
  rule_id?: number;
  rule: string;
  condition: string;
  slots: string[];
  items: Step[];
}

export interface LessonHeader {
  title: string;
  point?: string;
  goal?: string;
  labs?: string[];
  reading?: boolean;
  start_scene?: SceneSnapshot;
}

export interface LessonSource {
  id: string;
  lesson: LessonHeader;
  steps: Step[];
  practice?: Practice;
  done: boolean;
}

interface PracticeLine {
  rule: string;
  condition: string;
  slots: string[];
  challenges: Step[];
}

export function parseJsonl(id: string, text: string): LessonSource {
  let lesson: LessonHeader | null = null;
  const held: { practice?: PracticeLine } = {};
  const steps: Step[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: { lesson?: LessonHeader; practice?: PracticeLine } & Partial<Step>;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      fail(`lesson ${id} line ${index + 1} is not valid JSON: ${(error as Error).message}`);
    }
    if (parsed.lesson) lesson = parsed.lesson;
    else if (parsed.practice) held.practice = parsed.practice;
    else steps.push(parsed as Step);
  });
  if (!lesson) fail(`lesson ${id} has no {"lesson": ...} header line`);
  const first = (steps.at(-1)?.step ?? 0) + 1;
  const practice = held.practice;
  const wire = practice && { rule: practice.rule, condition: practice.condition, slots: practice.slots, items: practice.challenges.map((item, index) => ({ ...item, step: first + index })) };
  return { id, lesson, steps, ...(wire && { practice: wire }), done: true };
}

export const SCENE_RULES = [
  'A Step\'s "scene" entry for an id that already exists replaces that object: the old one fades out and the new one fades in, with no motion between them; use the "morph" verb when the object should change shape in place.',
  'A scene spec may carry "caption": a short plain-text name of up to 32 characters, drawn above the object, for when two objects of one Lab share the stage (for example "mixed hand" and "ordered hand"). It needs reading.',
];

export const DO_RULES = [
  'Each "do" entry may carry a "cue": a word or phrase from "say" that fires it when spoken. Cues must appear in the narration, in order.',
  "Entries that share one cue start together.",
  "An entry with no cue starts when the previous entry ends. The first entry with no cue starts with the Step.",
  "A run of cue-less entries that would outlast the narration is sped up evenly to end with it, down to 0.12 seconds each, and then the Step grows.",
  "A simulation op (a catalog op that says it runs in real time, such as a ball released or a swing) is never cut short or sped up. An entry whose cue lands while one runs waits for it to finish, and everything after it moves later.",
];
