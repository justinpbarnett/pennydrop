import "./fonts.css";
import { registerModules } from "./registry";
import { THEMES } from "./theme";

registerModules(import.meta.glob("./{labs,primitives}/*.ts", { eager: true }));

export async function loadFonts(): Promise<void> {
  const faces = new Set(Object.values(THEMES).flatMap((theme) => Object.values(theme.fonts).map((font) => `${font.weight} 24px ${font.family.split(",")[0]!.trim()}`)));
  await Promise.all([...faces].map((face) => document.fonts.load(face).catch(() => [])));
  await document.fonts.ready;
}
