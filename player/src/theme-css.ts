import { THEMES, type ThemeId } from "./theme";

export function applyThemeVars(id: ThemeId): void {
  const theme = THEMES[id];
  const root = document.documentElement;
  root.dataset.theme = id;
  for (const [role, value] of Object.entries(theme.colors)) root.style.setProperty(`--${role}`, value);
  root.style.setProperty("--font-mark", theme.fonts.mark.family);
  root.style.setProperty("--font-read", theme.fonts.read.family);
  root.style.setProperty("--weight-mark", String(theme.fonts.mark.weight));
  root.style.setProperty("--tracking-mark", `${theme.fonts.mark.tracking}em`);
  root.style.setProperty("--corner", `${theme.corner}px`);
  root.style.setProperty("--mark-case", theme.capitalMarks ? "uppercase" : "none");
  root.style.setProperty("--stroke", `${theme.stroke}px`);
}
