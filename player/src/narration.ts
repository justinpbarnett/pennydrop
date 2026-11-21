import type { Voice } from "./format";

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface Narration {
  words: WordTiming[];
  duration: number;
}

const SECONDS_PER_WORD = 0.38;
const COMMA_PAUSE = 0.18;
const SENTENCE_PAUSE = 0.35;
const LEAD_IN = 0.2;

export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function estimate(tokens: string[]): Narration {
  let clock = LEAD_IN;
  const words = tokens.map((word) => {
    const start = clock;
    clock += SECONDS_PER_WORD;
    const end = clock;
    if (/[,;:]$/.test(word)) clock += COMMA_PAUSE;
    if (/[.?!]$/.test(word)) clock += SENTENCE_PAUSE;
    return { word, start, end };
  });
  return { words, duration: clock };
}

function alignVoice(tokens: string[], voice: Voice): Narration {
  let cursor = 0;
  let previousEnd = 0;
  const words = tokens.map((word) => {
    const wanted = normalizeWord(word);
    const window = voice.words.slice(cursor, cursor + 4);
    const hit = window.findIndex((candidate) => normalizeWord(candidate.word) === wanted);
    if (hit < 0) {
      const start = previousEnd;
      previousEnd = start + SECONDS_PER_WORD;
      return { word, start, end: previousEnd };
    }
    const found = window[hit]!;
    cursor += hit + 1;
    previousEnd = found.end;
    return { word, start: found.start, end: found.end };
  });
  return { words, duration: voice.duration };
}

export function narrate(say: string, voice?: Voice): Narration {
  const tokens = say.split(/\s+/).filter(Boolean);
  return voice ? alignVoice(tokens, voice) : estimate(tokens);
}

export interface CueMatch {
  startWord: number;
  endWord: number;
}

export function findCue(narration: Narration, cue: string, afterWord: number): CueMatch | null {
  const wanted = cue.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (wanted.length === 0) return null;
  const spoken = narration.words.map((timing) => normalizeWord(timing.word));
  for (let start = afterWord; start + wanted.length <= spoken.length; start++) {
    if (wanted.every((word, offset) => spoken[start + offset] === word)) {
      return { startWord: start, endWord: start + wanted.length };
    }
  }
  return null;
}

export function resolveCues(narration: Narration, cues: (string | undefined)[]): (CueMatch | null | undefined)[] {
  let previous: CueMatch | null = null;
  let previousCue = "";
  return cues.map((cue) => {
    if (cue === undefined) return undefined;
    const sameAsPrevious = previous !== null && cue.split(/\s+/).map(normalizeWord).join(" ") === previousCue;
    const searchFrom = previous ? (sameAsPrevious ? previous.startWord : previous.endWord) : 0;
    const match = findCue(narration, cue, searchFrom);
    if (match) {
      previous = match;
      previousCue = cue.split(/\s+/).map(normalizeWord).join(" ");
    }
    return match;
  });
}
