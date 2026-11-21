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

function headerOf(raw: Raw | undefined): LessonHeader {
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

async function loadStatic(id: string, sink: LessonSink): Promise<void> {
  const response = await fetch(`/lessons/${id}.jsonl`);
  if (!response.ok) throw new Error(`no lesson "${id}": the server and /lessons/${id}.jsonl both failed`);
  const source = parseJsonl(id, await response.text());
  sink.header(source.lesson);
  source.steps.forEach((step) => sink.step(step));
  sink.done();
}

function stream(id: string, sink: LessonSink, received: () => number): Promise<void> {
  return new Promise((resolve) => {
    const events = new EventSource(`/api/lessons/${id}/events`);
    const listen = (name: string, handle: (data: Raw) => void) =>
      events.addEventListener(name, (event) => handle(JSON.parse((event as MessageEvent<string>).data) as Raw));
    listen("lesson", (data) => sink.header(headerOf(data)));
    listen("step", (data) => sink.step(data as unknown as Step));
    listen("done", () => {
      events.close();
      sink.done();
      resolve();
    });
    listen("error", (data) => {
      events.close();
      sink.error(String(data.message ?? "the lesson stream failed"));
      resolve();
    });
    events.onerror = () => {
      if (events.readyState === EventSource.CLOSED) {
        sink.error(`the connection to /api/lessons/${id}/events closed${received() ? " before the lesson finished" : ""}`);
        resolve();
      }
    };
  });
}

export async function loadLesson(id: string, sink: LessonSink, live: boolean): Promise<void> {
  let count = 0;
  const counting: LessonSink = { ...sink, step: (step) => { count += 1; sink.step(step); } };
  try {
    if (live) {
      await stream(id, counting, () => count);
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
