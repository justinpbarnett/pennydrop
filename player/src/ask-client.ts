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

export class AskError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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
  form.set("audio", request.audio, `ask.${request.audio.type.includes("mp4") ? "m4a" : "webm"}`);
  if (request.profileId !== null) form.set("profile_id", String(request.profileId));
  if (request.from) form.set("from", JSON.stringify(request.from));
  return { body: form, headers: {} };
}

export async function postAsk(request: AskRequest): Promise<AskReply> {
  const { body, headers } = askBody(request);
  const response = await fetch("/api/asks", { method: "POST", headers, body });
  if (!response.ok) throw new AskError(await failureMessage(response), response.status);
  return (await response.json()) as AskReply;
}
