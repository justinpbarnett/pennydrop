import type { Frame, Painted } from "./frame";
import { ARROW_HEAD_ANGLE, arrowHeadLength } from "./ink";
import { STAGE } from "./layout";
import { cssRgba, parseHex, type Theme, type ThemeId } from "./theme";
import { typeset } from "./typeset";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRAIN_FRAMES_PER_SECOND = 12;

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

interface Live {
  element: SVGElement;
  kind: string;
  signature: string;
}

export class StageRenderer {
  private readonly camera = svg("g");
  private readonly backdrop = svg("g");
  private readonly defs = svg("defs");
  private readonly live = new Map<string, Live>();
  private grainSeed: SVGElement | null = null;
  private backdropTheme: ThemeId | null = null;

  constructor(root: SVGSVGElement) {
    root.setAttribute("viewBox", `0 0 ${STAGE.w} ${STAGE.h}`);
    root.setAttribute("preserveAspectRatio", "xMidYMid meet");
    root.replaceChildren(this.defs, this.backdrop, this.camera);
  }

  draw(frame: Frame, theme: Theme): void {
    if (this.backdropTheme !== theme.id) this.buildBackdrop(theme);
    this.grainSeed?.setAttribute("seed", String(Math.floor(frame.time * GRAIN_FRAMES_PER_SECOND) % 997));
    const { cx, cy, zoom } = frame.camera;
    this.camera.setAttribute("transform", `translate(${STAGE.w / 2} ${STAGE.h / 2}) scale(${zoom}) translate(${-cx} ${-cy})`);

    const wanted = new Set<string>();
    frame.items.forEach((item, index) => {
      wanted.add(item.id);
      const live = this.elementFor(item);
      this.update(live, item);
      if (this.camera.children[index] !== live.element) this.camera.insertBefore(live.element, this.camera.children[index] ?? null);
    });
    for (const [id, live] of this.live) {
      if (!wanted.has(id)) {
        live.element.remove();
        this.live.delete(id);
      }
    }
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
    existing?.element.remove();
    const element = this.create(item);
    const live = { element, kind: item.kind, signature: "" };
    this.live.set(item.id, live);
    return live;
  }

  private create(item: Painted): SVGElement {
    switch (item.kind) {
      case "rect": return svg("rect");
      case "circle": return svg("circle");
      case "line": return svg("line", { "stroke-linecap": "round" });
      case "arrow": case "path": return svg("path", { "stroke-linecap": "round", "stroke-linejoin": "round" });
      case "text": return svg("text", { "dominant-baseline": "central" });
      case "code": return svg("text", { "dominant-baseline": "central", style: "white-space:pre" });
      case "math": {
        const object = svg("foreignObject");
        const holder = document.createElement("div");
        holder.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;white-space:nowrap";
        object.append(holder);
        return object;
      }
      case "image": return svg("image");
    }
  }

  private update(live: Live, item: Painted): void {
    const { element } = live;
    const common = {
      opacity: Math.max(0, Math.min(1, item.opacity)),
      transform: item.rotation ? `rotate(${item.rotation} ${item.x} ${item.y})` : null,
      "data-part": item.part ?? null,
    };
    setAttributes(element, common);
    const stroke = { fill: paintCss(item.fill), stroke: paintCss(item.stroke), "stroke-width": item.strokeWidth };
    const dash = item.draw !== undefined && item.draw < 1
      ? { pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 - Math.max(0, item.draw) }
      : { pathLength: null, "stroke-dasharray": null, "stroke-dashoffset": null };
    const font = { "font-size": item.size, "font-family": item.fontFamily, "font-weight": item.fontWeight, "letter-spacing": `${item.tracking}em`, "text-anchor": item.anchor };

    switch (item.kind) {
      case "rect": {
        const [w, h] = [item.w ?? 0, item.h ?? 0];
        setAttributes(element, { x: item.x - w / 2, y: item.y - h / 2, width: w, height: h, rx: Math.min(item.radius, Math.min(w, h) / 2), ...stroke });
        break;
      }
      case "circle":
        setAttributes(element, { cx: item.x, cy: item.y, r: Math.max(0, item.r ?? 0), ...stroke });
        break;
      case "line":
        setAttributes(element, { x1: item.x, y1: item.y, x2: item.x2!, y2: item.y2!, ...stroke, fill: "none", ...dash });
        break;
      case "arrow":
        setAttributes(element, { d: arrowPath(item), ...stroke, fill: "none", ...dash });
        break;
      case "path":
        setAttributes(element, { d: polyline(item.points ?? [], Boolean(item.closed)), ...stroke, ...dash });
        break;
      case "text":
        element.textContent = item.text ?? "";
        setAttributes(element, { x: item.x, y: item.y, ...font, fill: paintCss(item.fill) });
        element.style.fontVariantNumeric = "lining-nums tabular-nums";
        break;
      case "code": {
        const signature = JSON.stringify(item.spans);
        if (signature !== live.signature) {
          live.signature = signature;
          element.replaceChildren(...(item.spans ?? []).map((span) => {
            const tspan = svg("tspan", { fill: cssRgba(span.color) });
            tspan.textContent = span.text;
            return tspan;
          }));
        }
        setAttributes(element, { x: item.x, y: item.y, ...font });
        break;
      }
      case "math": {
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
        break;
      }
      case "image":
        setAttributes(element, { x: item.x - (item.w ?? 0) / 2, y: item.y - (item.h ?? 0) / 2, width: item.w ?? 0, height: item.h ?? 0, href: item.href ?? "", preserveAspectRatio: "xMidYMid meet" });
        break;
    }
  }

  partAt(target: EventTarget | null): string | null {
    return target instanceof Element ? target.closest("[data-part]")?.getAttribute("data-part") ?? null : null;
  }
}
