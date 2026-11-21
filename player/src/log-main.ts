import "./app.css";
import "./log.css";
import { h } from "./dom";
import { applyThemeVars } from "./theme-css";

interface Profile {
  id: number;
  name: string;
  kind: string;
}

interface Log {
  profile: Profile;
  asks: { transcript: string; lesson_id: string; at: string }[];
  lessons: { lesson_id: string; title: string | null; status: string | null; at: string; seconds: number | null; cost_usd: number | null }[];
  answers: { lesson_id: string; step: number; answer: unknown; correct: boolean; at: string }[];
}

const root = document.querySelector<HTMLElement>("#log")!;
applyThemeVars("pattern");

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const seconds = (value: number | null) => (value === null ? "-" : `${value.toFixed(1)} s`);
const dollars = (value: number | null) => (value === null ? "-" : `$${value.toFixed(4)}`);
const lessonLink = (id: string, label: string) => h("a", { href: `/?lesson=${encodeURIComponent(id)}` }, label);

function table(headings: string[], rows: (Node | string)[][], empty: string): HTMLElement {
  if (rows.length === 0) return h("p", { class: "none" }, empty);
  return h("table", {}, h("thead", {}, h("tr", {}, ...headings.map((heading) => h("th", {}, heading)))),
    h("tbody", {}, ...rows.map((row) => h("tr", {}, ...row.map((cell) => h("td", {}, cell))))));
}

function section(title: string, body: HTMLElement): HTMLElement {
  return h("section", {}, h("h2", {}, title), body);
}

function show(log: Log): void {
  const answered = log.answers.filter((answer) => answer.correct).length;
  root.replaceChildren(
    section("Asks", table(["When", "Transcript"], log.asks.map((ask) => [when(ask.at), lessonLink(ask.lesson_id, ask.transcript)]), "No Asks yet.")),
    section("Lessons", table(["When", "Title", "Status", "Time to finish", "Cost"],
      log.lessons.map((lesson) => [when(lesson.at), lessonLink(lesson.lesson_id, lesson.title ?? lesson.lesson_id), lesson.status ?? "-", seconds(lesson.seconds), dollars(lesson.cost_usd)]), "No Lessons yet.")),
    section(`Challenge answers (${answered} of ${log.answers.length} right)`, table(["When", "Lesson", "Step", "Answer", "Result"],
      log.answers.map((answer) => [when(answer.at), lessonLink(answer.lesson_id, answer.lesson_id), String(answer.step), JSON.stringify(answer.answer), answer.correct ? "right" : "wrong"]), "No answers yet.")),
  );
}

async function load(): Promise<void> {
  const profiles = (await (await fetch("/api/profiles")).json()) as Profile[];
  const wanted = Number(new URLSearchParams(location.search).get("profile"));
  const profile = profiles.find((candidate) => candidate.id === wanted) ?? profiles[0];
  if (!profile) {
    root.replaceChildren(h("h1", {}, "Lesson log"), h("p", { class: "none" }, "There are no Profiles yet."));
    return;
  }
  const select = h("select", { "aria-label": "Profile" }, ...profiles.map((candidate) => h("option", { value: String(candidate.id), selected: candidate.id === profile.id }, `${candidate.name} (${candidate.kind})`)));
  select.addEventListener("change", () => { location.search = `?profile=${select.value}`; });
  const log = (await (await fetch(`/api/profiles/${profile.id}/log`)).json()) as Log;
  show(log);
  root.prepend(h("header", {}, h("a", { class: "back", href: "/" }, "Pennydrop"), h("h1", {}, "Lesson log"), select));
}

await load();
