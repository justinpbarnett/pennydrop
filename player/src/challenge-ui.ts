import type { Challenge } from "./format";
import { defaultPrompt, describeAnswer, type Given, isCorrect } from "./challenge";
import { h } from "./dom";

export interface ChallengeHost {
  onAnswer(given: Given, correct: boolean): void;
  onContinue(): void;
}

export interface ChallengeView {
  element: HTMLElement;
  acceptPart(part: string): void;
}

type ChallengeOf<T extends Challenge["type"]> = Extract<Challenge, { type: T }>;

interface Controls {
  body: HTMLElement;
  settle(given: Given): void;
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

const BUILDERS: { [T in Challenge["type"]]: Builder<ChallengeOf<T>> } = {
  number: buildNumber,
  choice: buildChoice,
  click: buildClick,
  order: buildOrder,
  match: buildMatch,
};

export function buildChallenge(challenge: Challenge, host: ChallengeHost): ChallengeView {
  const body = h("div", { class: "challenge-body" });
  const feedback = h("p", { class: "challenge-feedback", role: "status" });
  const panel = h("section", { class: "challenge-card" }, h("p", { class: "challenge-kicker" }, "Predict"), h("p", { class: "challenge-prompt" }, challenge.prompt ?? defaultPrompt(challenge)), body, feedback);
  let settled = false;

  const settle = (given: Given) => {
    if (settled) return;
    settled = true;
    const correct = isCorrect(challenge, given);
    host.onAnswer(given, correct);
    feedback.className = `challenge-feedback ${correct ? "right" : "wrong"}`;
    feedback.textContent = correct ? "Right." : `Not quite. The answer is ${describeAnswer(challenge)}.`;
    body.querySelectorAll("button, input").forEach((control) => ((control as HTMLButtonElement).disabled = true));
    panel.append(h("button", { class: "primary", onclick: () => host.onContinue() }, "Continue"));
  };

  const acceptPart = (BUILDERS[challenge.type] as Builder<Challenge>)(challenge, { body, settle });
  return { element: panel, acceptPart: (part) => acceptPart?.(part) };
}
