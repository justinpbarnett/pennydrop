import "./film.css";
import { loadFonts } from "../boot";
import { loadMintedLabs } from "../minted";
import { registerModules } from "../registry";
import { THEMES } from "../theme";
import { PERSPECTIVE, project } from "./camera";
import { buildFilm, type CueRecord, type Film, frameAt, framedRegion, holdEnd, type PlaneFrame, unfilledAt } from "./film";
import { FILM_FPS, parseFilm } from "./format";
import { type InkBox, InkRecord } from "./inks";
import { loadLand } from "./land";
import { FilmView } from "./view";

registerModules(import.meta.glob("./pieces/*.ts", { eager: true }));

export interface FilmManifest {
  duration: number;
  fps: number;
  theme: string;
  title: string;
  lineStarts: number[];
  lineNumbers: number[];
  cues: (CueRecord & { region?: { x: number; y: number; w: number; h: number } | null })[];
  accents: Film["accents"];
}

declare global {
  interface Window {
    film: {
      ready: Promise<void>;
      load(text: string): Promise<FilmManifest>;
      seek(time: number): Promise<void>;
      regions(time: number): Record<string, { x: number; y: number; w: number; h: number } | null>;
      audit(): { shot: number; at: number; object: string | null; tilt: number; top: number | null; bottom: number | null; left: number | null; right: number | null; smallestText: number | null; peeking: string[]; wait: number | null }[];
    };
  }
}

const LINE_END = 0.99;

let film: Film | null = null;
let view: FilmView | null = null;

function loaded(): Film {
  if (!film) throw new Error("no film is loaded");
  return film;
}

function measureInks(draft: Film, drawing: FilmView): InkRecord {
  const theme = THEMES[draft.source.header.theme];
  const lineEnds = draft.lineStarts.map((start, index) => start + ((draft.lineStarts[index + 1] ?? draft.duration) - start) * LINE_END);
  const holdEnds = draft.shots.map((_, index) => holdEnd(draft, index) - 1 / FILM_FPS);
  return new InkRecord(
    [...new Set([...lineEnds, ...holdEnds])].map((time) => ({
      time,
      boxes: new Map(frameAt(draft, time, theme).planes.flatMap((plane): [string, InkBox][] => {
        const ink = drawing.measureInk(plane, theme);
        return ink ? [[plane.id, ink]] : [];
      })),
    })),
  );
}

window.film = {
  ready: Promise.all([loadFonts(), loadMintedLabs(), loadLand()]).then(() => undefined),
  async load(text) {
    const source = parseFilm(text);
    const draft = await buildFilm(source);
    view = new FilmView(document.body, draft.bounds);
    film = await buildFilm(source, measureInks(draft, view));
    return {
      duration: film.duration,
      fps: FILM_FPS,
      theme: source.header.theme,
      title: source.header.title,
      lineStarts: film.lineStarts,
      lineNumbers: source.lines.map((line) => line.line),
      cues: film.cues,
      accents: film.accents,
    };
  },
  async seek(time) {
    const current = loaded();
    view!.draw(frameAt(current, time, THEMES[current.source.header.theme]), THEMES[current.source.header.theme]);
    await view!.settle();
  },
  audit() {
    const current = loaded();
    const theme = THEMES[current.source.header.theme];
    const slope = (frame: ReturnType<typeof frameAt>, placed: PlaneFrame): number => {
      const ink = current.inks.at(placed.id, frame.time);
      if (!ink) return 0;
      const left = project(frame.pose, [placed.x + ink.x, placed.y + ink.y, placed.z]);
      const right = project(frame.pose, [placed.x + ink.x + ink.w, placed.y + ink.y, placed.z]);
      return left && right ? right.y - left.y : 0;
    };
    return current.shots.map((shot, index) => {
      let tilt = 0;
      for (let time = shot.start; time <= shot.end + 0.001; time += 1 / FILM_FPS) {
        const frame = frameAt(current, time, theme);
        for (const plane of frame.planes) {
          if (plane.ink && plane.visible) tilt = Math.max(tilt, Math.abs(slope(frame, plane)));
        }
      }
      const frame = frameAt(current, shot.end, theme);
      const nearest = frame.planes
        .filter((plane) => plane.ink)
        .sort((a, b) => Math.hypot(a.ink!.x + a.ink!.w / 2 - 960, a.ink!.y + a.ink!.h / 2 - 540) - Math.hypot(b.ink!.x + b.ink!.w / 2 - 960, b.ink!.y + b.ink!.h / 2 - 540))[0];
      const target = frame.planes.find((plane) => plane.id === shot.subject && plane.ink) ?? nearest;
      const ink = target && framedRegion(current, index, frame, target);
      const depth = target ? project(frame.pose, [target.x + target.w / 2, target.y + target.h / 2, target.z])?.depth : undefined;
      const sizes = (target?.items ?? []).filter((item) => item.kind === "text" && (item.text?.trim() || item.spans?.length)).map((item) => item.size);
      const smallestText = depth && sizes.length ? Math.min(...sizes) * (PERSPECTIVE / depth) : null;
      const laterOps = target ? current.cues.filter((cue) => cue.kind === "do" && cue.object === target.id && cue.opStart > shot.end).map((cue) => cue.opStart) : [];
      const wait = target && laterOps.length && unfilledAt(current, shot.end, theme, target.id) ? Math.min(...laterOps) - shot.end : null;
      return { shot: index, at: shot.end, object: target?.id ?? null, tilt, top: ink?.y ?? null, bottom: ink ? 1080 - ink.y - ink.h : null, left: ink?.x ?? null, right: ink ? 1920 - ink.x - ink.w : null, smallestText, peeking: frame.planes.filter((plane) => plane.ink && plane.id !== target?.id).map((plane) => plane.id), wait };
    });
  },
  regions(time) {
    const current = loaded();
    const frame = frameAt(current, time, THEMES[current.source.header.theme]);
    return Object.fromEntries(frame.planes.map((plane) => [plane.id, plane.region]));
  },
};
