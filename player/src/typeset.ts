import { fail } from "./lab";

export interface Typeset {
  w: number;
  h: number;
  svg: string;
}

interface Transform {
  scaleX: number;
  scaleY: number;
  shiftX: number;
  shiftY: number;
}

interface Ink {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const IDENTITY: Transform = { scaleX: 1, scaleY: 1, shiftX: 0, shiftY: 0 };

function compose(outer: Transform, attribute: string): Transform {
  let inner = outer;
  for (const [, name, values] of attribute.matchAll(/([A-Za-z]+)\(([^)]*)\)/g)) {
    if (name !== "translate" && name !== "scale") return fail(`math uses the unsupported transform "${name}"`);
    const [first = 0, second = name === "translate" ? 0 : first] = values!.trim().split(/[\s,]+/).map(Number);
    inner = name === "translate"
      ? { ...inner, shiftX: inner.shiftX + inner.scaleX * first, shiftY: inner.shiftY + inner.scaleY * second }
      : { ...inner, scaleX: inner.scaleX * first, scaleY: inner.scaleY * second };
  }
  return inner;
}

function include(ink: Ink, transform: Transform, x: number, y: number): void {
  const mappedX = transform.shiftX + transform.scaleX * x;
  const mappedY = transform.shiftY + transform.scaleY * y;
  ink.minX = Math.min(ink.minX, mappedX);
  ink.maxX = Math.max(ink.maxX, mappedX);
  ink.minY = Math.min(ink.minY, mappedY);
  ink.maxY = Math.max(ink.maxY, mappedY);
}

type Point = [number, number];

function includeQuadratic(ink: Ink, transform: Transform, from: Point, control: Point, to: Point): void {
  const at = (t: number): Point => [0, 1].map((axis) => (1 - t) * (1 - t) * from[axis]! + 2 * (1 - t) * t * control[axis]! + t * t * to[axis]!) as Point;
  include(ink, transform, ...from);
  include(ink, transform, ...to);
  for (const axis of [0, 1]) {
    const denominator = from[axis]! - 2 * control[axis]! + to[axis]!;
    const t = denominator === 0 ? -1 : (from[axis]! - control[axis]!) / denominator;
    if (t > 0 && t < 1) include(ink, transform, ...at(t));
  }
}

function includePath(ink: Ink, transform: Transform, data: string): void {
  const tokens = data.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let at: Point = [0, 0];
  let start: Point = [0, 0];
  let control: Point = [0, 0];
  let command = "";
  let index = 0;
  const number = () => Number(tokens[index++]);
  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index]!)) command = tokens[index++]!;
    if (command === "Z") {
      at = start;
      continue;
    }
    if (command === "M" || command === "L") {
      at = [number(), number()];
      if (command === "M") {
        start = at;
        command = "L";
      }
      include(ink, transform, ...at);
    } else if (command === "H") {
      at = [number(), at[1]];
      include(ink, transform, ...at);
    } else if (command === "V") {
      at = [at[0], number()];
      include(ink, transform, ...at);
    } else if (command === "Q" || command === "T") {
      const next: Point = command === "Q" ? [number(), number()] : [2 * at[0] - control[0], 2 * at[1] - control[1]];
      const to: Point = [number(), number()];
      includeQuadratic(ink, transform, at, next, to);
      control = next;
      at = to;
    } else if (command === "C" || command === "S") {
      const first: Point = command === "C" ? [number(), number()] : [2 * at[0] - control[0], 2 * at[1] - control[1]];
      const second: Point = [number(), number()];
      const to: Point = [number(), number()];
      for (let step = 1; step <= 16; step++) {
        const t = step / 16;
        const u = 1 - t;
        include(ink, transform, u ** 3 * at[0] + 3 * u * u * t * first[0] + 3 * u * t * t * second[0] + t ** 3 * to[0], u ** 3 * at[1] + 3 * u * u * t * first[1] + 3 * u * t * t * second[1] + t ** 3 * to[1]);
      }
      control = second;
      at = to;
    } else {
      return fail(`math path uses the unsupported command "${command}"`);
    }
  }
}

function inkOf(markup: string): Ink {
  const ink: Ink = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const stack: Transform[] = [IDENTITY];
  for (const [tag] of markup.matchAll(/<\/g>|<(?:g|path|rect)\b[^>]*>/g)) {
    if (tag === "</g>") {
      stack.pop();
      continue;
    }
    const current = compose(stack[stack.length - 1]!, /transform="([^"]*)"/.exec(tag)?.[1] ?? "");
    if (tag.startsWith("<g")) stack.push(current);
    else if (tag.startsWith("<path")) includePath(ink, current, /\sd="([^"]*)"/.exec(tag)![1]!);
    else {
      const attribute = (name: string) => Number(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? 0);
      const [x, y, width, height] = [attribute("x"), attribute("y"), attribute("width"), attribute("height")];
      include(ink, current, x, y);
      include(ink, current, x + width, y + height);
    }
  }
  return ink;
}

type Converter = (latex: string) => string;

let converter: Converter | null = null;
let loading: Promise<void> | null = null;
const cache = new Map<string, Typeset>();

async function createConverter(): Promise<Converter> {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
    import("mathjax-full/js/mathjax.js"),
    import("mathjax-full/js/input/tex.js"),
    import("mathjax-full/js/output/svg.js"),
    import("mathjax-full/js/adaptors/liteAdaptor.js"),
    import("mathjax-full/js/handlers/html.js"),
    import("mathjax-full/js/input/tex/AllPackages.js"),
  ]);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: "none" }) });
  return (latex) => adaptor.outerHTML(document.convert(latex, { display: false }));
}

export function loadMath(): Promise<void> {
  loading ??= createConverter().then(
    (created) => {
      converter = created;
    },
    (error) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export function typeset(latex: string): Typeset {
  const cached = cache.get(latex);
  if (cached) return cached;
  if (!converter) return fail("MathJax is not loaded; await prepareStepAssets(step) before adding a Step that uses math");
  const markup = converter(latex);
  const error = /data-mjx-error="([^"]*)"/.exec(markup);
  if (error) return fail(`math "${latex}" is not valid LaTeX: ${error[1]}`);
  const ink = inkOf(markup);
  if (!Number.isFinite(ink.minX)) return fail(`math "${latex}" produced no ink`);
  const w = (ink.maxX - ink.minX) / 1000;
  const h = (ink.maxY - ink.minY) / 1000;
  const svg = markup
    .replace(/^<mjx-container[^>]*>/, "")
    .replace(/<\/mjx-container>$/, "")
    .replace(/ style="[^"]*"/, "")
    .replace(/viewBox="[^"]*"/, `viewBox="${ink.minX} ${ink.minY} ${ink.maxX - ink.minX} ${ink.maxY - ink.minY}"`)
    .replace(/ width="[^"]*" height="[^"]*"/, ` style="display:block"`);
  const result = { w, h, svg };
  cache.set(latex, result);
  return result;
}
