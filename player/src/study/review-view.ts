import { buildChallenge, type ChallengeView } from "../challenge-ui";
import { h } from "../dom";
import { type Step, playedSteps } from "../format";
import { Playback } from "../playback";
import { StageRenderer } from "../render";
import { postPracticeAnswer, type RuleReview } from "../source";
import { THEMES, type ThemeId } from "../theme";
import { comesBack, fetchCase, fetchDue, fetchQueue } from "./api";
import { formPips, heldBadge, nextForm } from "./rule-row";

export interface ReviewView {
  element: HTMLElement;
  setTheme(id: ThemeId): void;
  start(): void;
}

export function buildReviewView(profile: number, themeId: ThemeId): ReviewView {
  let theme = themeId;
  let playback: Playback | null = null;
  let challengeView: ChallengeView | null = null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "The stage for this case");
  const renderer = new StageRenderer(svg);
  const summary = h("p", { class: "review-count", role: "status" });
  const panel = h("div", { class: "review-panel" });
  const stage = h("div", { class: "review-stage" }, svg);
  const work = h("div", { class: "review-work", hidden: true }, stage, panel);
  const lists = h("div", { class: "rule-lists" });
  const element = h("div", { class: "review" }, h("h1", {}, "Review"), summary, work, lists);

  const redraw = () => playback && renderer.draw(playback.frame(), THEMES[theme]);
  svg.addEventListener("click", (event) => {
    const part = renderer.partAt(event);
    if (part) challengeView?.acceptPart(part);
  });

  async function placeOnEmptyStage(rule: RuleReview, item: Step): Promise<void> {
    const next = new Playback();
    playback = next;
    next.subscribe(redraw);
    next.setTheme(theme);
    next.loadSource({ id: `review-${rule.rule_id}`, lesson: { title: rule.rule }, steps: playedSteps(item), done: true });
    await next.settled();
    const span = next.timeline.steps[0];
    if (span) next.seek(span.end);
    redraw();
  }

  function playReveal(): void {
    const current = playback;
    const reveal = current?.timeline.steps[1];
    if (!current || !reveal) return;
    current.seek(reveal.start);
    current.play();
    const advance = (now: number) => {
      current.tick(now);
      if (current === playback && current.state === "playing") requestAnimationFrame(advance);
    };
    requestAnimationFrame(advance);
  }

  function showCase(rule: RuleReview, item: Step): void {
    const outcome = h("p", { class: "comes-back", role: "status" });
    const revealed = h("p", { class: "rule-reveal" });
    const view = buildChallenge(item.challenge!, {
      onAnswer: async (given, correct) => {
        outcome.textContent = "Saving...";
        outcome.className = "comes-back";
        try {
          const reply = await postPracticeAnswer(profile, item.case_id!, given, correct);
          outcome.textContent = `${reply.review.held ? "Held - all three Forms passed. " : reply.correct ? "Passed. " : "Not yet. "}Next is ${nextForm(reply.review)}, ${comesBack(reply.review.due)}.`;
          outcome.className = `comes-back ${reply.correct ? "right" : "wrong"}`;
          revealed.replaceChildren(h("strong", {}, "The Rule: "), reply.review.rule, ` (holds when ${reply.review.condition})`);
          if (item.reveal && !stage.hidden) {
            panel.insertBefore(h("p", { class: "case-say" }, item.reveal.say), outcome);
            playReveal();
          }
          return reply;
        } catch (failure) {
          outcome.textContent = (failure as Error).message;
          outcome.className = "comes-back wrong";
          throw failure;
        }
      },
      onContinue: reload,
    }, { reading: true, form: item.form, say: item.say });
    challengeView = view;
    panel.replaceChildren(
      h("p", { class: "from" }, "From ", h("span", {}, rule.lesson_title ?? "a removed Lesson"), ` - ${nextForm(rule)}`),
      h("p", { class: "case-say" }, item.say),
      view.element,
      outcome,
      revealed);
    panel.querySelector<HTMLElement>("input, textarea")?.focus();
  }

  async function open(rule: RuleReview): Promise<void> {
    challengeView?.dispose();
    challengeView = null;
    lists.hidden = true;
    work.hidden = false;
    stage.hidden = true;
    summary.textContent = nextForm(rule);
    panel.replaceChildren(h("div", { class: "writing", role: "status" }, h("i", { class: "spinner" }), h("div", {}, h("p", { class: "writing-title" }, "Writing a new case for this Rule..."), h("p", { class: "writing-note" }, "It is new each time, so it takes a few seconds."))));
    try {
      const item = await fetchCase(rule.rule_id, profile);
      stage.hidden = !item.scene;
      if (!stage.hidden) await placeOnEmptyStage(rule, item);
      showCase(rule, item);
    } catch (failure) {
      panel.replaceChildren(h("p", { class: "none error" }, (failure as Error).message), h("button", { class: "primary", type: "button", onclick: reload }, "Back to the list"));
    }
  }

  function ruleRow(rule: RuleReview, due: boolean): HTMLElement {
    return h("li", { class: "rule-row" },
      h("div", { class: "rule-text" }, h("p", { class: "rule-statement" }, rule.rule), h("p", { class: "rule-condition" }, `Holds when ${rule.condition}`)),
      h("p", { class: "rule-next" }, h("span", {}, "Next"), nextForm(rule)),
      formPips(rule.passed),
      heldBadge(rule.held),
      due ? h("button", { class: "primary", type: "button", onclick: () => void open(rule) }, "Review") : h("p", { class: "rule-when" }, comesBack(rule.due)));
  }

  function ruleList(title: string, rules: RuleReview[], due: boolean): HTMLElement {
    return h("section", {}, h("h2", {}, `${title} (${rules.length})`), h("ul", { class: "rules" }, ...rules.map((rule) => ruleRow(rule, due))));
  }

  async function start(): Promise<void> {
    challengeView?.dispose();
    challengeView = null;
    work.hidden = true;
    lists.hidden = false;
    const [due, all] = await Promise.all([fetchDue(profile), fetchQueue(profile)]);
    const dueIds = new Set(due.map((rule) => rule.rule_id));
    const later = all.filter((rule) => !dueIds.has(rule.rule_id));
    summary.textContent = due.length ? `${due.length} ${due.length === 1 ? "Rule is" : "Rules are"} due.` : "Nothing due.";
    const next = later.map((rule) => rule.due).sort()[0];
    lists.replaceChildren(
      ...(due.length ? [ruleList("Due now", due, true)] : [h("p", { class: "lede" }, next ? `The next Rule comes back ${comesBack(next)}.` : "Finish a Lesson and its Rule shows up here.")]),
      ...(later.length ? [ruleList("Coming back", later, false)] : []));
  }

  function reload(): void {
    void start().catch((failure: Error) => lists.replaceChildren(h("p", { class: "none error" }, failure.message)));
  }

  return {
    element,
    setTheme: (id) => { theme = id; playback?.setTheme(id); },
    start: reload,
  };
}
