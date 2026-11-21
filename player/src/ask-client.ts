import type { LessonHeader, Step } from "./format";
import type { LessonSink } from "./source";

export interface AskOrigin {
  lesson_id: string;
  step: number;
}

export interface AskRequest {
  text?: string;
  audio?: Blob;
  profileId: number | null;
  from: AskOrigin | null;
}

export interface AskReply {
  lesson_id: string;
  transcript: string;
}

type Raw = Record<string, unknown>;

export function headerOf(raw: Raw | undefined): LessonHeader {
  const inner = (raw?.lesson ?? raw ?? {}) as Partial<LessonHeader>;
  return { ...inner, title: inner.title ?? "Lesson" };
}

async function failureMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = typeof body?.detail === "string" ? body.detail : null;
  return detail ?? `the server answered ${response.status}`;
}

function askBody(request: AskRequest): { body: BodyInit; headers: Record<string, string> } {
  if (!request.audio) {
    const fields = { text: request.text, profile_id: request.profileId ?? undefined, from: request.from ?? undefined };
    return { body: JSON.stringify(fields), headers: { "content-type": "application/json" } };
  }
  const form = new FormData();
  form.set("audio", request.audio, "ask.webm");
  if (request.profileId !== null) form.set("profile_id", String(request.profileId));
  if (request.from) form.set("from", JSON.stringify(request.from));
  return { body: form, headers: {} };
}

export async function postAsk(request: AskRequest): Promise<AskReply> {
  const { body, headers } = askBody(request);
  const response = await fetch("/api/asks", { method: "POST", headers, body });
  if (!response.ok) throw new Error(await failureMessage(response));
  return (await response.json()) as AskReply;
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
