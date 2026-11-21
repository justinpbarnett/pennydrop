import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { fail } from "./lab";

export interface Typeset {
  w: number;
  h: number;
  svg: string;
}

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const document = mathjax.document("", { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: "none" }) });
const cache = new Map<string, Typeset>();

export function typeset(latex: string): Typeset {
  const cached = cache.get(latex);
  if (cached) return cached;
  const markup = adaptor.outerHTML(document.convert(latex, { display: false }));
  const error = /data-mjx-error="([^"]*)"/.exec(markup);
  if (error) return fail(`math "${latex}" is not valid LaTeX: ${error[1]}`);
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(markup);
  if (!box) return fail(`math "${latex}" produced no typeset box`);
  const w = Number(box[1]) / 1000;
  const h = Number(box[2]) / 1000;
  const svg = markup
    .replace(/^<mjx-container[^>]*>/, "")
    .replace(/<\/mjx-container>$/, "")
    .replace(/ style="[^"]*"/, "")
    .replace(/ width="[^"]*" height="[^"]*"/, ` style="display:block"`);
  const result = { w, h, svg };
  cache.set(latex, result);
  return result;
}
