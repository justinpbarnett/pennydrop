import "./app.css";
import { loadFonts } from "./boot";
import { buildChallenge, type ChallengeView } from "./challenge-ui";
import { h } from "./dom";
import { narrate } from "./narration";
import { Playback } from "./playback";
import { StageRenderer } from "./render";
import { listLessons, loadLesson, postAnswer } from "./source";
import { isThemeId, THEME_IDS, THEMES, type ThemeId } from "./theme";

const query = new URLSearchParams(location.search);
const PROFILE_ID = Number(query.get("profile") ?? 1);
const THEME_KEY = "pennydrop.theme";

function storedTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function storeTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    return;
  }
}

function remembered(): ThemeId {
  const wanted = query.get("theme") ?? storedTheme();
  return isThemeId(wanted) ? wanted : "pattern";
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const renderer = new StageRenderer($<SVGSVGElement>("#stage"));
const picker = $<HTMLSelectElement>("#lesson");
const scrub = $<HTMLInputElement>("#scrub");
const playButton = $<HTMLButtonElement>("#play");
const clock = $("#clock");
const caption = $("#caption");
const ticks = $("#ticks");
const overlay = $("#overlay");
const status = $("#status");

const STAGE_ASPECT = 16 / 9;
const stageArea = $(".stage-area");
new ResizeObserver(() => {
  const width = Math.min(stageArea.clientWidth, stageArea.clientHeight * STAGE_ASPECT);
  document.documentElement.style.setProperty("--stage-width", `${Math.floor(width)}px`);
}).observe(stageArea);

let playback = new Playback();
let lessonId = "";
let themeId: ThemeId = remembered();
let challengeView: ChallengeView | null = null;
let shownChallenge = -1;
let captionStep = -1;
let captionWord = -1;
let tickCount = -1;
let scrubbing = false;

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function applyTheme(id: ThemeId): void {
  const theme = THEMES[id];
  const root = document.documentElement;
  themeId = id;
  root.dataset.theme = id;
  for (const [role, value] of Object.entries(theme.colors)) root.style.setProperty(`--${role}`, value);
  root.style.setProperty("--font-mark", theme.fonts.mark.family);
  root.style.setProperty("--font-read", theme.fonts.read.family);
  root.style.setProperty("--weight-mark", String(theme.fonts.mark.weight));
  root.style.setProperty("--tracking-mark", `${theme.fonts.mark.tracking}em`);
  root.style.setProperty("--corner", `${theme.corner}px`);
  root.style.setProperty("--mark-case", theme.capitalMarks ? "uppercase" : "none");
  root.style.setProperty("--stroke", `${theme.stroke}px`);
  playback.setTheme(id);
  storeTheme(id);
  document.querySelectorAll<HTMLButtonElement>(".swatch").forEach((swatch) => swatch.setAttribute("aria-checked", String(swatch.dataset.theme === id)));
}

function buildSwatches(): void {
  $("#themes").replaceChildren(...THEME_IDS.map((id) => {
    const theme = THEMES[id];
    const swatch = h("button", { class: "swatch", type: "button", role: "radio", "data-theme": id, title: theme.name, "aria-label": `${theme.name} theme` },
      h("span", { class: "chip", style: `background:${theme.colors.ground};border-color:${theme.colors.rule}` }, h("i", { style: `background:${theme.colors.accent}` })),
      h("span", { class: "label" }, theme.name));
    swatch.addEventListener("click", () => applyTheme(id));
    return swatch;
  }));
}

function renderCaption(): void {
  const pendingIndex = playback.pending ? playback.timeline.steps.findIndex((candidate) => candidate.step.step === playback.pending!.step) : -1;
  const index = pendingIndex >= 0 ? pendingIndex : playback.timeline.stepIndexAt(playback.time);
  const span = playback.timeline.steps[index];
  if (!span) {
    caption.textContent = playback.state === "buffering" ? "Getting the lesson ready..." : "";
    captionStep = -1;
    return;
  }
  const narration = narrate(span.step.say, span.step.voice);
  const local = Math.min(playback.time, span.narrationEnd) - span.start;
  const word = narration.words.reduce((found, timing, position) => (timing.start <= local ? position : found), -1);
  if (captionStep !== index) {
    captionStep = index;
    captionWord = -2;
    caption.replaceChildren(...narration.words.flatMap((timing, position) => [h("span", { "data-word": String(position) }, timing.word), " "]));
  }
  if (word !== captionWord) {
    captionWord = word;
    caption.querySelectorAll("[data-word]").forEach((element) => {
      const position = Number((element as HTMLElement).dataset.word);
      element.classList.toggle("now", position === word);
      element.classList.toggle("spoken", position < word);
    });
  }
}

function renderTicks(): void {
  const total = playback.timeline.duration || 1;
  if (tickCount === playback.timeline.steps.length) return;
  tickCount = playback.timeline.steps.length;
  ticks.replaceChildren(...playback.timeline.steps.map((span, index) => h("i", {
    class: span.step.challenge ? "tick challenge" : "tick",
    style: `left:${(span.start / total) * 100}%`,
    title: `Step ${span.step.step}`,
    "data-index": String(index),
  })));
}

function renderOverlay(): void {
  const pending = playback.pending;
  if (!pending) {
    overlay.hidden = true;
    shownChallenge = -1;
    challengeView = null;
    overlay.replaceChildren();
    return;
  }
  if (shownChallenge === pending.step) return;
  shownChallenge = pending.step;
  challengeView = buildChallenge(pending.challenge, {
    onAnswer: (given, correct) => void postAnswer(lessonId, pending.step, pending.challenge, given, correct, PROFILE_ID),
    onContinue: () => playback.answer(),
  });
  overlay.replaceChildren(challengeView.element);
  overlay.hidden = false;
  overlay.querySelector<HTMLInputElement>("input")?.focus();
}

function renderStatus(): void {
  const message = playback.error ?? (playback.state === "buffering" ? "Buffering - the next Step is on its way" : "");
  status.hidden = !message;
  status.textContent = message;
  status.classList.toggle("error", Boolean(playback.error));
}

function render(): void {
  renderer.draw(playback.frame(), THEMES[playback.themeId]);
  renderCaption();
  renderTicks();
  renderOverlay();
  renderStatus();
  const duration = playback.timeline.duration;
  scrub.max = String(duration);
  if (!scrubbing) scrub.value = String(playback.time);
  const fraction = duration ? (playback.time / duration) * 100 : 0;
  scrub.style.setProperty("--fraction", `${fraction}%`);
  clock.textContent = `${formatTime(playback.time)} / ${formatTime(duration)}${playback.timeline.done ? "" : "+"}`;
  const playing = playback.state === "playing" || playback.state === "buffering";
  playButton.dataset.state = playing ? "pause" : "play";
  playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
}

async function open(id: string): Promise<void> {
  lessonId = id;
  playback = new Playback();
  tickCount = -1;
  captionStep = -1;
  shownChallenge = -1;
  playback.subscribe(render);
  applyTheme(themeId);
  const live = query.has("live");
  const current = playback;
  await loadLesson(id, {
    header: (header) => { current.setHeader(header); document.title = `${header.title} - Pennydrop`; },
    step: (step) => current.addStep(step),
    done: () => current.finishLesson(),
    error: (message) => current.fail(message),
  }, live).catch((failure: Error) => current.fail(failure.message));
  history.replaceState(null, "", `?${new URLSearchParams({ ...Object.fromEntries(query), lesson: id })}`);
  render();
}

function wireControls(): void {
  playButton.addEventListener("click", () => playback.toggle());
  scrub.addEventListener("input", () => { scrubbing = true; playback.seek(Number(scrub.value)); });
  scrub.addEventListener("change", () => { scrubbing = false; });
  ticks.addEventListener("click", (event) => {
    const index = Number((event.target as HTMLElement).dataset.index);
    if (!Number.isNaN(index)) playback.seek(playback.timeline.steps[index]!.start);
  });
  $("#stage").addEventListener("click", (event) => {
    const part = renderer.partAt(event.target);
    if (part) challengeView?.acceptPart(part);
  });
  picker.addEventListener("change", () => void open(picker.value));
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
    if (event.target instanceof HTMLButtonElement && event.key === " ") return;
    if (event.key === " ") { event.preventDefault(); playback.toggle(); }
    if (event.key === "ArrowRight") playback.seek(playback.time + 5);
    if (event.key === "ArrowLeft") playback.seek(playback.time - 5);
  });
}

function loop(now: number): void {
  playback.tick(now);
  requestAnimationFrame(loop);
}

buildSwatches();
wireControls();
applyTheme(remembered());
requestAnimationFrame(loop);
const lessons = await listLessons();
picker.replaceChildren(...lessons.map((lesson) => h("option", { value: lesson.id }, lesson.title)));
const first = query.get("lesson") ?? lessons[0]?.id;
if (first) {
  picker.value = first;
  void open(first);
  await loadFonts();
} else {
  playback.fail("No lessons found. Start the server or add a lessons/*.jsonl file.");
  render();
}
