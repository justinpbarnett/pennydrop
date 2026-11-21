import type { FontRole, Role } from "./lab";

export const THEME_IDS = ["pattern", "film", "kids", "plain"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemeFont {
  family: string;
  weight: number;
  tracking: number;
}

export type BackdropKind = "flat" | "grain" | "paper" | "grid";

export interface Theme {
  id: ThemeId;
  name: string;
  colors: Record<Role, string>;
  fonts: Record<FontRole, ThemeFont>;
  capitalMarks: boolean;
  stroke: number;
  corner: number;
  ease: string;
  motionScale: number;
  backdrop: { kind: BackdropKind; vignette: number; glow: number };
  film?: { soundKit: string; voice: string };
}

const codeFont: ThemeFont = { family: "'JetBrains Mono', ui-monospace, monospace", weight: 400, tracking: 0 };
const mathFont: ThemeFont = { family: "KaTeX_Main, 'Times New Roman', serif", weight: 400, tracking: 0 };

export const THEMES: Record<ThemeId, Theme> = {
  pattern: {
    id: "pattern",
    name: "Pattern",
    colors: {
      ground: "#0B0C0E", ink: "#E7E5DF", muted: "#9C9A93", rule: "#2B2C31",
      accent: "#FFD60A", active: "#FFD60A", compare: "#FFD60A", swap: "#E7E5DF",
      done: "#22C55E", ok: "#22C55E", warn: "#FFD60A", fault: "#E5484D",
      fill: "#141519", fill2: "#202127", highlight: "#FFD60A", edge: "#5A5B63",
    },
    fonts: {
      mark: { family: "'Routed Gothic', 'JetBrains Mono', sans-serif", weight: 400, tracking: 0.06 },
      read: { family: "'JetBrains Mono', ui-monospace, monospace", weight: 400, tracking: 0 },
      code: codeFont,
      math: mathFont,
    },
    capitalMarks: true,
    stroke: 1.5,
    corner: 0,
    ease: "power2.inOut",
    motionScale: 0.85,
    backdrop: { kind: "grid", vignette: 0.25, glow: 0 },
  },
  film: {
    id: "film",
    name: "Film",
    colors: {
      ground: "#08070A", ink: "#F3E9D2", muted: "#B3A582", rule: "#3B3322",
      accent: "#E2B253", active: "#F6CE6E", compare: "#F6CE6E", swap: "#FFF4D6",
      done: "#9BC57C", ok: "#9BC57C", warn: "#EBAA45", fault: "#E8705A",
      fill: "#15120C", fill2: "#241E12", highlight: "#FFDC93", edge: "#7C6A3E",
    },
    fonts: {
      mark: { family: "'Cormorant Garamond', Georgia, serif", weight: 600, tracking: 0.02 },
      read: { family: "'Cormorant Garamond', Georgia, serif", weight: 600, tracking: 0.01 },
      code: codeFont,
      math: mathFont,
    },
    capitalMarks: false,
    stroke: 1.4,
    corner: 3,
    ease: "power3.inOut",
    motionScale: 1.3,
    backdrop: { kind: "grain", vignette: 0.7, glow: 0.35 },
    film: { soundKit: "warm-hall", voice: "narrator-low" },
  },
  kids: {
    id: "kids",
    name: "Kids",
    colors: {
      ground: "#FFF4DA", ink: "#2A1A4D", muted: "#66558A", rule: "#8E73C2",
      accent: "#FF6B35", active: "#FF6B35", compare: "#1E7FE0", swap: "#D81B8A",
      done: "#1FA867", ok: "#1FA867", warn: "#E59A00", fault: "#D93036",
      fill: "#FFFFFF", fill2: "#FFE08A", highlight: "#FFCB2E", edge: "#8E73C2",
    },
    fonts: {
      mark: { family: "'Fredoka', 'Nunito', sans-serif", weight: 600, tracking: 0.01 },
      read: { family: "'Fredoka', 'Nunito', sans-serif", weight: 500, tracking: 0.01 },
      code: codeFont,
      math: mathFont,
    },
    capitalMarks: false,
    stroke: 2.4,
    corner: 26,
    ease: "back.inOut(1.3)",
    motionScale: 0.95,
    backdrop: { kind: "paper", vignette: 0, glow: 0 },
  },
  plain: {
    id: "plain",
    name: "Plain",
    colors: {
      ground: "#FFFFFF", ink: "#16181D", muted: "#5B6370", rule: "#CBD1DB",
      accent: "#2F6FEB", active: "#2F6FEB", compare: "#2F6FEB", swap: "#7C4DDB",
      done: "#18864C", ok: "#18864C", warn: "#A86A0A", fault: "#D12F38",
      fill: "#F3F5F8", fill2: "#E3E9F3", highlight: "#CFE0FF", edge: "#9AA3B2",
    },
    fonts: {
      mark: { family: "'Inter', system-ui, sans-serif", weight: 600, tracking: 0 },
      read: { family: "'Inter', system-ui, sans-serif", weight: 400, tracking: 0 },
      code: codeFont,
      math: mathFont,
    },
    capitalMarks: false,
    stroke: 1.5,
    corner: 8,
    ease: "power2.inOut",
    motionScale: 0.9,
    backdrop: { kind: "flat", vignette: 0, glow: 0 },
  },
};

export type Rgba = [number, number, number, number];

export function parseHex(hex: string): Rgba {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 1];
}

export function cssRgba([r, g, b, a]: Rgba): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a.toFixed(3)})`;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}
