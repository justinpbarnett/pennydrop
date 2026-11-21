import type { Challenge } from "./format";
import { describeAnswer, type Given, isCorrect } from "./challenge";
import { h } from "./dom";

export interface ChallengeHost {
  onAnswer(given: Given, correct: boolean): void;
  onContinue(): void;
}

export interface ChallengeView {
  element: HTMLElement;
  acceptPart(part: string): void;
}

const DEFAULT_PROMPTS: Record<Challenge["type"], string> = {
  number: "What number do you predict?",
  choice: "Pick one.",
  click: "Click the place on the stage.",
  order: "Put these in order: tap them one at a time.",
  match: "Match each pair.",
};

export function buildChallenge(challenge: Challenge, host: ChallengeHost): ChallengeView {
  const body = h("div", { class: "challenge-body" });
  const feedback = h("p", { class: "challenge-feedback", role: "status" });
  const panel = h("section", { class: "challenge-card" }, h("p", { class: "challenge-kicker" }, "Predict"), h("p", { class: "challenge-prompt" }, challenge.prompt ?? DEFAULT_PROMPTS[challenge.type]), body, feedback);
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

  let acceptPart = (_part: string) => {};
  if (challenge.type === "number") {
    const input = h("input", { type: "number", inputmode: "decimal", "aria-label": "Your prediction" });
    const submit = () => input.value !== "" && settle(Number(input.value));
    input.addEventListener("keydown", (event) => event.key === "Enter" && submit());
    body.append(input, h("button", { class: "primary", onclick: submit }, "Lock in"));
  } else if (challenge.type === "choice") {
    body.append(...challenge.choices.map((choice) => h("button", { class: "choice", onclick: () => settle(choice) }, choice)));
  } else if (challenge.type === "click") {
    body.append(h("p", { class: "challenge-hint" }, "Tap it on the stage."));
    acceptPart = (part) => settle(part);
  } else if (challenge.type === "order") {
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
  } else {
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
  return { element: panel, acceptPart: (part) => acceptPart(part) };
}
