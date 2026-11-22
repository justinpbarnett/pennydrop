import "./app.css";
import { postAsk, type AskOrigin } from "./ask-client";
import { buildAskBar } from "./ask-ui";
import { loadFonts } from "./boot";
import { buildChallenge, type ChallengeView } from "./challenge-ui";
import { h } from "./dom";
import { loadMintedLabs } from "./minted";
import { Playback } from "./playback";
import { Recorder } from "./recorder";
import { StageRenderer } from "./render";
import { resolveProfileId, listLessons, loadLesson, postAnswer } from "./source";
import { fitStage } from "./stage-fit";
import { THEMES, type ThemeId } from "./theme";
import { applyThemeVars } from "./theme-css";
import { buildSwatches, markSwatches, rememberedTheme, rememberTheme } from "./theme-picker";

const query = new URLSearchParams(location.search);
const requestedProfile = query.has("profile") ? Number(query.get("profile")) : null;

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

fitStage($(".stage-frame"));

let playback = new Playback();
let lessonId = "";
let profileId: number | null = null;
let loading = new AbortController();
let writing = false;
let themeId: ThemeId = rememberedTheme();
let challengeView: ChallengeView | null = null;
let shownChallenge = -1;
let captionStep = -1;
let captionWord = -1;
let tickCount = -1;
let scrubbing = false;

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function applyTheme(id: ThemeId): void {
  themeId = id;
  applyThemeVars(id);
  playback.setTheme(id);
  rememberTheme(id);
  markSwatches(id);
}

function renderCaption(): void {
  const pendingIndex = playback.pending ? playback.timeline.steps.findIndex((candidate) => candidate.step.step === playback.pending!.step) : -1;
  const index = pendingIndex >= 0 ? pendingIndex : playback.timeline.stepIndexAt(playback.time);
  const span = playback.timeline.steps[index];
  if (!span) {
    caption.textContent = "";
    captionStep = -1;
    return;
  }
  const { narration } = span;
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
    onAnswer: (given, correct) => { if (profileId !== null) void postAnswer(lessonId, pending.step, pending.challenge, given, correct, profileId); },
    onContinue: () => playback.answer(),
  });
  overlay.replaceChildren(challengeView.element);
  overlay.hidden = false;
  overlay.querySelector<HTMLInputElement>("input")?.focus();
}

function renderStatus(): void {
  const waiting = playback.state !== "buffering" ? "" : writing ? "Writing the next Step..." : "Loading the next Step...";
  const message = playback.error ?? waiting;
  status.hidden = !message;
  status.textContent = message;
  status.classList.toggle("error", Boolean(playback.error));
  status.classList.toggle("quiet", !playback.error);
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

async function open(id: string, beingWritten = false): Promise<void> {
  playback.pause();
  loading.abort();
  loading = new AbortController();
  lessonId = id;
  writing = beingWritten;
  playback = new Playback();
  tickCount = -1;
  captionStep = -1;
  shownChallenge = -1;
  playback.subscribe(render);
  applyTheme(themeId);
  const current = playback;
  history.replaceState(null, "", `?${new URLSearchParams({ ...Object.fromEntries(query), lesson: id })}`);
  if (beingWritten) current.play();
  await loadLesson(id, {
    header: (header) => { current.setHeader(header); document.title = `${header.title} - Pennydrop`; titlePickerOption(id, header.title); },
    step: (step) => current.addStep(step),
    done: () => current.finishLesson(),
    error: (message) => current.fail(message),
  }, loading.signal).catch((failure: Error) => current.fail(failure.message));
  render();
}

function titlePickerOption(id: string, title: string): void {
  const option = Array.from(picker.options).find((candidate) => candidate.value === id);
  if (option) option.textContent = title;
}

function addPickerOption(id: string, title: string): void {
  if (!Array.from(picker.options).some((candidate) => candidate.value === id)) picker.prepend(h("option", { value: id }, title));
  picker.value = id;
}

function onScreen(): AskOrigin | null {
  const span = playback.timeline.steps[playback.timeline.stepIndexAt(playback.time)];
  return lessonId && span ? { lesson_id: lessonId, step: span.step.step } : null;
}

const askBar = buildAskBar({ onText: (text) => void ask({ text }), onMicTap: () => void toggleRecording() });
const recorder = new Recorder((level) => askBar.setLevel(level));

async function ask(input: { text?: string; audio?: Blob }): Promise<void> {
  const from = onScreen();
  askBar.setBusy(true);
  askBar.say(input.audio ? "Listening to what you said..." : "Asking...", "working");
  try {
    const reply = await postAsk({ ...input, profileId, from });
    askBar.say(`You asked: ${reply.transcript}`, "heard");
    addPickerOption(reply.lesson_id, reply.transcript);
    void open(reply.lesson_id, true);
  } catch (failure) {
    askBar.say((failure as Error).message, "error");
  } finally {
    askBar.setBusy(false);
  }
}

async function toggleRecording(): Promise<void> {
  if (!recorder.recording) {
    try {
      await recorder.start();
      askBar.setRecording(true);
    } catch (failure) {
      askBar.say((failure as Error).message, "error");
    }
    return;
  }
  askBar.setRecording(false);
  await ask({ audio: await recorder.stop() });
}

function wireControls(): void {
  $(".top").insertBefore(askBar.element, $("#themes"));
  $(".stage-frame").append(askBar.note);
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

buildSwatches($("#themes"), applyTheme);
wireControls();
applyTheme(rememberedTheme());
requestAnimationFrame(loop);
profileId = await resolveProfileId(requestedProfile);
await loadMintedLabs();
const lessons = await listLessons();
picker.replaceChildren(...lessons.map((lesson) => h("option", { value: lesson.id }, lesson.title)));
const first = query.get("lesson") ?? lessons[0]?.id;
if (first) {
  addPickerOption(first, first);
  void open(first);
  await loadFonts();
} else {
  playback.fail("No lessons found. Start the server or add a lessons/*.jsonl file.");
  render();
}
