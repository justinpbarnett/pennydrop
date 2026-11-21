import type { Challenge, LessonHeader, LessonSource, Step } from "./format";
import { type Frame, renderFrame } from "./frame";
import { THEMES, type Theme, type ThemeId } from "./theme";
import { Timeline } from "./timeline";

export type PlaybackState = "idle" | "playing" | "paused" | "challenge" | "buffering" | "ended";

export interface PendingChallenge {
  step: number;
  challenge: Challenge;
}

const AUDIO_DRIFT_SECONDS = 0.25;

export class Playback {
  readonly timeline = new Timeline();
  header: LessonHeader = { title: "" };
  error: string | null = null;
  time = 0;
  state: PlaybackState = "idle";
  pending: PendingChallenge | null = null;
  private theme: Theme = THEMES.pattern;
  private wantsToPlay = false;
  private readonly answered = new Set<number>();
  private readonly audio = new Audio();
  private audioStep = -1;
  private lastTick = 0;
  private listeners: (() => void)[] = [];

  constructor() {
    this.audio.preload = "auto";
  }

  subscribe(listener: () => void): void {
    this.listeners.push(listener);
  }

  get themeId(): ThemeId {
    return this.theme.id;
  }

  setTheme(id: ThemeId): void {
    this.theme = THEMES[id];
    this.notify();
  }

  frame(): Frame {
    return renderFrame(this.timeline, this.time, this.theme);
  }

  loadSource(source: LessonSource): void {
    this.header = source.lesson;
    source.steps.forEach((step) => this.timeline.addStep(step));
    if (source.done) this.timeline.finish();
    this.notify();
  }

  addStep(step: Step): void {
    this.timeline.addStep(step);
    if (this.state === "buffering" && this.wantsToPlay) this.state = "playing";
    this.notify();
  }

  finishLesson(): void {
    this.timeline.finish();
    this.notify();
  }

  fail(message: string): void {
    this.error = message;
    this.notify();
  }

  play(): void {
    this.wantsToPlay = true;
    if (this.state === "ended") this.seek(0);
    if (this.state === "challenge") return;
    this.state = this.timeline.steps.length === 0 ? "buffering" : "playing";
    this.lastTick = performance.now();
    this.syncAudio(true);
    this.notify();
  }

  pause(): void {
    this.wantsToPlay = false;
    if (this.state === "playing" || this.state === "buffering") this.state = "paused";
    this.audio.pause();
    this.notify();
  }

  toggle(): void {
    if (this.state === "playing" || this.state === "buffering") this.pause();
    else this.play();
  }

  seek(time: number): void {
    this.time = Math.max(0, Math.min(time, this.timeline.duration));
    this.pending = null;
    if (this.state === "challenge") this.state = this.wantsToPlay ? "playing" : "paused";
    if (this.state === "ended" && this.time < this.timeline.duration) this.state = "paused";
    this.syncAudio(true);
    this.notify();
  }

  answer(): void {
    if (!this.pending) return;
    this.answered.add(this.pending.step);
    this.pending = null;
    this.state = "playing";
    this.wantsToPlay = true;
    this.lastTick = performance.now();
    this.syncAudio(true);
    this.notify();
  }

  tick(now: number): void {
    if (this.state !== "playing") return;
    const elapsed = Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const target = this.time + elapsed;
    const end = this.timeline.duration;
    const gate = this.timeline.steps.find((span) => span.step.challenge && !this.answered.has(span.step.step) && this.time < span.end && target >= span.end);
    if (gate) {
      this.time = gate.end;
      this.pending = { step: gate.step.step, challenge: gate.step.challenge! };
      this.state = "challenge";
      this.audio.pause();
    } else if (target >= end) {
      this.time = end;
      this.state = this.timeline.done ? "ended" : "buffering";
      this.audio.pause();
    } else {
      this.time = target;
      this.syncAudio(false);
    }
    this.notify();
  }

  private syncAudio(force: boolean): void {
    const index = this.timeline.stepIndexAt(this.time);
    const span = this.timeline.steps[index];
    const url = span?.step.voice?.url;
    if (!span || !url || this.time >= span.narrationEnd) {
      this.audio.pause();
      return;
    }
    const offset = this.time - span.start;
    if (this.audioStep !== index) {
      this.audio.src = url;
      this.audioStep = index;
      force = true;
    }
    if (force || Math.abs(this.audio.currentTime - offset) > AUDIO_DRIFT_SECONDS) this.audio.currentTime = offset;
    if (this.state === "playing" && this.audio.paused) this.audio.play().catch(() => undefined);
    if (this.state !== "playing") this.audio.pause();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}
