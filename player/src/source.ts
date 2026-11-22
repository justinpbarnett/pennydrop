import { type Challenge, type Form, type LessonHeader, parseJsonl, type Practice, type Step } from "./format";
import type { PendingChallenge } from "./playback";

export interface LessonListing {
  id: string;
  title: string;
}

export interface LessonSink {
  header(header: LessonHeader): void;
  step(step: Step): void;
  practice(practice: Practice): void;
  done(): void;
  error(message: string): void;
}

type Raw = Record<string, unknown>;

export function headerOf(raw: Raw | undefined): LessonHeader {
  const inner = (raw?.lesson ?? raw ?? {}) as Partial<LessonHeader>;
  return { ...inner, title: inner.title ?? "Lesson" };
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

export async function listLessons(): Promise<LessonListing[]> {
  for (const url of ["/api/lessons", "/lessons/index.json"]) {
    try {
      const rows = (await getJson(url)) as Raw[];
      return rows.map((row) => ({ id: String(row.id), title: String(row.title ?? headerOf(row).title ?? row.id) }));
    } catch {
      continue;
    }
  }
  return [];
}

export function streamLesson(id: string, sink: LessonSink, received: () => number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const events = new EventSource(`/api/lessons/${id}/events`);
    let finished = false;
    const finish = () => {
      finished = true;
      events.close();
      resolve();
    };
    const listen = (name: string, handle: (data: Raw) => void) =>
      events.addEventListener(name, (event) => {
        if (finished || !(event instanceof MessageEvent)) return;
        handle(JSON.parse(event.data as string) as Raw);
      });
    signal?.addEventListener("abort", finish);
    listen("lesson", (data) => sink.header(headerOf(data)));
    listen("step", (data) => sink.step(data as unknown as Step));
    listen("practice", (data) => sink.practice(data as unknown as Practice));
    listen("done", () => {
      sink.done();
      finish();
    });
    listen("error", (data) => {
      sink.error(String(data.message ?? "the lesson stream failed"));
      finish();
    });
    events.onerror = () => {
      if (finished || events.readyState !== EventSource.CLOSED) return;
      sink.error(`the connection to /api/lessons/${id}/events closed${received() ? " before the lesson finished" : ""}`);
      finish();
    };
  });
}

async function loadStatic(id: string, sink: LessonSink): Promise<void> {
  const response = await fetch(`/lessons/${id}.jsonl`);
  if (!response.ok) throw new Error(`no lesson "${id}": the server and /lessons/${id}.jsonl both failed`);
  const source = parseJsonl(id, await response.text());
  sink.header(source.lesson);
  source.steps.forEach((step) => sink.step(step));
  if (source.practice) sink.practice(source.practice);
  sink.done();
}

export async function loadLesson(id: string, sink: LessonSink, signal?: AbortSignal): Promise<void> {
  let count = 0;
  let failure = null as string | null;
  await streamLesson(id, { ...sink, step: (step) => { count += 1; sink.step(step); }, error: (message) => { failure = message; } }, () => count, signal);
  if (failure === null) return;
  if (count > 0) return sink.error(failure);
  const streamFailure = failure;
  await loadStatic(id, sink).catch(() => sink.error(streamFailure));
}

export interface ProfileSummary {
  id: number;
  name: string;
  kind: string;
}

export function pickProfile<T extends { id: number; kind: string }>(profiles: T[], preferred: number | null): T | null {
  return profiles.find((profile) => profile.id === preferred) ?? profiles.find((profile) => profile.kind === "adult") ?? null;
}

export async function resolveProfileId(preferred: number | null): Promise<number | null> {
  try {
    return pickProfile((await getJson("/api/profiles")) as ProfileSummary[], preferred)?.id ?? null;
  } catch {
    return null;
  }
}

export async function postAnswer(lesson: string, step: number, challenge: Challenge, given: unknown, correct: boolean, profile: number): Promise<void> {
  try {
    await fetch("/api/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile_id: profile, lesson_id: lesson, step, prompt: challenge, answer: given, correct }),
    });
  } catch {
    return;
  }
}

export interface Verdict {
  correct: boolean;
  feedback: string;
}

export interface RuleReview {
  rule_id: number;
  rule: string;
  condition: string;
  lesson_id: string;
  lesson_title: string | null;
  form: Form;
  direction: "forward" | "back" | null;
  passed: Form[];
  held: boolean;
  schedule: { ease: number; interval_days: number; reps: number; lapses: number };
  due: string;
}

export interface PracticeReply extends Verdict {
  review: RuleReview;
}

export async function postPracticeAnswer(profile: number, caseId: number, given: unknown, correct: boolean | null): Promise<PracticeReply> {
  const response = await fetch("/api/practice/answers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile_id: profile, case_id: caseId, answer: given, correct }),
  });
  if (!response.ok) throw new Error(`the answer was not saved: the server answered ${response.status}`);
  return (await response.json()) as PracticeReply;
}

export async function submitAnswer(lesson: string, pending: PendingChallenge, given: unknown, correct: boolean | null, profile: number | null): Promise<Verdict> {
  if (pending.caseId !== undefined && profile !== null) return postPracticeAnswer(profile, pending.caseId, given, correct);
  if (correct === null) throw new Error("there is no Profile to grade this answer for");
  if (profile !== null && pending.caseId === undefined) await postAnswer(lesson, pending.step, pending.challenge, given, correct, profile);
  return { correct, feedback: "" };
}
