import "./app.css";
import "./study.css";
import { loadFonts } from "./boot";
import { h } from "./dom";
import { resolveProfileId } from "./source";
import type { ThemeId } from "./theme";
import { applyThemeVars } from "./theme-css";
import { buildSwatches, markSwatches, rememberedTheme, rememberTheme } from "./theme-picker";
import { courseDetail, courseList } from "./study/courses-view";
import { buildReviewView, type ReviewView } from "./study/review-view";

const query = new URLSearchParams(location.search);
const view = document.querySelector<HTMLElement>("#view")!;
const nav = document.querySelector<HTMLElement>("#nav")!;
let themeId: ThemeId = rememberedTheme();
let review: ReviewView | null = null;

function applyTheme(id: ThemeId): void {
  themeId = id;
  applyThemeVars(id);
  rememberTheme(id);
  markSwatches(id);
  review?.setTheme(id);
}

const section = query.has("course") ? "courses" : query.get("view") === "review" ? "review" : "courses";
nav.replaceChildren(
  h("a", { href: "?view=courses", "aria-current": section === "courses" ? "page" : false }, "Courses"),
  h("a", { href: "?view=review", "aria-current": section === "review" ? "page" : false }, "Review"));

buildSwatches(document.querySelector<HTMLElement>("#themes")!, applyTheme);
applyTheme(themeId);
await loadFonts();
document.title = `${section === "review" ? "Review" : "Courses"} - Pennydrop`;

try {
  const profile = await resolveProfileId(query.has("profile") ? Number(query.get("profile")) : null);
  if (section === "review") {
    if (profile === null) {
      view.replaceChildren(h("p", { class: "none" }, "There is no adult Profile yet, so there is nothing to review. Add one with pd profile add --kind adult."));
    } else {
      review = buildReviewView(profile, themeId);
      view.replaceChildren(review.element);
      review.start();
    }
  } else {
    view.replaceChildren(query.has("course") ? await courseDetail(query.get("course")!, profile) : await courseList(profile));
  }
} catch (failure) {
  view.replaceChildren(h("p", { class: "none error" }, (failure as Error).message));
}
