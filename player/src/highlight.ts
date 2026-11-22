import type { HighlighterCore } from "shiki/core";
import { type Drawable, fail, type Role, type Span, stringField, textDrawable } from "./lab";
import { textWidth } from "./text-metrics";

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
let loading: Promise<void> | null = null;

async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, c, javascript, python, typescript] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/langs/c"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/typescript"),
  ]);
  return createHighlighterCore({
    themes: [roleTheme],
    langs: [...python.default, ...javascript.default, ...typescript.default, ...c.default],
    engine: createJavaScriptRegexEngine(),
  });
}

export function loadHighlighter(): Promise<void> {
  loading ??= createHighlighter().then(
    (created) => {
      highlighter = created;
    },
    (error) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export const CODE_LANGUAGES = ["python", "javascript", "typescript", "c"];

export function languageField(spec: Record<string, unknown>, objectId: string): string {
  const language = stringField(spec, "language", objectId, "python");
  if (!CODE_LANGUAGES.includes(language)) fail(`${objectId}: language "${language}" is not available; use one of ${CODE_LANGUAGES.join(", ")}`);
  return language;
}

const NUMBER_LITERAL = /(?<![\w.])(?:0[xX][\da-fA-F_]*(?:\.[\da-fA-F_]*)?(?:[pP][+-]?\d+)?|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[uUlLfFjJn]*(?!\w)/g;
const NUMBER_ROLE: Role = "swap";
const STRING_AND_COMMENT_ROLES: readonly Role[] = ["ok", "muted"];

function withWholeNumbers(spans: Span[]): Span[] {
  const text = spans.map((span) => span.text).join("");
  const roles = spans.flatMap((span) => Array.from({ length: span.text.length }, () => span.role));
  for (const match of text.matchAll(NUMBER_LITERAL)) {
    const range = roles.slice(match.index, match.index + match[0].length);
    if (!range.some((role) => STRING_AND_COMMENT_ROLES.includes(role))) roles.fill(NUMBER_ROLE, match.index, match.index + match[0].length);
  }
  const merged: Span[] = [];
  text.split("").forEach((char, index) => {
    const last = merged[merged.length - 1];
    if (last && last.role === roles[index]) last.text += char;
    else merged.push({ text: char, role: roles[index]! });
  });
  return merged;
}

export function tokenizeCode(source: string, language: string): Span[][] {
  if (!highlighter) return fail("the code highlighter is not loaded; await prepareStepAssets(step) before adding a Step that uses code");
  const lines = highlighter.codeToTokensBase(source, { lang: language, theme: "pennydrop-roles" });
  return lines.map((line) => withWholeNumbers(line.map((token) => ({ text: token.content, role: SENTINELS[(token.color ?? "").toLowerCase().slice(0, 7)] ?? "ink" }))));
}

const ELLIPSIS = "…";

export function fitted(text: string, size: number, width: number): string {
  if (textWidth(text, size, "code") <= width) return text;
  let kept = text.length;
  while (kept > 0 && textWidth(text.slice(0, kept) + ELLIPSIS, size, "code") > width) kept -= 1;
  return text.slice(0, kept) + ELLIPSIS;
}

export function topLevelItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if ("[({".includes(char)) depth += 1;
    else if ("])}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(text.slice(start).trim());
  return items;
}

function elideItems(text: string, size: number, width: number): string | null {
  const open = text.indexOf("[");
  const close = text.lastIndexOf("]");
  const bracketed = open >= 0 && close === text.length - 1 && !/^[^\[]*\(/.test(text.slice(0, open));
  if (!bracketed) return null;
  const items = topLevelItems(text.slice(open + 1, close));
  for (let kept = items.length - 1; kept >= 2; kept -= 1) {
    const head = Math.ceil((kept - 1) / 2);
    const tail = kept - 1 - head;
    const candidate = `${text.slice(0, open + 1)}${[...items.slice(0, head), "…", ...items.slice(items.length - Math.max(tail, 1))].join(", ")}]`;
    if (textWidth(candidate, size, "code") <= width) return candidate;
  }
  return null;
}

export function elideMiddle(text: string, size: number, width: number): string {
  if (textWidth(text, size, "code") <= width) return text;
  const byItems = elideItems(text, size, width);
  if (byItems) return byItems;
  let keep = text.length - 1;
  while (keep > 1) {
    const head = Math.ceil(keep / 2);
    const candidate = `${text.slice(0, head)}${ELLIPSIS}${text.slice(text.length - (keep - head))}`;
    if (textWidth(candidate, size, "code") <= width) return candidate;
    keep -= 1;
  }
  return ELLIPSIS;
}

function fittedSpans(spans: Span[], size: number, width: number): Span[] {
  const text = spans.map((span) => span.text).join("");
  if (textWidth(text, size, "code") <= width) return spans;
  const kept = fitted(text, size, width).length - ELLIPSIS.length;
  const out: Span[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= kept) break;
    out.push({ ...span, text: span.text.slice(0, kept - used) });
    used += span.text.length;
  }
  return [...out, { text: ELLIPSIS, role: "muted" }];
}

export const NUMBER_SCALE = 0.86;

export interface ListingLook {
  left: number;
  top: number;
  size: number;
  lineHeight: number;
  gutter: number;
  lineWidth?: number;
  opacityOf?: (line: number) => number;
}

export function codeListing(lines: Span[][], look: ListingLook): Drawable[] {
  return lines.flatMap((spans, index) => {
    const y = look.top + (index + 0.5) * look.lineHeight;
    const opacity = look.opacityOf ? { opacity: look.opacityOf(index + 1) } : {};
    const shown = look.lineWidth === undefined ? spans : fittedSpans(spans, look.size, look.lineWidth);
    return [
      textDrawable(`number-${index + 1}`, String(index + 1), { x: look.left, y }, { size: look.size * NUMBER_SCALE, font: "code", anchor: "start", fill: "muted", z: 2, ...opacity }),
      { id: `line-${index + 1}`, kind: "code" as const, x: look.left + look.gutter, y, spans: shown.length ? shown : [{ text: " ", role: "ink" as const }], size: look.size, font: "code" as const, anchor: "start" as const, z: 2, ...opacity },
    ];
  });
}
