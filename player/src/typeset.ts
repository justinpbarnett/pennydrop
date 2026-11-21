import type katexModule from "katex";
import { fail } from "./lab";

const KATEX_FONTS = ["1em KaTeX_Main", "italic 1em KaTeX_Math", "1em KaTeX_Size1", "1em KaTeX_Size2", "1em KaTeX_AMS", "italic 1em KaTeX_Main"];

let katex: typeof katexModule | null = null;

export async function loadTypesetter(): Promise<void> {
  if (katex) return;
  const [module] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
  katex = module.default;
  await Promise.all(KATEX_FONTS.map((font) => document.fonts.load(font).catch(() => [])));
}

export function typeset(latex: string): string {
  if (!katex) return fail("the math typesetter is not loaded; await prepareStepAssets(step) before adding a Step that uses math");
  return katex.renderToString(latex, { throwOnError: false, output: "html" });
}
