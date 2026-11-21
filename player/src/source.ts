import { type Challenge, type LessonHeader, parseJsonl, type Step } from "./format";

export interface LessonListing {
  id: string;
  title: string;
}

export interface LessonSink {
  header(header: LessonHeader): void;
  step(step: Step): void;
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
  sink.done();
}

export async function loadLesson(id: string, sink: LessonSink, live: boolean, signal?: AbortSignal): Promise<void> {
  let count = 0;
  const counting: LessonSink = { ...sink, step: (step) => { count += 1; sink.step(step); } };
  try {
    if (live) {
      await streamLesson(id, counting, () => count, signal);
      return;
    }
    const document = (await getJson(`/api/lessons/${id}`)) as Raw;
    sink.header(headerOf(document));
    (document.steps as Step[]).forEach((step) => sink.step(step));
    sink.done();
  } catch (apiFailure) {
    if (count > 0) throw apiFailure;
    await loadStatic(id, sink);
  }
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
