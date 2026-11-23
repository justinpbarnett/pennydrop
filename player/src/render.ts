import type { Frame, Painted } from "./frame";
import type { DrawableKind } from "./lab";
import { ARROW_HEAD_ANGLE, arrowHeadLength } from "./ink";
import { STAGE } from "./layout";
import { cssRgba, parseHex, type Theme, type ThemeId } from "./theme";
import { typeset } from "./typeset";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRAIN_FRAMES_PER_SECOND = 12;
const FINGER_REACH = 32;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function setAttributes(element: Element, attributes: Record<string, string | number | null>): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, String(value));
  }
}

const paintCss = (paint: Painted["fill"]) => (paint ? cssRgba(paint) : "none");

function place(parent: SVGElement, child: SVGElement, index: number): void {
  if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
}

function arrowPath(item: Painted): string {
  const [x2, y2] = [item.x2!, item.y2!];
  const angle = Math.atan2(y2 - item.y, x2 - item.x);
  const head = arrowHeadLength(item.strokeWidth);
  const wing = (offset: number) => `${x2 - head * Math.cos(angle + offset)} ${y2 - head * Math.sin(angle + offset)}`;
  return `M${item.x} ${item.y} L${x2} ${y2} M${wing(ARROW_HEAD_ANGLE)} L${x2} ${y2} L${wing(-ARROW_HEAD_ANGLE)}`;
}

function polyline(points: number[], closed: boolean): string {
  const pairs = points.reduce<string[]>((list, value, index) => (index % 2 === 0 ? [...list, `${value} ${points[index + 1]}`] : list), []);
  return `M${pairs.join(" L")}${closed ? " Z" : ""}`;
}

const decodings = new Map<string, Promise<void>>();
const decoded = new Set<string>();

function decodeImage(href: string): Promise<void> {
  let decoding = decodings.get(href);
  if (!decoding) {
    const image = new Image();
    image.src = href;
    decoding = image.decode().then(
      () => { decoded.add(href); },
      () => { throw new Error(`image ${href} did not load or decode`); },
    );
    decodings.set(href, decoding);
  }
  return decoding;
}

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

interface Live {
  element: SVGElement;
  kind: string;
  signature: string;
  clip: SVGClipPathElement | null;
}

const imagesInFrame = new Set<string>();

interface KindRenderer {
  create(): SVGElement;
  update(element: SVGElement, item: Painted, live: Live): void;
}

const strokeOf = (item: Painted) => ({ fill: paintCss(item.fill), stroke: paintCss(item.stroke), "stroke-width": item.strokeWidth });

function dashOf(item: Painted) {
  return item.draw !== undefined && item.draw < 1
    ? { pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 - Math.max(0, item.draw) }
    : { pathLength: null, "stroke-dasharray": null, "stroke-dashoffset": null };
}

function fontOf(item: Painted) {
  return { "font-size": item.size, "font-family": item.fontFamily, "font-weight": item.fontWeight, "letter-spacing": `${item.tracking}em`, "text-anchor": item.anchor };
}

function createPath(): SVGElement {
  return svg("path", { "stroke-linecap": "round", "stroke-linejoin": "round" });
}

function updateImage(holder: SVGElement, item: Painted): void {
  const [w, h] = [item.w ?? 0, item.h ?? 0];
  const href = item.href ?? "";
  const { crop } = item;
  setAttributes(holder, {
    x: item.x - w / 2,
    y: item.y - h / 2,
    width: w,
    height: h,
    viewBox: crop ? `${crop.x} ${crop.y} ${crop.w} ${crop.h}` : `0 0 ${w} ${h}`,
    preserveAspectRatio: "none",
  });
  const picture = holder.firstElementChild!;
  setAttributes(picture, crop
    ? { x: 0, y: 0, width: 1, height: 1, href, preserveAspectRatio: "none" }
    : { x: 0, y: 0, width: w, height: h, href, preserveAspectRatio: "xMidYMid meet" });
  imagesInFrame.add(href);
  if (decoded.has(href)) {
    holder.removeAttribute("visibility");
    return;
  }
  holder.setAttribute("visibility", "hidden");
  decodeImage(href).then(() => {
    if (picture.getAttribute("href") === href) holder.removeAttribute("visibility");
  }, () => undefined);
}

const DRAWABLE_KINDS: Record<DrawableKind, KindRenderer> = {
  rect: {
    create: () => svg("rect"),
    update(element, item) {
      const [w, h] = [item.w ?? 0, item.h ?? 0];
      setAttributes(element, { x: item.x - w / 2, y: item.y - h / 2, width: w, height: h, rx: Math.min(item.radius, Math.min(w, h) / 2), ...strokeOf(item) });
    },
  },
  circle: {
    create: () => svg("circle"),
    update: (element, item) => setAttributes(element, { cx: item.x, cy: item.y, r: Math.max(0, item.r ?? 0), ...strokeOf(item) }),
  },
  line: {
    create: () => svg("line", { "stroke-linecap": "round" }),
    update: (element, item) => setAttributes(element, { x1: item.x, y1: item.y, x2: item.x2!, y2: item.y2!, ...strokeOf(item), fill: "none", ...dashOf(item) }),
  },
  arrow: {
    create: createPath,
    update: (element, item) => setAttributes(element, { d: arrowPath(item), ...strokeOf(item), fill: "none", ...dashOf(item) }),
  },
  path: {
    create: createPath,
    update: (element, item) => setAttributes(element, { d: polyline(item.points ?? [], Boolean(item.closed)), ...strokeOf(item), ...dashOf(item) }),
  },
  text: {
    create: () => svg("text", { "dominant-baseline": "central" }),
    update(element, item) {
      element.textContent = item.text ?? "";
      setAttributes(element, { x: item.x, y: item.y, ...fontOf(item), fill: paintCss(item.fill) });
      element.style.fontVariantNumeric = "lining-nums tabular-nums";
    },
  },
  code: {
    create: () => svg("text", { "dominant-baseline": "central", style: "white-space:pre" }),
    update(element, item, live) {
      const signature = JSON.stringify(item.spans);
      if (signature !== live.signature) {
        live.signature = signature;
        element.replaceChildren(...(item.spans ?? []).map((span) => {
          const tspan = svg("tspan", { fill: cssRgba(span.color) });
          tspan.textContent = span.text;
          return tspan;
        }));
      }
      setAttributes(element, { x: item.x, y: item.y, ...fontOf(item) });
    },
  },
  math: {
    create() {
      const object = svg("foreignObject");
      const holder = document.createElement("div");
      holder.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;white-space:nowrap";
      object.append(holder);
      return object;
    },
    update(element, item, live) {
      const [w, h] = [item.w ?? 400, item.h ?? 100];
      setAttributes(element, { x: item.x - w / 2, y: item.y - h / 2, width: w, height: h });
      const holder = element.firstElementChild as HTMLElement;
      if (live.signature !== item.latex) {
        live.signature = item.latex ?? "";
        holder.innerHTML = typeset(item.latex ?? "").svg;
      }
      const svgElement = holder.firstElementChild;
      if (svgElement) setAttributes(svgElement as SVGElement, { width: w, height: h });
      holder.style.color = paintCss(item.fill);
    },
  },
  image: {
    create() {
      const holder = svg("svg", { overflow: "hidden" });
      holder.append(svg("image"));
      return holder;
    },
    update: updateImage,
  },
};

export class StageRenderer {
  private readonly camera = svg("g");
  private readonly backdrop = svg("g");
  private readonly defs = svg("defs");
  private readonly clips = svg("defs");
  private readonly live = new Map<string, Live>();
  private readonly layers = new Map<string, SVGGElement>();
  private clipCount = 0;
  private grainSeed: SVGElement | null = null;
  private backdropTheme: ThemeId | null = null;

  constructor(private readonly root: SVGSVGElement) {
    root.setAttribute("viewBox", `0 0 ${STAGE.w} ${STAGE.h}`);
    root.setAttribute("preserveAspectRatio", "xMidYMid meet");
    root.replaceChildren(this.defs, this.clips, this.backdrop, this.camera);
  }

  draw(frame: Frame, theme: Theme): void {
    if (this.backdropTheme !== theme.id) this.buildBackdrop(theme);
    this.grainSeed?.setAttribute("seed", String(Math.floor(frame.time * GRAIN_FRAMES_PER_SECOND) % 997));
    const { cx, cy, zoom } = frame.camera;
    this.camera.setAttribute("transform", `translate(${STAGE.w / 2} ${STAGE.h / 2}) scale(${zoom}) translate(${-cx} ${-cy})`);

    const wanted = new Set<string>();
    const filled = new Map<string, number>();
    let slot = 0;
    imagesInFrame.clear();
    for (const item of frame.items) {
      wanted.add(item.id);
      const live = this.elementFor(item);
      this.update(live, item);
      if (!item.layer) {
        place(this.camera, live.element, slot++);
        continue;
      }
      const layer = this.layerFor(item.layer.id);
      const index = filled.get(item.layer.id);
      if (index === undefined) {
        layer.setAttribute("opacity", String(Math.max(0, Math.min(1, item.layer.opacity))));
        place(this.camera, layer, slot++);
      }
      place(layer, live.element, index ?? 0);
      filled.set(item.layer.id, (index ?? 0) + 1);
    }
    for (const [id, live] of this.live) {
      if (!wanted.has(id)) {
        this.discard(live);
        this.live.delete(id);
      }
    }
    for (const [id, layer] of this.layers) {
      if (!filled.has(id)) {
        layer.remove();
        this.layers.delete(id);
      }
    }
  }

  elementOf(id: string): SVGElement | null {
    return this.live.get(id)?.element ?? null;
  }

  private layerFor(id: string): SVGGElement {
    let layer = this.layers.get(id);
    if (!layer) this.layers.set(id, (layer = svg("g")));
    return layer;
  }

  private buildBackdrop(theme: Theme): void {
    this.backdropTheme = theme.id;
    const { kind, vignette, glow } = theme.backdrop;
    const colors = theme.colors;
    const ground = svg("rect", { width: STAGE.w, height: STAGE.h, fill: colors.ground });
    const layers: SVGElement[] = [ground];
    this.defs.replaceChildren();
    this.grainSeed = null;

    if (kind === "grid") {
      const line = cssRgba([...parseHex(colors.rule).slice(0, 3), 0.55] as [number, number, number, number]);
      const pattern = svg("pattern", { id: "grid", width: 100, height: 100, patternUnits: "userSpaceOnUse" });
      pattern.append(svg("path", { d: "M100 0 L0 0 L0 100", fill: "none", stroke: line, "stroke-width": 1 }));
      this.defs.append(pattern);
      layers.push(svg("rect", { width: STAGE.w, height: STAGE.h, fill: "url(#grid)" }));
    }
    if (kind === "paper") {
      const dot = cssRgba([...parseHex(colors.rule).slice(0, 3), 0.28] as [number, number, number, number]);
      const pattern = svg("pattern", { id: "dots", width: 48, height: 48, patternUnits: "userSpaceOnUse" });
      pattern.append(svg("circle", { cx: 24, cy: 24, r: 2.2, fill: dot }));
      this.defs.append(pattern);
      layers.push(svg("rect", { width: STAGE.w, height: STAGE.h, fill: "url(#dots)" }));
    }
    if (kind === "grain" || kind === "paper") {
      const filter = svg("filter", { id: "noise", x: 0, y: 0, width: "100%", height: "100%" });
      const turbulence = svg("feTurbulence", { type: "fractalNoise", baseFrequency: kind === "grain" ? 0.85 : 0.04, numOctaves: 2, seed: 1 });
      this.grainSeed = kind === "grain" ? turbulence : null;
      filter.append(turbulence, svg("feColorMatrix", { type: "saturate", values: 0 }));
      this.defs.append(filter);
      layers.push(svg("rect", { width: STAGE.w, height: STAGE.h, filter: "url(#noise)", opacity: kind === "grain" ? 0.13 : 0.07, style: `mix-blend-mode:${kind === "grain" ? "overlay" : "multiply"}` }));
    }
    if (vignette > 0) {
      const gradient = svg("radialGradient", { id: "vignette", cx: "50%", cy: "50%", r: "75%" });
      gradient.append(svg("stop", { offset: "45%", "stop-color": "#000", "stop-opacity": 0 }), svg("stop", { offset: "100%", "stop-color": "#000", "stop-opacity": vignette }));
      this.defs.append(gradient);
      layers.push(svg("rect", { width: STAGE.w, height: STAGE.h, fill: "url(#vignette)", "pointer-events": "none" }));
    }
    this.backdrop.replaceChildren(...layers);

    this.defs.querySelector("#glow")?.remove();
    if (glow > 0) {
      const filter = svg("filter", { id: "glow", x: "-10%", y: "-10%", width: "120%", height: "120%" });
      const transfer = svg("feComponentTransfer", { in: "blur", result: "soft" });
      transfer.append(svg("feFuncA", { type: "linear", slope: glow * 1.6 }));
      filter.append(svg("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 7, result: "blur" }), transfer);
      const merge = svg("feMerge");
      merge.append(svg("feMergeNode", { in: "soft" }), svg("feMergeNode", { in: "SourceGraphic" }));
      filter.append(merge);
      this.defs.append(filter);
      this.camera.setAttribute("filter", "url(#glow)");
    } else {
      this.camera.removeAttribute("filter");
    }
  }

  private elementFor(item: Painted): Live {
    const existing = this.live.get(item.id);
    if (existing && existing.kind === item.kind) return existing;
    if (existing) this.discard(existing);
    const element = DRAWABLE_KINDS[item.kind].create();
    const live = { element, kind: item.kind, signature: "", clip: null };
    this.live.set(item.id, live);
    return live;
  }

  private discard(live: Live): void {
    live.element.remove();
    live.clip?.remove();
  }

  private clipTo(live: Live, clip: Painted["clip"]): void {
    if (!clip) {
      if (live.clip) {
        live.clip.remove();
        live.clip = null;
        live.element.removeAttribute("clip-path");
      }
      return;
    }
    if (!live.clip) {
      live.clip = svg("clipPath", { id: `clip-${this.clipCount++}` });
      live.clip.append(svg("rect"));
      this.clips.append(live.clip);
      live.element.setAttribute("clip-path", `url(#${live.clip.id})`);
    }
    setAttributes(live.clip.firstElementChild!, { x: clip.x, y: clip.y, width: clip.w, height: clip.h });
  }

  private update(live: Live, item: Painted): void {
    setAttributes(live.element, {
      opacity: Math.max(0, Math.min(1, item.opacity)),
      transform: item.rotation ? `rotate(${item.rotation} ${item.x} ${item.y})` : null,
      "data-part": item.part ?? null,
    });
    this.clipTo(live, item.clip);
    DRAWABLE_KINDS[item.kind].update(live.element, item, live);
  }

  private invalidateEverything(): void {
    this.root.style.visibility = "hidden";
    this.root.getBoundingClientRect();
    this.root.style.visibility = "";
  }

  async imagesReady(): Promise<void> {
    await Promise.all([...imagesInFrame].map(decodeImage));
    this.invalidateEverything();
    await nextPaint();
  }

  partAt(tap: MouseEvent): string | null {
    const hit = tap.target instanceof Element ? tap.target.closest("[data-part]") : null;
    return (hit ?? this.nearestPart(tap.clientX, tap.clientY))?.getAttribute("data-part") ?? null;
  }

  private nearestPart(x: number, y: number): Element | null {
    let nearest: Element | null = null;
    let nearestDistance = FINGER_REACH;
    for (const element of this.root.querySelectorAll("[data-part]")) {
      const box = element.getBoundingClientRect();
      const distance = Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
      if (distance <= nearestDistance) [nearest, nearestDistance] = [element, distance];
    }
    return nearest;
  }
}
