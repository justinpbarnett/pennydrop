import "katex/dist/katex.min.css";
import "./fonts.css";
import { registerModules } from "./registry";
import { THEMES } from "./theme";

registerModules(import.meta.glob("./{labs,primitives}/*.ts", { eager: true }));

export async function loadFonts(): Promise<void> {
  const families = new Set(Object.values(THEMES).flatMap((theme) => Object.values(theme.fonts).map((font) => font.family.split(",")[0]!.trim())));
  await Promise.all([...families].map((family) => document.fonts.load(`24px ${family}`).catch(() => [])));
  await document.fonts.ready;
}
