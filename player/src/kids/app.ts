import { AskError, postAsk, type AskOrigin } from "../ask-client";
import { isCorrect } from "../challenge";
import { h } from "../dom";
import { Playback } from "../playback";
import { Recorder } from "../recorder";
import { StageRenderer } from "../render";
import { loadLesson, postAnswer } from "../source";
import { THEMES } from "../theme";
import { Sounds } from "./sounds";
import { icons, mascot } from "./svg";
import { type Line, SystemVoice, unlockAudio } from "./voice";

type Mood = "idle" | "listen" | "think" | "sad" | null;

const SPEECH_LEVEL = 0.12;
const QUIET_LEVEL = 0.06;
const QUIET_SECONDS = 1.4;
const LONGEST_ASK_SECONDS = 20;
const MINIMUM_SPEECH_SECONDS = 0.4;
const NOTICE_SECONDS = 3;
const WRONG_TAPS_ALLOWED = 3;
const CONTINUE_AFTER_RIGHT_MS = 1300;
const THINKING_REPEAT_MS = 9000;

export interface KidsElements {
  stage: SVGSVGElement;
  frame: HTMLElement;
  face: HTMLElement;
  why: HTMLButtonElement;
  mic: HTMLButtonElement;
  play: HTMLButtonElement;
}

export class KidsApp {
  private readonly renderer: StageRenderer;
  private readonly sounds = new Sounds();
  private readonly voice = new SystemVoice();
  private readonly lessonAudio = new Audio();
  private readonly recorder = new Recorder((level) => this.onLevel(level));
  private readonly face = mascot();
  private playback: Playback;
  private loading = new AbortController();
  private lessonId = "";
  private asking = false;
  private noticeUntil = 0;
  private noticeLine: Line = "oops";
  private mood: Mood = null;
  private lastThinking = 0;
  private shownChallenge = -1;
  private tapsWrong = 0;
  private firstTapDone = false;
  private heardSpeech = false;
  private speechSeconds = 0;
  private quietSeconds = 0;
  private lastLevelAt = 0;
  private recordingSince = 0;

  constructor(private readonly ui: KidsElements, private readonly profileId: number | null) {
    this.renderer = new StageRenderer(ui.stage);
    this.playback = this.newPlayback();
    ui.face.append(this.face, h("div", { class: "dots" }, h("i"), h("i"), h("i")));
    ui.why.append(icons.why());
    ui.mic.append(icons.mic());
    ui.play.append(icons.play());
    ui.mic.addEventListener("click", () => void this.toggleRecording());
    ui.why.addEventListener("click", () => void this.ask({ text: "why?" }));
    ui.play.addEventListener("click", () => this.playback.toggle());
    ui.stage.addEventListener("click", (event) => this.tapStage(event));
    for (const name of ["click", "touchend"]) document.addEventListener(name, (event) => this.firstTap(event), { capture: true });
    this.fitStage();
    void this.voice.preload();
    requestAnimationFrame((now) => this.loop(now));
    this.render();
  }

  private newPlayback(): Playback {
    const playback = new Playback(this.lessonAudio);
    playback.setTheme("kids");
    playback.subscribe(() => this.render());
    return playback;
  }

  private firstTap(event: Event): void {
    if (this.firstTapDone) return;
    this.firstTapDone = true;
    unlockAudio(this.lessonAudio, this.voice.audio);
    this.sounds.unlock();
    const onMic = event.target instanceof Element && event.target.closest(".mic") !== null;
    if (!this.lessonId && !onMic) setTimeout(() => this.voice.say("hello"), 250);
  }

  private fitStage(): void {
    const area = this.ui.frame.parentElement!;
    new ResizeObserver(() => {
      const width = Math.min(area.clientWidth, area.clientHeight * (16 / 9));
      document.documentElement.style.setProperty("--stage-width", `${Math.floor(width)}px`);
    }).observe(area);
  }

  private loop(now: number): void {
    this.playback.tick(now);
    requestAnimationFrame((next) => this.loop(next));
  }

  private onScreen(): AskOrigin | null {
    const span = this.playback.timeline.steps[this.playback.timeline.stepIndexAt(this.playback.time)];
    return this.lessonId && span ? { lesson_id: this.lessonId, step: span.step.step } : null;
  }

  private async open(id: string): Promise<void> {
    this.playback.pause();
    this.loading.abort();
    this.loading = new AbortController();
    this.lessonId = id;
    this.shownChallenge = -1;
    this.playback = this.newPlayback();
    const current = this.playback;
    current.play();
    await loadLesson(id, {
      header: (header) => current.setHeader(header),
      step: (step) => current.addStep(step),
      done: () => current.finishLesson(),
      error: () => this.fail("oops"),
    }, true, this.loading.signal).catch(() => this.fail("oops"));
  }

  private async ask(input: { text?: string; audio?: Blob }): Promise<void> {
    const from = this.onScreen();
    this.playback.pause();
    this.asking = true;
    this.render();
    try {
      const reply = await postAsk({ ...input, profileId: this.profileId, from });
      this.asking = false;
      await this.open(reply.lesson_id);
    } catch (failure) {
      this.fail(failure instanceof AskError && failure.status === 422 ? "nothing-heard" : "oops");
    } finally {
      this.asking = false;
      this.render();
    }
  }

  private fail(line: Line): void {
    this.noticeLine = line;
    this.noticeUntil = performance.now() + NOTICE_SECONDS * 1000;
    this.playback.pause();
    this.asking = false;
    this.render();
    setTimeout(() => this.render(), NOTICE_SECONDS * 1000 + 50);
  }

  private async toggleRecording(): Promise<void> {
    if (this.recorder.recording) {
      const audio = await this.recorder.stop();
      this.ui.mic.setAttribute("aria-pressed", "false");
      const spoke = this.speechSeconds >= MINIMUM_SPEECH_SECONDS;
      if (spoke) await this.ask({ audio });
      else this.fail("nothing-heard");
      return;
    }
    this.playback.pause();
    this.heardSpeech = false;
    this.speechSeconds = 0;
    this.quietSeconds = 0;
    this.lastLevelAt = 0;
    this.recordingSince = performance.now();
    try {
      await this.recorder.start();
      this.ui.mic.setAttribute("aria-pressed", "true");
      this.sounds.pop();
    } catch {
      this.fail("oops");
    }
    this.render();
  }

  private onLevel(level: number): void {
    this.ui.mic.style.setProperty("--level", level.toFixed(3));
    if (!this.recorder.recording) return;
    const now = performance.now();
    const elapsed = this.lastLevelAt ? (now - this.lastLevelAt) / 1000 : 0;
    this.lastLevelAt = now;
    if (level > SPEECH_LEVEL) {
      this.heardSpeech = true;
      this.speechSeconds += elapsed;
      this.quietSeconds = 0;
    } else if (this.heardSpeech && level < QUIET_LEVEL) {
      this.quietSeconds += elapsed;
    }
    const talkedEnough = this.heardSpeech && this.quietSeconds >= QUIET_SECONDS;
    const tooLong = (now - this.recordingSince) / 1000 >= LONGEST_ASK_SECONDS;
    if (talkedEnough || tooLong) void this.toggleRecording();
  }

  private tapStage(event: MouseEvent): void {
    const pending = this.playback.pending;
    if (!pending || pending.challenge.type !== "click") return;
    const part = this.renderer.partAt(event.target);
    if (!part) {
      this.sounds.pop();
      return;
    }
    const correct = isCorrect(pending.challenge, part);
    if (this.tapsWrong === 0 && this.profileId !== null) void postAnswer(this.lessonId, pending.step, pending.challenge, part, correct, this.profileId);
    if (correct) {
      this.sounds.right();
      this.burst(event);
      this.pulse("right");
      setTimeout(() => this.playback.answer(), CONTINUE_AFTER_RIGHT_MS);
      return;
    }
    this.sounds.wrong();
    this.pulse("wrong");
    this.tapsWrong += 1;
    if (this.tapsWrong >= WRONG_TAPS_ALLOWED) setTimeout(() => this.playback.answer(), CONTINUE_AFTER_RIGHT_MS);
  }

  private pulse(kind: "right" | "wrong"): void {
    const frame = this.ui.frame;
    frame.classList.remove("right", "wrong");
    void frame.offsetWidth;
    frame.classList.add(kind);
  }

  private burst(event: MouseEvent): void {
    const bounds = this.ui.frame.getBoundingClientRect();
    const burst = h("div", { class: "burst", style: `left:${event.clientX - bounds.left}px;top:${event.clientY - bounds.top}px` },
      ...Array.from({ length: 10 }, (_, index) => h("i", { style: `--angle:${index * 36}deg;--hue:${index % 3}` })));
    this.ui.frame.append(burst);
    setTimeout(() => burst.remove(), 1200);
  }

  private moodNow(): Mood {
    if (performance.now() < this.noticeUntil) return "sad";
    if (this.recorder.recording) return "listen";
    if (this.asking || this.playback.state === "buffering") return "think";
    return this.lessonId ? null : "idle";
  }

  private render(): void {
    const playback = this.playback;
    this.renderer.draw(playback.frame(), THEMES.kids);
    const mood = this.moodNow();
    if (mood !== this.mood) this.enter(mood);
    else if (mood === "think" && performance.now() - this.lastThinking > THINKING_REPEAT_MS) this.enter(mood);
    const frame = this.ui.frame;
    const waitingForTap = playback.state === "challenge" && playback.pending?.challenge.type === "click";
    frame.classList.toggle("awaiting", waitingForTap);
    if (playback.pending && this.shownChallenge !== playback.pending.step) this.meetChallenge(playback.pending.step, playback.pending.challenge.type);
    if (!playback.pending) this.shownChallenge = -1;
    const playing = playback.state === "playing" || playback.state === "buffering";
    this.ui.play.replaceChildren(playing ? icons.pause() : icons.play());
    this.ui.play.disabled = !this.lessonId || this.asking;
    this.ui.why.disabled = !this.onScreen() || this.asking || this.recorder.recording;
    this.ui.mic.disabled = this.asking;
  }

  private meetChallenge(step: number, type: string): void {
    this.shownChallenge = step;
    this.tapsWrong = 0;
    if (type !== "click") setTimeout(() => this.playback.answer(), 400);
  }

  private enter(mood: Mood): void {
    this.mood = mood;
    this.ui.face.hidden = mood === null;
    this.ui.face.dataset.mood = mood ?? "";
    if (mood === "think") {
      this.lastThinking = performance.now();
      this.voice.say("thinking");
    }
    if (mood === "sad") this.voice.say(this.noticeLine);
  }
}
