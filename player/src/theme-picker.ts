import { h } from "./dom";
import { isThemeId, THEME_IDS, THEMES, type ThemeId } from "./theme";

const THEME_KEY = "pennydrop.theme";

function storedTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function rememberTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    return;
  }
}

export function rememberedTheme(): ThemeId {
  const wanted = new URLSearchParams(location.search).get("theme") ?? storedTheme();
  return isThemeId(wanted) ? wanted : "pattern";
}

export function buildSwatches(container: HTMLElement, onPick: (id: ThemeId) => void): void {
  container.replaceChildren(...THEME_IDS.map((id) => {
    const theme = THEMES[id];
    const swatch = h("button", { class: "swatch", type: "button", role: "radio", "data-theme": id, title: theme.name, "aria-label": `${theme.name} theme` },
      h("span", { class: "chip", style: `background:${theme.colors.ground};border-color:${theme.colors.rule}` }, h("i", { style: `background:${theme.colors.accent}` })),
      h("span", { class: "label" }, theme.name));
    swatch.addEventListener("click", () => onPick(id));
    return swatch;
  }));
}

export function markSwatches(id: ThemeId): void {
  document.querySelectorAll<HTMLButtonElement>(".swatch").forEach((swatch) => swatch.setAttribute("aria-checked", String(swatch.dataset.theme === id)));
}
