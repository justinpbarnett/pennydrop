import type { HighlighterCore } from "shiki/core";
import { fail, type Role, type Span } from "./lab";

const SENTINELS: Record<string, Role> = {
  "#000001": "ink",
  "#000002": "accent",
  "#000003": "ok",
  "#000004": "swap",
  "#000005": "muted",
  "#000006": "ink",
};

const roleTheme = {
  name: "pennydrop-roles",
  type: "dark" as const,
  fg: "#000001",
  bg: "#000000",
  settings: [
    { settings: { foreground: "#000001" } },
    { scope: ["keyword", "storage", "keyword.control", "storage.type"], settings: { foreground: "#000002" } },
    { scope: ["string", "string.quoted"], settings: { foreground: "#000003" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#000004" } },
    { scope: ["comment"], settings: { foreground: "#000005" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#000006" } },
  ],
};

let highlighter: HighlighterCore | null = null;

export async function loadHighlighter(): Promise<void> {
  if (highlighter) return;
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, c, javascript, python, typescript] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/langs/c"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/typescript"),
  ]);
  highlighter = await createHighlighterCore({
    themes: [roleTheme],
    langs: [...python.default, ...javascript.default, ...typescript.default, ...c.default],
    engine: createJavaScriptRegexEngine(),
  });
}

export const CODE_LANGUAGES = ["python", "javascript", "typescript", "c"];

export function tokenizeCode(source: string, language: string): Span[][] {
  if (!highlighter) return fail("the code highlighter is not loaded; await prepareStepAssets(step) before adding a Step that uses code");
  const lines = highlighter.codeToTokensBase(source, { lang: language, theme: "pennydrop-roles" });
  return lines.map((line) => line.map((token) => ({ text: token.content, role: SENTINELS[(token.color ?? "").toLowerCase().slice(0, 7)] ?? "ink" })));
}
