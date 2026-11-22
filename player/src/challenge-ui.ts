import { transcribe } from "./ask-client";
import type { Challenge, Form } from "./format";
import { describeAnswer, type Given, isCorrect, promptFor } from "./challenge";
import { h } from "./dom";
import { Endpoint } from "./endpoint";
import { icons } from "./kids/svg";
import { Recorder } from "./recorder";
import type { Verdict } from "./source";

export interface ChallengeHost {
  onAnswer(given: Given, correct: boolean | null): Promise<Verdict>;
  onContinue(): void;
}

export interface ChallengeOptions {
  reading: boolean;
  form?: Form;
  say?: string;
}

export interface ChallengeView {
  element: HTMLElement;
  acceptPart(part: string): void;
  dispose(): void;
}

const FORM_LABELS: Record<Form, string> = { say: "Say", applies: "Applies", fresh: "Fresh" };

type ChallengeOf<T extends Challenge["type"]> = Extract<Challenge, { type: T }>;

interface Controls {
  body: HTMLElement;
  reading: boolean;
  settle(given: Given): void;
  onDispose(cleanup: () => void): void;
}

type Builder<C extends Challenge> = (challenge: C, controls: Controls) => ((part: string) => void) | void;

function buildNumber(_challenge: ChallengeOf<"number">, { body, settle }: Controls): void {
  const input = h("input", { type: "number", inputmode: "decimal", "aria-label": "Your prediction" });
  const submit = () => input.value !== "" && settle(Number(input.value));
  input.addEventListener("keydown", (event) => event.key === "Enter" && submit());
  body.append(input, h("button", { class: "primary", onclick: submit }, "Lock in"));
}

function buildChoice(challenge: ChallengeOf<"choice">, { body, settle }: Controls): void {
  const buttons = challenge.choices.map((choice) => h("button", { class: "choice" }, choice));
  buttons.forEach((button, index) => button.addEventListener("click", () => {
    button.classList.add("picked");
    buttons[challenge.choices.indexOf(challenge.answer)]?.classList.add("answer");
    settle(challenge.choices[index]!);
  }));
  body.append(...buttons);
}

function buildClick(_challenge: ChallengeOf<"click">, { body, settle }: Controls): (part: string) => void {
  body.append(h("p", { class: "challenge-hint" }, "Tap it on the stage."));
  return (part) => settle(part);
}

function buildOrder(challenge: ChallengeOf<"order">, { body, settle }: Controls): void {
  const picked: string[] = [];
  const line = h("p", { class: "challenge-hint" }, "Nothing picked yet.");
  body.append(line, ...challenge.choices.map((choice) => {
    const button = h("button", { class: "choice" }, choice);
    button.addEventListener("click", () => {
      picked.push(choice);
      button.disabled = true;
      line.textContent = picked.join("  >  ");
      if (picked.length === challenge.choices.length) settle(picked);
    });
    return button;
  }));
}

function buildMatch(challenge: ChallengeOf<"match">, { body, settle }: Controls): void {
  const found: [string, string][] = [];
  let left: string | null = null;
  const line = h("p", { class: "challenge-hint" }, "Pick a left item, then its match.");
  const lefts = challenge.pairs.map(([name]) => name);
  const rights = challenge.pairs.map(([, name]) => name).sort();
  const used = new Set<string>();
  const choose = (name: string, side: "left" | "right", button: HTMLButtonElement) => {
    if (side === "left") {
      left = name;
      line.textContent = `${name} goes with...`;
      return;
    }
    if (!left) return;
    found.push([left, name]);
    used.add(left);
    button.disabled = true;
    body.querySelectorAll<HTMLButtonElement>("[data-side=left]").forEach((candidate) => (candidate.disabled = used.has(candidate.textContent ?? "")));
    line.textContent = found.map(([a, b]) => `${a} - ${b}`).join(", ");
    left = null;
    if (found.length === lefts.length) settle(found);
  };
  const column = (names: string[], side: "left" | "right") => h("div", { class: "match-column" }, ...names.map((name) => {
    const button = h("button", { class: "choice", "data-side": side }, name);
    button.addEventListener("click", () => choose(name, side, button));
    return button;
  }));
  body.append(line, h("div", { class: "match" }, column(lefts, "left"), column(rights, "right")));
}

function buildYesNo(challenge: ChallengeOf<"yesno">, { body, reading, settle }: Controls): void {
  const options = [
    { value: "yes", word: "Yes", icon: icons.tick },
    { value: "no", word: "No", icon: icons.cross },
  ];
  const buttons = options.map(({ value, word, icon }) => h("button", reading ? { class: "choice" } : { class: `choice icon ${value}`, "aria-label": word }, ...(reading ? [word] : [icon()])));
  buttons.forEach((button, index) => button.addEventListener("click", () => {
    button.classList.add("picked");
    buttons[options.findIndex(({ value }) => value === challenge.answer)]?.classList.add("answer");
    settle(options[index]!.value);
  }));
  body.append(...buttons);
}

function buildWords(_challenge: ChallengeOf<"words">, { body, reading, settle, onDispose }: Controls): void {
  const meter = h("i", { class: "meter" });
  const mic = h("button", { class: "mic", type: "button", "aria-label": "Answer with your voice", "aria-pressed": "false" }, meter);
  const hint = h("p", { class: "challenge-hint", role: "status" });
  const endpoint = new Endpoint();
  let listening = false;
  const recorder = new Recorder((level) => {
    mic.style.setProperty("--level", level.toFixed(3));
    if (listening && endpoint.finished(level, performance.now())) void finishListening();
  });
  onDispose(() => recorder.cancel());
  const field = reading ? h("textarea", { rows: "3", placeholder: "Type it here, or tap the mic and say it", "aria-label": "Your answer" }) : null;
  const send = () => field && field.value.trim() && settle(field.value.trim());

  async function startListening(): Promise<void> {
    try {
      await recorder.start();
    } catch (failure) {
      hint.textContent = (failure as Error).message;
      return;
    }
    endpoint.begin(performance.now());
    listening = true;
    mic.setAttribute("aria-pressed", "true");
    body.classList.add("recording");
    hint.textContent = reading ? "Listening - tap the mic again when you are done." : "";
  }

  async function finishListening(): Promise<void> {
    listening = false;
    mic.setAttribute("aria-pressed", "false");
    body.classList.remove("recording");
    const audio = await recorder.stop();
    if (!reading && !endpoint.spoke) return;
    hint.textContent = reading ? "Writing down what you said..." : "";
    mic.disabled = true;
    try {
      const text = await transcribe(audio);
      if (!text) hint.textContent = "Nothing came through. Try again.";
      else if (field) { field.value = field.value ? `${field.value} ${text}` : text; field.focus(); hint.textContent = ""; }
      else settle(text);
    } catch (failure) {
      hint.textContent = (failure as Error).message;
    }
    mic.disabled = false;
  }

  mic.addEventListener("click", () => void (listening ? finishListening() : startListening()));
  if (field) {
    field.addEventListener("keydown", (event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && send());
    body.append(field, mic, h("button", { class: "primary", type: "button", onclick: send }, "Send"), hint);
    return;
  }
  mic.classList.add("big");
  mic.append(icons.mic(), icons.tick(), icons.cross());
  body.append(mic);
  void startListening();
}

const BUILDERS: { [T in Challenge["type"]]: Builder<ChallengeOf<T>> } = {
  number: buildNumber,
  choice: buildChoice,
  click: buildClick,
  order: buildOrder,
  match: buildMatch,
  yesno: buildYesNo,
  words: buildWords,
};

export function buildChallenge(challenge: Challenge, host: ChallengeHost, { reading, form, say }: ChallengeOptions): ChallengeView {
  const body = h("div", { class: "challenge-body" });
  const feedback = h("p", { class: "challenge-feedback", role: "status" });
  const detail = h("p", { class: "challenge-detail" });
  const verdict = h("div", { class: "challenge-verdict" }, feedback);
  const kicker = form ? `Practice - ${FORM_LABELS[form]}` : challenge.kind === "explain" ? "Explain" : "Predict";
  const panel = reading
    ? h("section", { class: "challenge-card" }, h("p", { class: "challenge-kicker" }, kicker), h("p", { class: "challenge-prompt" }, promptFor(challenge, say)), body, verdict, detail)
    : h("section", { class: "challenge-card wordless" }, body);
  const cleanups: (() => void)[] = [];
  let settled = false;

  const controls = () => body.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, input, textarea");
  const lock = (locked: boolean) => controls().forEach((control) => (control.disabled = locked));
  const show = (correct: boolean) => {
    feedback.className = `challenge-feedback ${correct ? "right" : "wrong"}`;
    const answer = describeAnswer(challenge);
    feedback.textContent = correct ? "Right." : `Not quite.${answer ? ` The answer is ${answer}.` : ""}`;
    panel.classList.add(correct ? "right" : "wrong");
    if (reading && !verdict.querySelector(".continue")) verdict.append(h("button", { class: "primary continue", type: "button", onclick: () => host.onContinue() }, "Continue"));
  };

  const settle = (given: Given) => {
    if (settled) return;
    settled = true;
    lock(true);
    const local = isCorrect(challenge, given);
    if (local === null) {
      feedback.className = "challenge-feedback";
      feedback.textContent = "Checking...";
    } else show(local);
    host.onAnswer(given, local).then(
      (verdict) => {
        if (local === null) show(verdict.correct);
        detail.textContent = verdict.feedback;
      },
      (failure: Error) => {
        if (local !== null) return;
        settled = false;
        lock(false);
        feedback.className = "challenge-feedback wrong";
        feedback.textContent = failure.message;
      },
    );
  };

  const acceptPart = (BUILDERS[challenge.type] as Builder<Challenge>)(challenge, { body, reading, settle, onDispose: (cleanup) => cleanups.push(cleanup) });
  return { element: panel, acceptPart: (part) => acceptPart?.(part), dispose: () => cleanups.forEach((cleanup) => cleanup()) };
}
