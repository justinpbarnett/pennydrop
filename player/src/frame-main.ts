import "./frame.css";
import { loadFonts } from "./boot";
import { type LessonSource, parseJsonl } from "./format";
import { Playback } from "./playback";
import { StageRenderer } from "./render";
import { isThemeId, THEMES, type ThemeId } from "./theme";


export type LessonInput = string | Pick<LessonSource, "lesson" | "steps">;

interface PennydropFrameApi {
  load(source: LessonInput): Promise<void>;
  seek(time: number): void;
  setTheme(id: ThemeId): void;
  duration(): number;
  stepErrors(): string[];
  ready: Promise<void>;
}

declare global {
  interface Window {
    pennydrop: PennydropFrameApi;
  }
}

const renderer = new StageRenderer(document.querySelector<SVGSVGElement>("#stage")!);
let playback = new Playback();

function draw(): void {
  document.documentElement.dataset.theme = playback.themeId;
  renderer.draw(playback.frame(), THEMES[playback.themeId]);
}

function adopt(next: Playback): void {
  const themeId = playback.themeId;
  playback = next;
  playback.setTheme(themeId);
  playback.subscribe(draw);
}

window.pennydrop = {
  ready: loadFonts().then(draw),
  load(source) {
    adopt(new Playback());
    playback.loadSource(typeof source === "string" ? parseJsonl("frame", source) : { id: "frame", done: true, ...source });
    return playback.settled().then(() => {
      if (playback.error) throw new Error(playback.error);
      draw();
    });
  },
  seek(time) {
    playback.seek(time);
    draw();
  },
  setTheme(id) {
    if (!isThemeId(id)) throw new Error(`unknown theme "${String(id)}"`);
    playback.setTheme(id);
    draw();
  },
  duration: () => playback.timeline.duration,
  stepErrors: () => playback.timeline.steps.flatMap((span) => span.errors.map((message) => (message.startsWith(`step ${span.step.step}`) ? message : `step ${span.step.step}: ${message}`))),
};

playback.subscribe(draw);
const themeParam = new URLSearchParams(location.search).get("theme");
if (isThemeId(themeParam)) playback.setTheme(themeParam);
