import { buildChallenge, type ChallengeView } from "../challenge-ui";
import { h } from "../dom";
import { headerOf } from "../ask-client";
import type { Step } from "../format";
import { Playback } from "../playback";
import { StageRenderer } from "../render";
import { THEMES, type ThemeId } from "../theme";
import { answerReview, comesBack, fetchDue, fetchLessonDocument, fetchQueue, type ReviewItem } from "./api";

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
  svg.setAttribute("aria-label", "The Step the Challenge was asked on");
  const renderer = new StageRenderer(svg);
  const summary = h("p", { class: "review-count", role: "status" });
  const panel = h("div", { class: "review-panel" });
  const stage = h("div", { class: "review-stage" }, svg);
  const work = h("div", { class: "review-work" }, stage, panel);
  const queue = h("div", { class: "queue" });
  const element = h("div", { class: "review" }, h("h1", {}, "Review"), summary, work, queue);

  const redraw = () => playback && renderer.draw(playback.frame(), THEMES[theme]);
  svg.addEventListener("click", (event) => {
    const part = renderer.partAt(event.target);
    if (part) challengeView?.acceptPart(part);
  });

  async function replay(item: ReviewItem): Promise<void> {
    const document = await fetchLessonDocument(item.lesson_id);
    const next = new Playback();
    playback = next;
    next.subscribe(redraw);
    next.setTheme(theme);
    next.loadSource({ id: item.lesson_id, lesson: headerOf(document), steps: document.steps as Step[], done: true });
    await next.settled();
    const span = next.timeline.steps.find((candidate) => candidate.step.step === item.step_n);
    if (span) next.seek(span.end);
    redraw();
  }

  function showCard(item: ReviewItem, remaining: ReviewItem[]): void {
    const comes = h("p", { class: "comes-back", role: "status" });
    const view = buildChallenge(item.prompt, {
      onAnswer: (given, correct) => {
        comes.textContent = "Saving...";
        answerReview(item.id, given, correct).then(
          (saved) => { comes.textContent = `${correct ? "Right" : "Wrong"} - this one comes back ${comesBack(saved.due)}.`; comes.className = `comes-back ${correct ? "right" : "wrong"}`; },
          (failure: Error) => { comes.textContent = failure.message; comes.className = "comes-back wrong"; },
        );
      },
      onContinue: () => { void (remaining.length ? open(remaining) : start()); },
    });
    challengeView = view;
    panel.replaceChildren(
      h("p", { class: "from" }, h("span", {}, item.lesson_title), ` - Step ${item.step_n}`),
      view.element,
      comes);
    panel.querySelector<HTMLInputElement>("input")?.focus();
  }

  async function open(items: ReviewItem[]): Promise<void> {
    const [item, ...rest] = items;
    if (!item) return;
    work.hidden = false;
    summary.textContent = `${items.length} due`;
    await replay(item);
    showCard(item, rest);
  }

  async function start(): Promise<void> {
    const [due, all] = await Promise.all([fetchDue(profile), fetchQueue(profile)]);
    renderQueue(all);
    challengeView = null;
    if (due.length === 0) {
      work.hidden = true;
      const next = all.map((item) => item.due).sort()[0];
      summary.textContent = "Nothing due.";
      queue.prepend(h("p", { class: "lede" }, next ? `The next one comes back ${comesBack(next)}.` : "Answer a Challenge in a Lesson and it shows up here."));
      return;
    }
    await open(due);
  }

  function renderQueue(items: ReviewItem[]): void {
    const now = new Date();
    queue.replaceChildren(
      h("h2", {}, `Queue (${items.length})`),
      items.length === 0 ? h("p", { class: "none" }, "No Challenges scheduled yet.") : h("table", {},
        h("thead", {}, h("tr", {}, ...["Lesson", "Step", "Kind", "Reviews", "Comes back"].map((heading) => h("th", {}, heading)))),
        h("tbody", {}, ...items.map((item) => h("tr", {},
          h("td", {}, h("a", { href: `/?lesson=${encodeURIComponent(item.lesson_id)}` }, item.lesson_title)),
          h("td", {}, String(item.step_n)),
          h("td", {}, item.type),
          h("td", {}, String(item.schedule.reps)),
          h("td", { class: new Date(item.due) <= now ? "due" : "" }, comesBack(item.due, now)))))));
  }

  return {
    element,
    setTheme: (id) => { theme = id; playback?.setTheme(id); },
    start: () => void start(),
  };
}
