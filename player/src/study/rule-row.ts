import { h } from "../dom";
import type { Form } from "../format";
import type { RuleReview } from "../source";

export const FORM_NAMES: Record<Form, string> = { say: "Say", applies: "Applies", fresh: "Fresh" };
const FORMS: Form[] = ["say", "applies", "fresh"];

export function nextForm(review: Pick<RuleReview, "form" | "direction">): string {
  return review.form === "fresh" && review.direction ? `Fresh, ${review.direction}` : FORM_NAMES[review.form];
}

export function formPips(passed: Form[]): HTMLElement {
  return h("ul", { class: "pips", "aria-label": `Forms passed: ${passed.length ? passed.map((form) => FORM_NAMES[form]).join(", ") : "none"}` },
    ...FORMS.map((form) => h("li", { class: passed.includes(form) ? "pip on" : "pip" }, FORM_NAMES[form])));
}

export function heldBadge(held: boolean): HTMLElement {
  return h("span", { class: held ? "badge ready" : "badge" }, held ? "Held" : "Not held yet");
}
