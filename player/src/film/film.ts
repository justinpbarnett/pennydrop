import { easeFor, type Painted, renderFrame } from "../frame";
import type { Voice } from "../format";
import { LabError } from "../lab";
import type { Layout } from "../layout";
import { narrate, resolveCues } from "../narration";
import { applySceneSpecs, definitionOf, EMPTY_SCENE, type SceneState } from "../scene";
import { parseSelector } from "../selector";
import { buildStage, type Stage } from "../stage";
import type { Theme } from "../theme";
import { Timeline } from "../timeline";
import { cssMatrix, drift, type Pose, poseAt, poseFor, project, regionOf, type ScreenRegion, type Shot } from "./camera";
import type { CameraMove, FilmLine, FilmSource } from "./format";
import { centerOf, focusedOn, layoutWorld, type Placement } from "./world";

const DEFAULT_LEAD_SECONDS = 2;
const DEFAULT_TAIL_SECONDS = 3;
const DEFAULT_MOVE_SECONDS = 3.2;
const FOG_START = 3200;
const FOG_SCALE = 4500;
const BLUR_FREE_RANGE = 600;
const BLUR_PER_UNIT = 1 / 700;
const BLUR_LIMIT = 6;
const ON_CUE_EASE = "power2.out";

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
  inks: InkBoxes;
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

export interface InkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type InkBoxes = Map<string, InkBox>;

function inked(placement: Placement, inks: InkBoxes): Placement {
  const ink = inks.get(placement.id);
  return ink ? { ...placement, x: placement.x + ink.x, y: placement.y + ink.y, w: ink.w, h: ink.h } : placement;
}

function resolvePlacement(scenes: SceneState[], id: string, inks: InkBoxes): Placement | null {
  for (const scene of scenes) {
    const placement = layoutWorld(scene).get(id);
    if (placement) return inked(placement, inks);
  }
  return null;
}

export function buildFilm(source: FilmSource, inks: InkBoxes = new Map()): Film {
  const { header, lines } = source;
  const lead = header.lead ?? DEFAULT_LEAD_SECONDS;
  const errors: string[] = [];
  let startScene = EMPTY_SCENE;
  try {
    startScene = applySceneSpecs(EMPTY_SCENE, header.start ?? {});
  } catch (error) {
    errors.push(`header start: ${describe(error)}`);
  }
  const timeline = new Timeline(startScene, planeStage);
  const lineScenes: SceneState[] = [];
  const cues: CueRecord[] = [];
  const accents: Accent[] = [];
  const travels: Film["travels"] = [];
  const lineStarts: number[] = [];
  const shotRequests: { index: number; time: number; seconds: number; line: FilmLine; move: CameraMove }[] = [];

  lines.forEach((line, index) => {
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
  });
  const everyScene = [startScene, ...lineScenes];
  const opening = openingPose(source, startScene, lineScenes, errors, inks);
  const shots: Shot[] = [];
  [...shotRequests].sort((a, b) => a.time - b.time).forEach(({ move, time, seconds, index, line }) => {
    const placement = resolvePlacement([lineScenes[index]!, ...everyScene], move.go, inks);
    if (!placement) {
      errors.push(`line ${line.line}: the camera goes to "${move.go}", which is not in the Scene`);
      return;
    }
    shots.push({ start: time, end: time + seconds, to: poseFor(move.focus ? focusedOn(placement, move.focus) : placement, move) });
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
  timeline.finish();
  return {
    source,
    lead,
    duration: lead + timeline.duration + (header.tail ?? DEFAULT_TAIL_SECONDS),
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
  };
}

function openingPose(source: FilmSource, startScene: SceneState, lineScenes: SceneState[], errors: string[], inks: InkBoxes): Pose {
  const scenes = [startScene, ...lineScenes];
  const wanted = source.header.opening?.go;
  const first = scenes.map((scene) => [...layoutWorld(scene).values()][0]).find((placement) => placement !== undefined);
  const placement = wanted ? resolvePlacement(scenes, wanted, inks) : first ? inked(first, inks) : null;
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
}

function objectOf(id: string): string {
  return id.slice(0, id.indexOf("/"));
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

export function frameAt(film: Film, time: number, theme: Theme): FilmFrame {
  const local = time - film.lead;
  const onCue: Theme = { ...theme, ease: ON_CUE_EASE };
  const located = film.timeline.locate(local, theme.motionScale, easeFor(onCue));
  const progress = located.progress.eased;
  const inner = renderFrame(film.timeline, local, onCue, planeStage);
  const before = layoutWorld(located.before);
  const after = layoutWorld(located.after);

  const grouped = new Map<string, Painted[]>();
  for (const item of inner.items) {
    const id = objectOf(item.id);
    const list = grouped.get(id);
    if (list) list.push(item);
    else grouped.set(id, [item]);
  }

  const pose = drift(poseAt(film.opening, film.shots, time, easeFor(theme)), time);
  const focusDepth = project(pose, [pose.tx, pose.ty, pose.tz])?.depth ?? 0;
  const planes: PlaneFrame[] = [...grouped].map(([id, items]) => {
    const from = before.get(id) ?? after.get(id)!;
    const to = after.get(id) ?? from;
    const placement: Placement = {
      id,
      x: mix(from.x, to.x, progress),
      y: mix(from.y, to.y, progress),
      z: mix(from.z, to.z, progress),
      w: Math.max(from.w, to.w),
      h: Math.max(from.h, to.h),
    };
    const center = centerOf(placement);
    const screen = project(pose, [center.x, center.y, center.z]);
    const depth = screen?.depth ?? 0;
    const fog = 1 / (1 + (Math.max(0, depth - FOG_START) / FOG_SCALE) ** 2);
    const blur = Math.min(BLUR_LIMIT, Math.max(0, (Math.abs(depth - focusDepth) - BLUR_FREE_RANGE) * BLUR_PER_UNIT));
    return { ...placement, items, opacity: fog, blur, visible: screen !== null, region: regionOf(pose, placement), ink: regionOf(pose, inked(placement, film.inks)) };
  });
  return { planes, matrix: cssMatrix(pose), pose, time };
}

export function loadFilmError(error: unknown): Error {
  return error instanceof LabError || error instanceof FilmError ? error : new Error(describe(error));
}
