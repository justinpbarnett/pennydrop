import { boxDrawable, clamp01, type Drawable, fail, integerArg, type LabDef, type LabOp, lerp, type Point, type Rect, type Role, stringField, textDrawable } from "../lab";
import { inkBelow, textWidth } from "../text-metrics";

interface Syllable {
  text: string;
  letters: string[];
}

interface WordsState {
  objectId: string;
  reading: boolean;
  syllables: Syllable[];
  meanings: string[][];
  answer: number | null;
  stressed: number | null;
  spelled: boolean;
  matched: number | null;
  missed: number[];
}

interface WordsSpec {
  word?: unknown;
  meanings?: unknown;
  answer?: unknown;
  reading?: unknown;
}

interface Column {
  center: number;
  width: number;
  firstLetter: number;
}

interface WordLayout {
  wordSize: number;
  wordCenter: number;
  baseHeight: number;
  trackY: number;
  tileTop: number;
  tileSize: number;
  columns: Column[];
}

const WIDTH = 1400;
const CARD_PADDING = 48;
const ROW_ROOM = WIDTH - CARD_PADDING * 2;
const WORD_CARD_HEIGHT = 480;
const WORD_MAX_SIZE = 240;
const WORD_MIN_SIZE = 60;
const WORD_SIZE_STEP = 2;
const SYLLABLE_GAP = 72;
const DIVIDER_RADIUS = 12;
const X_HEIGHT_SHARE = 0.5;
const ASCENDER_SHARE = 0.38;
const WORD_TRACK_GAP = 48;
const TRACK_HEIGHT = 8;
const TRACK_TILE_GAP = 40;
const TILE_MAX = 132;
const TILE_MIN = 52;
const TILE_GAP = 16;
const TILE_LETTER_SHARE = 0.56;
const MAX_LETTERS = 14;
const MAX_SYLLABLES = 6;
const BEAT_RADIUS = 52;

const MEANING_GAP = 104;
const MEANING_TOP = WORD_CARD_HEIGHT + MEANING_GAP;
const MEANING_VPAD = 48;
const MEANING_PADDING = 24;
const MEANING_SPACING = 40;
const MEANING_SIZE = 30;
const MEANING_LINE_PITCH = 44;
const MAX_MEANINGS = 4;
const MAX_MEANING_LINES = 2;
const MEANING_HEIGHT = MAX_MEANING_LINES * MEANING_LINE_PITCH + MEANING_VPAD * 2;
const MEANING_MIDDLE = MEANING_TOP + MEANING_HEIGHT / 2;

const ARROW_START_GAP = 16;
const ARROW_END_GAP = 20;
const MATCH_STROKE = 3;
const FOCUS_STROKE = 4;
const ARROW_WIDTH = 6;
const THICKEST_STROKE_SCALE = 2.4;
const VERDICT_SIZE = 28;
const VERDICT_GAP = 16;
const VERDICT_ROOM = VERDICT_SIZE + VERDICT_GAP;
const VERDICT_STROKE = 6;
const ARROW_MIN_DRAW = 0.4;
const CALM_STROKE = 1.5;
const SLOT_STROKE = 2.5;

const SAY_LEAD = 0.3;
const SAY_PER_SYLLABLE = 0.4;
const SPELL_LEAD = 0.3;
const SPELL_PER_LETTER = 0.32;

type Verdict = "ok" | "fault";

const VERDICT_STROKES: Record<Verdict, [Point, Point][]> = {
  ok: [
    [
      { x: 0, y: 0.55 },
      { x: 0.38, y: 0.9 },
    ],
    [
      { x: 0.38, y: 0.9 },
      { x: 1, y: 0.1 },
    ],
  ],
  fault: [
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  ],
};

function readSyllables(spec: WordsSpec, objectId: string): Syllable[] {
  const word = stringField(spec as Record<string, unknown>, "word", objectId);
  if (/\s/.test(word)) fail(`${objectId}: "word" must be one word with no spaces, got "${word}"; use one words Lab per word`);
  const parts = word.split("-");
  if (parts.some((part) => part === "")) fail(`${objectId}: "word" "${word}" has an empty syllable; put one hyphen between syllables, as in "ba-na-na"`);
  if (parts.length > MAX_SYLLABLES) fail(`${objectId}: "word" has ${parts.length} syllables, at most ${MAX_SYLLABLES} fit; pick a shorter word, and show a longer phrase one word at a time, bringing in each word as the narration says it`);
  const syllables = parts.map((text) => ({ text, letters: [...text] }));
  const letterCount = syllables.reduce((sum, syllable) => sum + syllable.letters.length, 0);
  if (letterCount > MAX_LETTERS) fail(`${objectId}: "word" has ${letterCount} letters, at most ${MAX_LETTERS} fit; pick a shorter word, and show a longer phrase one word at a time, bringing in each word as the narration says it`);
  return syllables;
}

function meaningWidth(count: number): number {
  return (WIDTH - (count - 1) * MEANING_SPACING) / count;
}

function meaningRoom(count: number): number {
  return meaningWidth(count) - MEANING_PADDING * 2 - VERDICT_ROOM;
}

function wrapMeaning(text: string, room: number, where: string): string[] {
  const lines = text
    .split(/\s+/)
    .filter(Boolean)
    .reduce<string[]>((done, word) => {
      const last = done[done.length - 1];
      const joined = last === undefined ? word : `${last} ${word}`;
      if (last !== undefined && textWidth(joined, MEANING_SIZE, "read") <= room) return [...done.slice(0, -1), joined];
      return [...done, word];
    }, []);
  const tooWide = lines.some((line) => textWidth(line, MEANING_SIZE, "read") > room);
  if (lines.length === 0 || lines.length > MAX_MEANING_LINES || tooWide) fail(`${where} is too long for its card; keep it to a few short words`);
  return lines;
}

function readReading(spec: WordsSpec, objectId: string): boolean {
  if (spec.reading !== undefined && typeof spec.reading !== "boolean") fail(`${objectId}: "reading" must be true or false`);
  return spec.reading !== false;
}

function readMeanings(spec: WordsSpec, reading: boolean, objectId: string): string[][] {
  const raw = spec.meanings;
  if (raw === undefined) return [];
  if (!reading) fail(`${objectId}: meaning cards need reading, and this Lesson is for a child who cannot read; drop "meanings" and "answer", and show each meaning as a picture Lab beside the word, joined to it with connect`);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MEANINGS)
    fail(`${objectId}: "meanings" must be a list of 1 to ${MAX_MEANINGS} texts, such as ["a long yellow fruit", "a red fruit"]`);
  return raw.map((meaning, index) => {
    const where = `${objectId}: meanings[${index}]`;
    if (typeof meaning !== "string") fail(`${where} must be text`);
    return wrapMeaning(meaning, meaningRoom(raw.length), where);
  });
}

function readAnswer(spec: WordsSpec, meanings: string[][], objectId: string): number | null {
  if (meanings.length === 0) {
    if (spec.answer !== undefined) fail(`${objectId}: "answer" needs "meanings" to point into; add "meanings" or drop "answer"`);
    return null;
  }
  const answer = spec.answer;
  if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= meanings.length) {
    fail(`${objectId}: "answer" must be the index of the right meaning, from 0 to ${meanings.length - 1}`);
  }
  return answer;
}

function letterCount(state: WordsState): number {
  return state.syllables.reduce((sum, syllable) => sum + syllable.letters.length, 0);
}

function plainMarkWidth(state: WordsState, syllable: Syllable, size: number): number {
  return state.reading ? textWidth(syllable.text, size, "read") : (size / WORD_MAX_SIZE) * BEAT_RADIUS * 2;
}

function markWidth(state: WordsState, index: number, wordSize: number): number {
  return plainMarkWidth(state, state.syllables[index]!, wordSize);
}

function groupWidth(syllable: Syllable, tileSize: number): number {
  return syllable.letters.length * (tileSize + TILE_GAP) - TILE_GAP;
}

function tileSizeFor(state: WordsState, wordSize: number): number {
  const fits = state.syllables.map((syllable) => {
    const room = plainMarkWidth(state, syllable, wordSize) - (syllable.letters.length - 1) * TILE_GAP;
    return room / syllable.letters.length;
  });
  return Math.max(TILE_MIN, Math.min(TILE_MAX, ...fits));
}

function columnWidths(state: WordsState, wordSize: number): number[] {
  const tileSize = tileSizeFor(state, wordSize);
  return state.syllables.map((syllable, index) => Math.max(markWidth(state, index, wordSize), groupWidth(syllable, tileSize)));
}

function rowWidth(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * SYLLABLE_GAP;
}

function fittedWordSize(state: WordsState): number {
  let size = WORD_MAX_SIZE;
  while (size > WORD_MIN_SIZE && rowWidth(columnWidths(state, size)) > ROW_ROOM) size -= WORD_SIZE_STEP;
  return size;
}

function baseHeightFor(state: WordsState, wordSize: number): number {
  return state.reading ? wordSize : (wordSize / WORD_MAX_SIZE) * BEAT_RADIUS * 2;
}

function inkAboveCenter(state: WordsState, wordSize: number): number {
  return state.reading ? wordSize * ASCENDER_SHARE : baseHeightFor(state, wordSize) / 2;
}

function inkBelowCenter(state: WordsState, wordSize: number): number {
  if (!state.reading) return baseHeightFor(state, wordSize) / 2;
  return Math.max(...state.syllables.map((syllable) => inkBelow(syllable.text, wordSize, "read")));
}

function layout(state: WordsState): WordLayout {
  const wordSize = fittedWordSize(state);
  const tileSize = tileSizeFor(state, wordSize);
  const widths = columnWidths(state, wordSize);
  const baseHeight = baseHeightFor(state, wordSize);
  const above = inkAboveCenter(state, wordSize);
  const below = inkBelowCenter(state, wordSize);
  const blockHeight = above + below + WORD_TRACK_GAP + TRACK_HEIGHT + TRACK_TILE_GAP + tileSize;
  const wordCenter = (WORD_CARD_HEIGHT - blockHeight) / 2 + above;
  const trackY = wordCenter + below + WORD_TRACK_GAP + TRACK_HEIGHT / 2;
  let x = (WIDTH - rowWidth(widths)) / 2;
  let firstLetter = 0;
  const columns = state.syllables.map((syllable, index) => {
    const column = { center: x + widths[index]! / 2, width: widths[index]!, firstLetter };
    x += widths[index]! + SYLLABLE_GAP;
    firstLetter += syllable.letters.length;
    return column;
  });
  return {
    wordSize,
    wordCenter,
    baseHeight,
    trackY,
    tileTop: trackY + TRACK_HEIGHT / 2 + TRACK_TILE_GAP,
    tileSize,
    columns,
  };
}

function feedbackRole(state: WordsState): Role | null {
  if (state.matched === null) return null;
  return state.matched === state.answer ? "ok" : "fault";
}

function insetRect(rect: Rect, inset: number): Rect {
  return { x: rect.x + inset, y: rect.y + inset, w: rect.w - inset * 2, h: rect.h - inset * 2 };
}

function outlinedCard(id: string, rect: Rect, fill: Role, outline: Role | null, calm: Role, z: number, outlineWidth = MATCH_STROKE): Drawable {
  const strokeWidth = outline ? outlineWidth : CALM_STROKE;
  return boxDrawable(id, insetRect(rect, (strokeWidth * THICKEST_STROKE_SCALE) / 2), {
    fill,
    stroke: outline ?? calm,
    strokeWidth,
    radius: 1,
    z,
  });
}

function wordCard(): Drawable {
  return outlinedCard("word-card", { x: 0, y: 0, w: WIDTH, h: WORD_CARD_HEIGHT }, "fill", null, "rule", 0);
}

function beatDrawable(state: WordsState, index: number, role: Role): Drawable {
  const { columns, wordCenter, baseHeight } = layout(state);
  const radius = baseHeight / 2;
  return {
    id: `syllable-${index}`,
    kind: "circle",
    x: columns[index]!.center,
    y: wordCenter,
    r: radius,
    fill: role === "ink" ? "muted" : role,
    stroke: "none",
    z: 2,
  };
}

function restingRole(state: WordsState, index: number): Role {
  return state.stressed === index ? "active" : "ink";
}

function syllableDrawable(state: WordsState, index: number, role = restingRole(state, index)): Drawable {
  if (!state.reading) return beatDrawable(state, index, role);
  const { wordSize, columns, wordCenter } = layout(state);
  return textDrawable(
    `syllable-${index}`,
    state.syllables[index]!.text,
    { x: columns[index]!.center, y: wordCenter },
    {
      size: wordSize,
      fill: role,
      z: 2,
    },
  );
}

function dividerY(state: WordsState): number {
  const { wordSize, wordCenter } = layout(state);
  if (!state.reading) return wordCenter;
  const baseline = wordCenter + inkBelow("n", wordSize, "read");
  return baseline - (wordSize * X_HEIGHT_SHARE) / 2;
}

function dividerDrawables(state: WordsState): Drawable[] {
  const { columns } = layout(state);
  const y = dividerY(state);
  return columns.slice(1).map((column, index) => {
    const previous = columns[index]!;
    const x = (previous.center + previous.width / 2 + column.center - column.width / 2) / 2;
    return { id: `divider-${index}`, kind: "circle", x, y, r: DIVIDER_RADIUS, fill: "ink", stroke: "none", z: 2 };
  });
}

function trackRect(trackY: number, left: number, width: number): Rect {
  return { x: left, y: trackY - TRACK_HEIGHT / 2, w: width, h: TRACK_HEIGHT };
}

function spokenRect(state: WordsState, index: number): Rect {
  const { columns, trackY, tileSize } = layout(state);
  const width = groupWidth(state.syllables[index]!, tileSize);
  return trackRect(trackY, columns[index]!.center - width / 2, width);
}

function trackDrawables(state: WordsState): Drawable[] {
  return state.syllables.map((_, index) => boxDrawable(`say-track-${index}`, spokenRect(state, index), { fill: "muted", stroke: "none", z: 1 }));
}

function tileRect(state: WordsState, syllable: number, letter: number): Rect {
  const { tileSize, tileTop, columns } = layout(state);
  const group = groupWidth(state.syllables[syllable]!, tileSize);
  const x = columns[syllable]!.center - group / 2 + letter * (tileSize + TILE_GAP);
  return { x, y: tileTop, w: tileSize, h: tileSize };
}

function tileDrawables(state: WordsState, shown: (index: number) => number, newest: number | null): Drawable[] {
  const { tileSize, columns } = layout(state);
  return state.syllables.flatMap((syllable, syllableIndex) =>
    syllable.letters.flatMap((letter, letterIndex): Drawable[] => {
      const index = columns[syllableIndex]!.firstLetter + letterIndex;
      const rect = tileRect(state, syllableIndex, letterIndex);
      const reveal = shown(index);
      const focused = index === newest;
      const tile = outlinedCard(`tile-${index}`, rect, reveal > 0 ? "fill2" : "fill", focused ? "active" : "muted", "muted", 1, focused ? FOCUS_STROKE : SLOT_STROKE);
      if (!state.spelled || !state.reading) return [tile];
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const size = tileSize * TILE_LETTER_SHARE;
      return [tile, textDrawable(`letter-${index}`, letter, center, { size, fill: "ink", opacity: reveal > 0 ? 1 : 0, z: 2 })];
    }),
  );
}

function labelWidth(state: WordsState, index: number): number {
  return Math.max(...state.meanings[index]!.map((line) => textWidth(line, MEANING_SIZE, "read")));
}

function meaningRect(state: WordsState, index: number): Rect {
  const width = meaningWidth(state.meanings.length);
  return { x: index * (width + MEANING_SPACING), y: MEANING_TOP, w: width, h: MEANING_HEIGHT };
}

function verdictGroupWidth(state: WordsState, index: number): number {
  return VERDICT_ROOM + labelWidth(state, index);
}

function labelCenterX(state: WordsState, index: number, settle: number): number {
  const rect = meaningRect(state, index);
  return rect.x + rect.w / 2 + (settle * VERDICT_ROOM) / 2;
}

function verdictLeft(state: WordsState, index: number): number {
  const rect = meaningRect(state, index);
  return rect.x + (rect.w - verdictGroupWidth(state, index)) / 2;
}

function verdictOf(state: WordsState, index: number): Verdict | null {
  if (state.missed.includes(index)) return "fault";
  return index === state.matched && index === state.answer ? "ok" : null;
}

function verdictMark(state: WordsState, index: number, verdict: Verdict, settle: number): Drawable[] {
  const left = verdictLeft(state, index);
  const top = MEANING_MIDDLE - VERDICT_SIZE / 2;
  return VERDICT_STROKES[verdict].map(([from, to], stroke) => ({
    id: `meaning-${index}-${verdict}-${stroke}`,
    kind: "line",
    x: left + from.x * VERDICT_SIZE,
    y: top + from.y * VERDICT_SIZE,
    x2: left + to.x * VERDICT_SIZE,
    y2: top + to.y * VERDICT_SIZE,
    stroke: verdict,
    strokeWidth: VERDICT_STROKE,
    opacity: settle,
    z: 2,
  }));
}

function meaningCard(state: WordsState, index: number): Drawable {
  return outlinedCard(`meaning-${index}`, meaningRect(state, index), "fill", verdictOf(state, index), "rule", 0);
}

function meaningLabel(state: WordsState, index: number, settle: number): Drawable[] {
  const centerX = labelCenterX(state, index, settle);
  const middle = MEANING_MIDDLE;
  const lines = state.meanings[index]!;
  const top = middle - (lines.length * MEANING_LINE_PITCH) / 2;
  return lines.map((line, lineIndex) => textDrawable(`meaning-${index}-line-${lineIndex}`, line, { x: centerX, y: top + (lineIndex + 0.5) * MEANING_LINE_PITCH }, { size: MEANING_SIZE, z: 1 }));
}

function meaningContent(state: WordsState, index: number, settle: number): Drawable[] {
  const verdict = verdictOf(state, index);
  const shown = verdict ? settle : 0;
  const marks = verdict ? verdictMark(state, index, verdict, shown) : [];
  return [meaningCard(state, index), ...meaningLabel(state, index, shown), ...marks];
}

function meaningDrawables(state: WordsState): Drawable[] {
  return state.meanings.flatMap((_, index) => meaningContent(state, index, 1));
}

function matchArrow(state: WordsState, shown: number): Drawable[] {
  const role = feedbackRole(state);
  if (state.matched === null || role === null) return [];
  const target = meaningRect(state, state.matched);
  return [
    {
      id: `match-arrow-${state.matched}`,
      kind: "arrow",
      x: target.x + target.w / 2,
      y: WORD_CARD_HEIGHT + ARROW_START_GAP,
      x2: target.x + target.w / 2,
      y2: target.y - ARROW_END_GAP,
      stroke: role,
      strokeWidth: ARROW_WIDTH,
      draw: lerp(ARROW_MIN_DRAW, 1, shown),
      z: 3,
    },
  ];
}

function syllableArg(state: WordsState, op: LabOp): number {
  return integerArg(op.args, "syllable", op.name, 0, state.syllables.length - 1);
}

function meaningArg(state: WordsState, op: LabOp): number {
  if (state.meanings.length === 0) fail(`op "match": ${state.objectId} has no meaning cards; add "meanings": ["...", "..."] and "answer" to its spec`);
  return integerArg(op.args, "meaning", op.name, 0, state.meanings.length - 1);
}

function matchApply(state: WordsState, op: LabOp): WordsState {
  const meaning = meaningArg(state, op);
  const missed = meaning === state.answer || state.missed.includes(meaning) ? state.missed : [...state.missed, meaning];
  return { ...state, matched: meaning, missed };
}

function saySeconds(_op: LabOp, state: WordsState): number {
  return SAY_LEAD + SAY_PER_SYLLABLE * state.syllables.length;
}

function spellSeconds(_op: LabOp, state: WordsState): number {
  return SPELL_LEAD + SPELL_PER_LETTER * letterCount(state);
}

function sayFrame(_before: WordsState, after: WordsState, _op: LabOp, progress: number): Drawable[] {
  const count = after.syllables.length;
  const spoken = Math.min(count - 1, Math.floor(progress * count));
  const syllables = after.syllables.map((_, index) => syllableDrawable(after, index));
  return [...syllables, boxDrawable("say-bar", spokenRect(after, spoken), { fill: "accent", stroke: "none", z: 2 })];
}

function spellFrame(_before: WordsState, after: WordsState, _op: LabOp, progress: number): Drawable[] {
  const count = letterCount(after);
  const reached = progress * count;
  const newest = progress < 1 ? Math.min(count - 1, Math.floor(reached)) : null;
  return tileDrawables(after, (index) => clamp01(reached - index), newest);
}

function matchFrame(before: WordsState, after: WordsState, _op: LabOp, progress: number): Drawable[] {
  const matched = after.matched!;
  const settled = verdictOf(before, matched) === verdictOf(after, matched);
  return [...matchArrow(after, progress), ...meaningContent(after, matched, settled ? 1 : progress)];
}

export const lab: LabDef<WordsSpec, WordsState> = {
  id: "words",
  title: "Word cards",
  reading: "optional",
  catalog: {
    summary:
      "A word card for languages and reading: one word in large type split into syllables, a track that lights as the word is spoken, a stressed syllable marked in its own color, letter tiles that spell it out, and optional meaning cards to match it with. Only a language whose words carry a stressed syllable, such as English, Spanish or Italian, has one to mark; Japanese, Chinese and French words have none, so a Lesson on them teaches the beats, sounds and meaning and claims no stress. To pair the word with a picture instead, place a picture Lab beside it and use connect.",
    spec: {
      word: 'the word, with a hyphen between syllables, such as "ba-na-na" (shown as banana with a dot between syllables); one word, at most 6 syllables and 14 letters; a phrase is one words Lab per word, kept side by side with "at": {"row": [...]}, each brought in as the narration says it, so an earlier word stays on stage beside the one that joins it',
      meanings: 'optional list of 1 to 4 short meanings shown as cards under the word, such as ["a long yellow fruit", "a small red fruit"]; a few words each; they are what this word means on its own, so a word that only changes a phrase, such as a polite ending, has meanings like "a polite ending", never the meaning of the whole phrase',
      answer: "index from 0 of the right meaning; required when meanings is given",
      reading:
        "optional, default true; false draws no letters or words, for a child who cannot read: each syllable is a round beat (the stressed one in the active color), spell lights one blank tile per letter, and meaning cards are refused, so pair the word with pictures instead",
    },
    example: [
      '{"step":1,"say":"This word is banana. Say it with me: ba, NA, na. The middle part is the loud one.","scene":{"w":{"lab":"words","word":"ba-na-na","meanings":["a long yellow fruit","a small red fruit"],"answer":0}},"do":[{"cue":"Say it","op":"say","on":["w"]},{"cue":"loud one","op":"stress","on":["w"],"syllable":1}]}',
      '{"step":2,"say":"Spell it out, letter by letter. A banana is a long yellow fruit.","do":[{"cue":"Spell it","op":"spell","on":["w"]},{"cue":"long yellow fruit","op":"match","on":["w"],"meaning":0}]}',
    ],
  },

  init(spec, objectId) {
    const reading = readReading(spec, objectId);
    const meanings = readMeanings(spec, reading, objectId);
    return {
      objectId,
      reading,
      syllables: readSyllables(spec, objectId),
      meanings,
      answer: readAnswer(spec, meanings, objectId),
      stressed: null,
      spelled: false,
      matched: null,
      missed: [],
    };
  },

  ops: {
    say: {
      doc: "no args; the word is spoken: a bar in the accent color runs along the track under it, one syllable at a time; the syllables keep their colors, so a stressed one stays marked while it is said, always at the same size",
      seconds: saySeconds,
      apply: (state) => state,
      during: sayFrame,
    },
    stress: {
      doc: '{"syllable": 1}; index from 0 of the stressed syllable; it turns the active color and keeps the same size as the others, replacing an earlier stress; only for a language whose words carry a stressed syllable, such as English, Spanish or Italian, never for Japanese, Chinese or French, whose words have none, so their narration claims no stress either',
      seconds: 0.7,
      apply: (state, op) => ({ ...state, stressed: syllableArg(state, op) }),
    },
    match: {
      doc: '{"meaning": 0}; index from 0 of a meaning card; an arrow runs from the word to that card, and both outlines turn ok with a check mark if it is the answer, or fault with a cross if not, drawn beside the label with the pair centered in the card; a later match moves the arrow, and a wrong card keeps its cross',
      seconds: 0.9,
      apply: matchApply,
      during: matchFrame,
    },
    spell: {
      doc: "no args; the letters appear one by one in the tiles under each syllable and stay",
      seconds: spellSeconds,
      apply: (state) => ({ ...state, spelled: true }),
      during: spellFrame,
    },
  },

  size(state) {
    return { w: WIDTH, h: state.meanings.length > 0 ? MEANING_TOP + MEANING_HEIGHT : WORD_CARD_HEIGHT };
  },

  draw(state) {
    return [
      wordCard(),
      ...state.syllables.map((_, index) => syllableDrawable(state, index)),
      ...dividerDrawables(state),
      ...trackDrawables(state),
      ...tileDrawables(state, () => (state.spelled ? 1 : 0), null),
      ...meaningDrawables(state),
      ...matchArrow(state, 1),
    ];
  },
};
