import { prepareStepAssets } from "../assets";
import { THEMES } from "../theme";
import { easeFor, type Painted, renderFrame } from "../frame";
import type { Voice } from "../format";
import { type Credit, LabError } from "../lab";
import type { Layout } from "../layout";
import { narrate, resolveCues } from "../narration";
import { applySceneSpecs, definitionOf, EMPTY_SCENE, type SceneState } from "../scene";
import { parseSelector } from "../selector";
import { buildStage, type Stage } from "../stage";
import type { Theme } from "../theme";
import { type Located, Timeline } from "../timeline";
import { cssMatrix, drift, type Follow, type Pose, poseAt, poseFor, project, regionOf, type ScreenRegion, type Shot } from "./camera";
import type { CameraMove, FilmLine, FilmSource } from "./format";
import { type InkBox, InkRecord } from "./inks";
import { centerOf, focusedOn, layoutWorld, type Placement } from "./world";

const DEFAULT_LEAD_SECONDS = 2;
const DEFAULT_TAIL_SECONDS = 3;
const CREDIT_SECONDS = 3;
const CREDIT_FADE_SECONDS = 0.8;
const DEFAULT_MOVE_SECONDS = 3.2;
const FOG_START = 3200;
const FOG_SCALE = 4500;
const BLUR_FREE_RANGE = 600;
const BLUR_PER_UNIT = 1 / 700;
const BLUR_LIMIT = 6;
const ON_CUE_EASE = "power2.out";
const MAX_DASH_SECONDS = 10;
const NUMBER_WORD = /\d|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|double|triple|twice|hundredth|thousandth|percent|first|second|third|fourth|fifth)\b/i;

export class FilmError extends Error {
  override name = "FilmError";
}

export interface CueRecord {
  line: number;
  kind: "do" | "camera" | "sound";
  op: string;
  object: string | null;
  cue: string | null;
  wordStart: number | null;
  opStart: number;
}

export interface Accent {
  time: number;
  tone: string;
  gain: number;
}

export interface Film {
  source: FilmSource;
  lead: number;
  duration: number;
  timeline: Timeline;
  opening: Pose;
  shots: Shot[];
  lineScenes: SceneState[];
  cues: CueRecord[];
  accents: Accent[];
  travels: { time: number; seconds: number }[];
  lineStarts: number[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  inks: InkRecord;
  credits: string[];
  creditsFrom: number;
}

function planeLayout(scene: SceneState): Layout {
  return new Map(
    scene.objects
      .filter((object) => !definitionOf(object).overlay)
      .map((object) => [object.id, { x: 0, y: 0, ...definitionOf(object).size(object.state), scale: 1 }]),
  );
}

const planeStage = (scene: SceneState): Stage => buildStage(scene, planeLayout);

function selectedObject(on: string[] | undefined): string | null {
  const first = on?.[0];
  return first ? parseSelector(first).id : null;
}

const TIMES_SIGN = /(^|\s)x(\s|$)|\b[1-9]\d*x\d/;

function screenTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(screenTexts);
  if (value && typeof value === "object") return Object.values(value).flatMap(screenTexts);
  return [];
}

function wrongTimesSigns(line: FilmLine): string[] {
  return screenTexts([line.scene, line.do?.map(({ cue: _cue, op: _op, on: _on, ...args }) => args)]).filter((text) => TIMES_SIGN.test(text));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inked(placement: Placement, ink: InkBox | undefined): Placement {
  return ink ? { ...placement, x: placement.x + ink.x, y: placement.y + ink.y, w: ink.w, h: ink.h } : placement;
}

function undrawable(line: FilmLine): string[] {
  return (line.do ?? []).filter((op) => op.op === "connect" || (op.spec as { kind?: string } | undefined)?.kind === "edge").map(
    (op) => `line ${line.line}: the op "${op.op}" on ${JSON.stringify(op.on)} draws a connector line, which a Film does not draw; place the two objects side by side along the route and say the link in the narration`,
  );
}

function idleCounters(lineScenes: SceneState[], lineStarts: number[], lineNumbers: number[], cues: CueRecord[]): string[] {
  const counted = new Set<string>();
  const problems: string[] = [];
  cues.filter((cue) => cue.kind === "do" && cue.op === "count" && cue.object).forEach((cue) => {
    if (cue.cue && !NUMBER_WORD.test(cue.cue)) problems.push(`line ${cue.line}: counter "${cue.object}" counts on "${cue.cue}", which is not a number word; cue the count on the word that says the number`);
    if (counted.has(cue.object!)) return;
    counted.add(cue.object!);
    const first = lineScenes.findIndex((scene) => scene.objects.some((object) => object.id === cue.object && definitionOf(object).id === "counter"));
    if (first < 0) return;
    const created = cues.find((other) => other.kind === "do" && other.op === "create" && other.object === cue.object);
    const idle = cue.opStart - (created?.opStart ?? lineStarts[first]!);
    if (idle > MAX_DASH_SECONDS) {
      const where = lineNumbers[first] === cue.line ? `in line ${cue.line}, ${idle.toFixed(0)} s into the line` : `from line ${lineNumbers[first]} to line ${cue.line}`;
      problems.push(`counter "${cue.object}" shows a dash for ${idle.toFixed(0)} s before its number is said (it is added in line ${lineNumbers[first]} and counted ${where}); bring it in with a create op cued just before the number word (the counter then appears as the number is said), or add it in the Scene of a line where the number comes early`);
    }
  });
  return problems;
}

export async function buildFilm(source: FilmSource, inks = new InkRecord()): Promise<Film> {
  const { header, lines } = source;
  const lead = header.lead ?? DEFAULT_LEAD_SECONDS;
  const errors: string[] = [];
  let startScene = EMPTY_SCENE;
  try {
    startScene = applySceneSpecs(EMPTY_SCENE, header.start ?? {});
  } catch (error) {
    errors.push(`header start: ${describe(error)}`);
  }
  await prepareStepAssets(startScene);
  const timeline = new Timeline(startScene, planeStage);
  const lineScenes: SceneState[] = [];
  const cues: CueRecord[] = [];
  const accents: Accent[] = [];
  const travels: Film["travels"] = [];
  const lineStarts: number[] = [];
  const shotRequests: { index: number; time: number; seconds: number; line: FilmLine; move: CameraMove }[] = [];

  for (const [index, line] of lines.entries()) {
    await prepareStepAssets(line.scene);
    errors.push(...undrawable(line));
    const span = timeline.addStep({ step: line.line, say: line.say, scene: line.scene, do: line.do, voice: line.voice as Voice | undefined });
    lineScenes.push(timeline.finalScene);
    lineStarts.push(lead + span.start);
    errors.push(...span.errors.map((message) => `line ${line.line}: ${message}`));
    wrongTimesSigns(line).forEach((text) => errors.push(`line ${line.line}: on-screen text "${text}" uses a letter x as a times sign; write ×`));
    const narration = narrate(line.say, line.voice);
    const wordTime = (cue: string | undefined, match: { startWord: number } | null | undefined): number | null =>
      cue === undefined ? null : match ? lead + span.start + narration.words[match.startWord]!.start : null;

    const doMatches = resolveCues(narration, (line.do ?? []).map((raw) => raw.cue));
    const startsByIndex = new Map(span.opStarts.map((entry) => [entry.index, entry.time]));
    (line.do ?? []).forEach((raw, position) => {
      const start = startsByIndex.get(position);
      if (start === undefined) return;
      cues.push({ line: line.line, kind: "do", op: raw.op, object: selectedObject(raw.on), cue: raw.cue ?? null, wordStart: wordTime(raw.cue, doMatches[position]), opStart: lead + start });
    });

    const moves = line.camera ?? [];
    const moveMatches = resolveCues(narration, moves.map((move) => move.cue));
    moves.forEach((move, position) => {
      const match = moveMatches[position];
      if (move.cue !== undefined && !match) errors.push(`line ${line.line} camera[${position}]: cue "${move.cue}" is not in say; use a word or phrase from the narration, in order`);
      const time = lead + span.start + (match ? narration.words[match.startWord]!.start : 0);
      const seconds = move.seconds ?? DEFAULT_MOVE_SECONDS;
      shotRequests.push({ index, time, seconds, line, move });
      cues.push({ line: line.line, kind: "camera", op: "go", object: move.go, cue: move.cue ?? null, wordStart: wordTime(move.cue, match), opStart: time });
      travels.push({ time, seconds });
    });

    const sounds = line.sound ?? [];
    const soundMatches = resolveCues(narration, sounds.map((sound) => sound.cue));
    sounds.forEach((sound, position) => {
      const match = soundMatches[position];
      if (sound.cue !== undefined && !match) errors.push(`line ${line.line} sound[${position}]: cue "${sound.cue}" is not in say; use a word or phrase from the narration, in order`);
      const time = lead + span.start + (match ? narration.words[match.startWord]!.start : 0);
      accents.push({ time, tone: sound.tone, gain: sound.gain ?? 1 });
      cues.push({ line: line.line, kind: "sound", op: sound.tone, object: null, cue: sound.cue ?? null, wordStart: wordTime(sound.cue, match), opStart: time });
    });
  }
  errors.push(...idleCounters(lineScenes, lineStarts, lines.map((line) => line.line), cues));
  if (errors.length > 0) throw new FilmError(errors.join("\n"));
  const everyScene = [startScene, ...lineScenes];
  const requests = [...shotRequests].sort((a, b) => a.time - b.time);
  const opening = openingPose(source, everyScene, errors, inks, requests[0]?.time ?? Infinity);
  timeline.finish();
  const credits = creditLines(everyScene);
  const tail = Math.max(header.tail ?? DEFAULT_TAIL_SECONDS, credits.length ? CREDIT_SECONDS : 0);
  const duration = lead + timeline.duration + tail;
  const shots: Shot[] = [];
  const settle = THEMES[header.theme];
  requests.forEach(({ move, time, seconds, line }, order) => {
    const settled = timeline.locate(time + seconds - lead, 1, easeFor(settle)).after;
    const scene = [settled, ...everyScene].find((candidate) => layoutWorld(candidate).has(move.go));
    const placed = scene && layoutWorld(scene).get(move.go)!;
    if (!placed) {
      errors.push(`line ${line.line}: the camera goes to "${move.go}", which is not in the Scene`);
      return;
    }
    const placement = inked(placed, inks.between(move.go, time, requests[order + 1]?.time ?? duration));
    shots.push({ start: time, end: time + seconds, to: poseFor(move.focus ? focusedOn(placement, move.focus) : placement, move), subject: move.go, anchor: [placed.x, placed.y, placed.z] });
  });

  if (errors.length > 0) throw new FilmError(errors.join("\n"));

  const placements = everyScene.flatMap((scene) => [...layoutWorld(scene).values()]);
  const bounds = {
    minX: Math.min(...placements.map((p) => p.x)),
    maxX: Math.max(...placements.map((p) => p.x + p.w)),
    minY: Math.min(...placements.map((p) => p.y)),
    maxY: Math.max(...placements.map((p) => p.y + p.h)),
    minZ: Math.min(...placements.map((p) => p.z)),
    maxZ: Math.max(...placements.map((p) => p.z)),
  };
  return {
    source,
    lead,
    duration,
    timeline,
    opening,
    shots,
    lineScenes,
    cues,
    accents,
    travels,
    lineStarts,
    bounds,
    inks,
    credits,
    creditsFrom: duration - tail,
  };
}

const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

function creditLines(scenes: SceneState[]): string[] {
  const merged = new Map<string, { credit: Credit; authors: Set<string> }>();
  for (const object of scenes.flatMap((scene) => scene.objects)) {
    for (const credit of definitionOf(object).credits?.(object.state) ?? []) {
      const key = [credit.what, credit.source, credit.license].join("|");
      const entry = merged.get(key) ?? { credit, authors: new Set<string>() };
      credit.authors.forEach((author) => entry.authors.add(author));
      merged.set(key, entry);
    }
  }
  return [...merged.values()].map(({ credit, authors }) => `${credit.what} by ${listed([...authors].sort())}, ${credit.source}, ${credit.license}`);
}

function openingPose(source: FilmSource, scenes: SceneState[], errors: string[], inks: InkRecord, firstShot: number): Pose {
  const wanted = source.header.opening?.go;
  const placed = scenes.map((scene) => (wanted ? layoutWorld(scene).get(wanted) : [...layoutWorld(scene).values()][0])).find((placement) => placement !== undefined);
  const placement = placed ? inked(placed, inks.between(placed.id, 0, firstShot)) : null;
  if (!placement) {
    errors.push(wanted ? `header opening: the camera goes to "${wanted}", which is not in the Scene` : "the film has no pieces to point the camera at");
    return { px: 0, py: 0, pz: 2000, tx: 0, ty: 0, tz: 0 };
  }
  return poseFor(placement, { view: "wide", ...source.header.opening });
}

export interface PlaneFrame {
  id: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  items: Painted[];
  opacity: number;
  blur: number;
  visible: boolean;
  region: ScreenRegion | null;
  ink: ScreenRegion | null;
}

export interface FilmFrame {
  planes: PlaneFrame[];
  matrix: string;
  pose: Pose;
  time: number;
  credits: { lines: string[]; opacity: number };
}

function objectOf(id: string): string {
  return id.slice(0, id.indexOf("/"));
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function placedBetween(id: string, located: Located): Placement | null {
  const from = layoutWorld(located.before).get(id) ?? layoutWorld(located.after).get(id);
  if (!from) return null;
  const to = layoutWorld(located.after).get(id) ?? from;
  const progress = located.progress.eased;
  return { id, x: mix(from.x, to.x, progress), y: mix(from.y, to.y, progress), z: mix(from.z, to.z, progress), w: Math.max(from.w, to.w), h: Math.max(from.h, to.h) };
}

function nearestPlacement(film: Film, local: number, id: string, located: Located): Placement | null {
  const now = placedBetween(id, located);
  if (now) return now;
  const holds = (scene: SceneState) => scene.objects.some((object) => object.id === id);
  const begun = film.timeline.segments.filter((segment) => segment.start - segment.lead <= local);
  const left = begun.findLast((segment) => holds(segment.before));
  if (left) return layoutWorld(left.before).get(id) ?? null;
  const arriving = film.timeline.segments.find((segment) => segment.start - segment.lead > local && holds(segment.after));
  return arriving ? layoutWorld(arriving.after).get(id) ?? null : null;
}

function locateAt(film: Film, time: number, theme: Theme): Located {
  return film.timeline.locate(time - film.lead, theme.motionScale, easeFor({ ...theme, ease: ON_CUE_EASE }));
}

function subjectFollow(film: Film, theme: Theme, time: number, located: Located): Follow {
  return (shot, at) => {
    const placed = nearestPlacement(film, at - film.lead, shot.subject, at === time ? located : locateAt(film, at, theme));
    return placed ? [placed.x - shot.anchor[0], placed.y - shot.anchor[1], placed.z - shot.anchor[2]] : [0, 0, 0];
  };
}

export function frameAt(film: Film, time: number, theme: Theme): FilmFrame {
  const local = time - film.lead;
  const onCue: Theme = { ...theme, ease: ON_CUE_EASE };
  const located = locateAt(film, time, theme);
  const inner = renderFrame(film.timeline, local, onCue, planeStage);

  const grouped = new Map<string, Painted[]>();
  for (const item of inner.items) {
    const id = objectOf(item.id);
    const list = grouped.get(id);
    if (list) list.push(item);
    else grouped.set(id, [item]);
  }

  const pose = drift(poseAt(film.opening, film.shots, time, easeFor(theme), subjectFollow(film, theme, time, located)), time);
  const focusDepth = project(pose, [pose.tx, pose.ty, pose.tz])?.depth ?? 0;
  const planes: PlaneFrame[] = [...grouped].map(([id, items]) => {
    const placement = placedBetween(id, located);
    if (!placement) throw new FilmError(`something painted for "${id}" has no place in the world at ${time.toFixed(1)} s (items ${items.map((item) => item.id).join(", ")}); it is an overlay or a piece that left the Scene while still drawing`);
    const center = centerOf(placement);
    const screen = project(pose, [center.x, center.y, center.z]);
    const depth = screen?.depth ?? 0;
    const fog = 1 / (1 + (Math.max(0, depth - FOG_START) / FOG_SCALE) ** 2);
    const blur = Math.min(BLUR_LIMIT, Math.max(0, (Math.abs(depth - focusDepth) - BLUR_FREE_RANGE) * BLUR_PER_UNIT));
    return { ...placement, items, opacity: fog, blur, visible: screen !== null, region: regionOf(pose, placement), ink: regionOf(pose, inked(placement, film.inks.at(id, time))) };
  });
  const credits = { lines: film.credits, opacity: Math.min(1, Math.max(0, (time - film.creditsFrom) / CREDIT_FADE_SECONDS)) };
  return { planes, matrix: cssMatrix(pose), pose, time, credits };
}

export function holdEnd(film: Film, shot: number): number {
  return film.shots[shot + 1]?.start ?? film.duration;
}

export function framedRegion(film: Film, shot: number, frame: FilmFrame, plane: PlaneFrame): ScreenRegion | null {
  return regionOf(frame.pose, inked(plane, film.inks.between(plane.id, film.shots[shot]!.start, holdEnd(film, shot))));
}

export function unfilledAt(film: Film, time: number, theme: Theme, id: string): boolean {
  const located = film.timeline.locate(time - film.lead, theme.motionScale, easeFor({ ...theme, ease: ON_CUE_EASE }));
  const unfilled = (scene: SceneState) => {
    const object = scene.objects.find((candidate) => candidate.id === id);
    return object ? definitionOf(object).unfilled?.(object.state) === true : false;
  };
  return unfilled(located.before) && unfilled(located.after) && !located.carried.some((run) => run.touch.objectId === id);
}

export function longestEmpty(film: Film, shot: number, theme: Theme, id: string): number {
  const step = 1 / 4;
  let filled = false;
  let run = 0;
  let longest = 0;
  for (let time = film.shots[shot]!.end; time < holdEnd(film, shot); time += step) {
    const empty = unfilledAt(film, time, theme, id);
    filled ||= !empty;
    run = empty && filled ? run + step : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

export function loadFilmError(error: unknown): Error {
  return error instanceof LabError || error instanceof FilmError ? error : new Error(describe(error));
}
