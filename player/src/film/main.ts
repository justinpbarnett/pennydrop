import "./film.css";
import { loadFonts } from "../boot";
import { loadMintedLabs } from "../minted";
import { registerModules } from "../registry";
import { THEMES } from "../theme";
import { PERSPECTIVE, project } from "./camera";
import { buildFilm, type CueRecord, type Film, frameAt, type InkBoxes, type PlaneFrame } from "./film";
import { FILM_FPS, parseFilm } from "./format";
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
      load(text: string): FilmManifest;
      seek(time: number): Promise<void>;
      regions(time: number): Record<string, { x: number; y: number; w: number; h: number } | null>;
      audit(): { shot: number; at: number; object: string | null; tilt: number; top: number | null; bottom: number | null; left: number | null; right: number | null; smallestText: number | null }[];
    };
  }
}

const INK_SAMPLES = [0.1, 0.35, 0.6, 0.85, 0.99];

let film: Film | null = null;
let view: FilmView | null = null;

function loaded(): Film {
  if (!film) throw new Error("no film is loaded");
  return film;
}

function measureInks(draft: Film, drawing: FilmView): InkBoxes {
  const theme = THEMES[draft.source.header.theme];
  const inks: InkBoxes = new Map();
  draft.lineStarts.forEach((start, index) => {
    const end = draft.lineStarts[index + 1] ?? draft.duration;
    for (const share of INK_SAMPLES) {
      for (const plane of frameAt(draft, start + (end - start) * share, theme).planes) {
        const ink = drawing.measureInk(plane, theme);
        if (!ink) continue;
        const known = inks.get(plane.id);
        const left = Math.min(known?.x ?? ink.x, ink.x);
        const top = Math.min(known?.y ?? ink.y, ink.y);
        inks.set(plane.id, { x: left, y: top, w: Math.max((known?.x ?? ink.x) + (known?.w ?? ink.w), ink.x + ink.w) - left, h: Math.max((known?.y ?? ink.y) + (known?.h ?? ink.h), ink.y + ink.h) - top });
      }
    }
  });
  return inks;
}

window.film = {
  ready: Promise.all([loadFonts(), loadMintedLabs(), loadLand()]).then(() => undefined),
  load(text) {
    const source = parseFilm(text);
    const draft = buildFilm(source);
    view = new FilmView(document.body, draft.bounds);
    film = buildFilm(source, measureInks(draft, view));
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
      const ink = current.inks.get(placed.id);
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
      const target = frame.planes
        .filter((plane) => plane.ink)
        .sort((a, b) => Math.hypot(a.ink!.x + a.ink!.w / 2 - 960, a.ink!.y + a.ink!.h / 2 - 540) - Math.hypot(b.ink!.x + b.ink!.w / 2 - 960, b.ink!.y + b.ink!.h / 2 - 540))[0];
      const ink = target?.ink;
      const depth = target ? project(frame.pose, [target.x + target.w / 2, target.y + target.h / 2, target.z])?.depth : undefined;
      const sizes = (target?.items ?? []).filter((item) => item.kind === "text" && (item.text?.trim() || item.spans?.length)).map((item) => item.size);
      const smallestText = depth && sizes.length ? Math.min(...sizes) * (PERSPECTIVE / depth) : null;
      return { shot: index, at: shot.end, object: target?.id ?? null, tilt, top: ink?.y ?? null, bottom: ink ? 1080 - ink.y - ink.h : null, left: ink?.x ?? null, right: ink ? 1920 - ink.x - ink.w : null, smallestText };
    });
  },
  regions(time) {
    const current = loaded();
    const frame = frameAt(current, time, THEMES[current.source.header.theme]);
    return Object.fromEntries(frame.planes.map((plane) => [plane.id, plane.region]));
  },
};
