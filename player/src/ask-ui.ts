import { h } from "./dom";

export interface AskBarHandlers {
  onText(text: string): void;
  onMicTap(): void;
}

export interface AskBar {
  element: HTMLElement;
  setRecording(recording: boolean): void;
  setLevel(level: number): void;
  setBusy(busy: boolean): void;
  say(message: string, kind: "heard" | "error" | "working", seconds?: number): void;
  clearNote(): void;
}

const NOTE_SECONDS = 6;

export function buildAskBar(handlers: AskBarHandlers): AskBar {
  const input = h("input", { type: "text", id: "ask-text", placeholder: "Ask anything", autocomplete: "off", "aria-label": "Ask anything", enterkeyhint: "send" });
  const meter = h("i", { class: "meter" });
  const mic = h("button", { id: "ask-mic", class: "mic", type: "button", "aria-label": "Ask with your voice", "aria-pressed": "false" }, meter);
  const note = h("p", { class: "ask-note", role: "status", hidden: true });
  const form = h("form", { class: "ask", role: "search" }, input, mic, note);
  let noteTimer = 0;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    handlers.onText(text);
  });
  mic.addEventListener("click", () => handlers.onMicTap());

  const clearNote = () => {
    clearTimeout(noteTimer);
    note.hidden = true;
    note.textContent = "";
  };

  return {
    element: form,
    setRecording(recording) {
      mic.setAttribute("aria-pressed", String(recording));
      mic.setAttribute("aria-label", recording ? "Stop recording and ask" : "Ask with your voice");
      form.classList.toggle("recording", recording);
      if (recording) this.say("Listening - tap the mic again to ask", "working");
    },
    setLevel(level) {
      meter.style.setProperty("--level", level.toFixed(3));
    },
    setBusy(busy) {
      input.disabled = busy;
      mic.disabled = busy;
    },
    say(message, kind, seconds = kind === "heard" ? NOTE_SECONDS : 0) {
      clearNote();
      note.textContent = message;
      note.className = `ask-note ${kind}`;
      note.hidden = false;
      if (seconds > 0) noteTimer = window.setTimeout(clearNote, seconds * 1000);
    },
    clearNote,
  };
}
