import type { Frame, Painted } from "../frame";
import { placedTextInk } from "../ink";
import { STAGE } from "../layout";
import { StageRenderer } from "../render";
import type { Theme } from "../theme";
import type { FilmFrame, PlaneFrame } from "./film";
import type { InkBox } from "./inks";
import { FILM_FPS } from "./format";
import { PERSPECTIVE, project, SCREEN } from "./camera";
import { CREDITS } from "./screen";

const SVG_NS = "http://www.w3.org/2000/svg";
const MOTE_COUNT = 70;
const MOTE_SEED = 7;
const GRAIN = { w: 480, h: 270, strength: 46 };
const GLOW_BLUR = 9;
const SETTLE_FRAMES = 2;
const MIN_INK_OPACITY = 0.05;
const MOTE_OPACITY = 0.3;
const MOTE_DEFOCUS = 2.2;
const MOTE_HALO = 1.6;
const MOTE_MAX_SCREEN = 7;
const INK_BAND = 140;
const STAGE_CENTER = { x: STAGE.w / 2, y: STAGE.h / 2 };

function glyphBox(item: Painted | undefined): DOMRect | null {
  if (item?.kind !== "text" || !item.text) return null;
  const [left, top, right, bottom] = placedTextInk(item.text, item.size, { family: item.fontFamily, weight: item.fontWeight, tracking: item.tracking }, item.x, item.y, item.anchor);
  return new DOMRect(left, top, right - left, bottom - top);
}

interface PlaneView {
  element: HTMLDivElement;
  svg: SVGSVGElement;
  renderer: StageRenderer;
}

interface Mote {
  element: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  size: number;
  phase: number;
  speed: number;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, id?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (id) made.id = id;
  return made;
}

function glowFilter(strength: number): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("width", "0");
  root.setAttribute("height", "0");
  root.style.position = "absolute";
  root.innerHTML = `<defs><filter id="film-glow" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceGraphic" stdDeviation="${GLOW_BLUR}" result="blur"/>
    <feComponentTransfer in="blur" result="soft"><feFuncA type="linear" slope="${(strength * 1.8).toFixed(3)}"/></feComponentTransfer>
    <feMerge><feMergeNode in="soft"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  return root;
}

export class FilmView {
  private readonly screen = element("div", "screen");
  private readonly world = element("div", "world");
  private readonly grain = element("canvas", "grain");
  private readonly vignette = element("div", "vignette");
  private readonly credits = element("div", "credits");
  private readonly planes = new Map<string, PlaneView>();
  private readonly motes: Mote[] = [];
  private readonly grainContext: CanvasRenderingContext2D;
  private readonly grainImage: ImageData;
  private themeId: string | null = null;

  constructor(root: HTMLElement, bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }) {
    this.screen.append(this.world, this.vignette, this.credits, this.grain);
    root.replaceChildren(this.screen);
    this.grain.width = GRAIN.w;
    this.grain.height = GRAIN.h;
    this.grain.style.width = `${SCREEN.w}px`;
    this.grain.style.height = `${SCREEN.h}px`;
    Object.assign(this.credits.style, { bottom: `${CREDITS.bottom}px`, fontSize: `${CREDITS.size}px`, lineHeight: `${CREDITS.lineHeight}px` });
    this.grainContext = this.grain.getContext("2d")!;
    this.grainImage = this.grainContext.createImageData(GRAIN.w, GRAIN.h);
    this.seedMotes(bounds);
  }

  private seedMotes(bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }): void {
    const random = seeded(MOTE_SEED);
    const spanX = bounds.maxX - bounds.minX + 3200;
    const spanY = bounds.maxY - bounds.minY + 2400;
    const spanZ = bounds.maxZ - bounds.minZ + 2600;
    for (let index = 0; index < MOTE_COUNT; index += 1) {
      const mote = element("div");
      mote.className = "mote";
      this.world.append(mote);
      this.motes.push({
        element: mote,
        x: bounds.minX - 1600 + random() * spanX,
        y: bounds.minY - 1200 + random() * spanY,
        z: bounds.minZ - 1800 + random() * spanZ,
        size: 16 + random() * 34,
        phase: random() * Math.PI * 2,
        speed: 0.12 + random() * 0.25,
      });
    }
  }

  private planeFor(id: string): PlaneView {
    const known = this.planes.get(id);
    if (known) return known;
    const holder = element("div");
    holder.className = "plane";
    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    holder.append(svg);
    this.world.append(holder);
    const view = { element: holder, svg, renderer: new StageRenderer(svg) };
    this.planes.set(id, view);
    return view;
  }

  private drawPlane(plane: PlaneFrame, theme: Theme, glow: boolean): void {
    const view = this.planeFor(plane.id);
    const { element: holder, svg, renderer } = view;
    svg.setAttribute("viewBox", `0 0 ${plane.w} ${plane.h}`);
    svg.setAttribute("width", String(plane.w));
    svg.setAttribute("height", String(plane.h));
    svg.removeAttribute("preserveAspectRatio");
    const inner: Frame = { items: plane.items, camera: { cx: STAGE_CENTER.x, cy: STAGE_CENTER.y, zoom: 1 }, time: 0 };
    renderer.draw(inner, { ...theme, backdrop: { kind: "flat", vignette: 0, glow: 0 } });
    svg.setAttribute("viewBox", `0 0 ${plane.w} ${plane.h}`);
    const blur = plane.blur > 0.05 ? ` blur(${plane.blur.toFixed(2)}px)` : "";
    holder.style.cssText = `left:${plane.x}px;top:${plane.y}px;width:${plane.w}px;height:${plane.h}px;transform:translateZ(${plane.z}px);opacity:${plane.visible ? plane.opacity.toFixed(4) : 0};filter:${glow ? "url(#film-glow)" : "none"}${blur};`;
  }

  measureInk(plane: PlaneFrame, theme: Theme): InkBox | null {
    this.drawPlane(plane, theme, false);
    const { renderer } = this.planeFor(plane.id);
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    plane.items.forEach((item) => {
      const child = renderer.elementOf(item.id);
      if (!(child instanceof SVGGraphicsElement) || Math.min(1, item.opacity) * Math.min(1, item.layer?.opacity ?? 1) < MIN_INK_OPACITY) return;
      const box = glyphBox(item) ?? child.getBBox();
      if (box.width === 0 && box.height === 0) return;
      const matrix = child.transform.baseVal.consolidate()?.matrix ?? new DOMMatrix();
      for (const corner of [new DOMPoint(box.x, box.y), new DOMPoint(box.x + box.width, box.y), new DOMPoint(box.x, box.y + box.height), new DOMPoint(box.x + box.width, box.y + box.height)]) {
        const placed = corner.matrixTransform(matrix);
        left = Math.min(left, placed.x);
        right = Math.max(right, placed.x);
        top = Math.min(top, placed.y);
        bottom = Math.max(bottom, placed.y);
      }
    });
    return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
  }

  private clearanceFromInk(frame: FilmFrame, x: number, y: number, radius: number): number {
    let clear = 1;
    for (const plane of frame.planes) {
      const ink = plane.ink;
      if (!ink || !plane.visible) continue;
      const gap = Math.hypot(Math.max(ink.x - x, 0, x - (ink.x + ink.w)), Math.max(ink.y - y, 0, y - (ink.y + ink.h))) - radius;
      const amount = Math.max(0, Math.min(1, gap / INK_BAND));
      clear = Math.min(clear, amount * amount * (3 - 2 * amount));
    }
    return clear;
  }

  private drawMotes(time: number, frame: FilmFrame, theme: Theme): void {
    const color = theme.colors.highlight;
    for (const mote of this.motes) {
      const x = mote.x + Math.sin(time * mote.speed + mote.phase) * 120;
      const y = mote.y - ((time * 22 * mote.speed * 4 + mote.phase * 60) % 2400) + 1200;
      const dx = x - frame.pose.px;
      const dy = y - frame.pose.py;
      const dz = mote.z - frame.pose.pz;
      const distance = Math.hypot(dx, dy, dz);
      const fade = Math.max(0, Math.min(1, 1 - Math.abs(distance - 2200) / 2600));
      const screen = project(frame.pose, [x, y, mote.z]);
      const size = screen ? Math.min(mote.size, (MOTE_MAX_SCREEN * screen.depth) / PERSPECTIVE) : mote.size;
      const clear = screen ? this.clearanceFromInk(frame, screen.x, screen.y, ((size * PERSPECTIVE) / screen.depth) * MOTE_HALO) : 0;
      mote.element.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;margin:${-size / 2}px;transform:translateZ(${mote.z}px);background:${color};opacity:${(MOTE_OPACITY * fade * clear).toFixed(3)};filter:blur(${(size / MOTE_DEFOCUS).toFixed(1)}px);`;
    }
  }

  private drawGrain(time: number, strength: number): void {
    const random = seeded(Math.round(time * FILM_FPS) * 2654435761 + 17);
    const { data } = this.grainImage;
    for (let index = 0; index < data.length; index += 4) {
      const value = 128 + (random() - 0.5) * GRAIN.strength * 2 * strength;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
    this.grainContext.putImageData(this.grainImage, 0, 0);
  }

  draw(frame: FilmFrame, theme: Theme): void {
    if (this.themeId !== theme.id) {
      this.themeId = theme.id;
      this.screen.style.background = `radial-gradient(ellipse at 50% 45%, ${theme.colors.fill2} 0%, ${theme.colors.ground} 62%)`;
      this.vignette.style.background = `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 42%, rgba(0,0,0,${theme.backdrop.vignette}) 100%)`;
      this.grain.style.opacity = theme.backdrop.kind === "grain" ? "0.2" : "0";
      const font = theme.fonts.read;
      Object.assign(this.credits.style, { color: theme.colors.muted, fontFamily: font.family, fontWeight: String(font.weight), letterSpacing: `${font.tracking}em` });
      document.querySelector("#film-glow-defs")?.remove();
      const defs = glowFilter(theme.backdrop.glow);
      defs.id = "film-glow-defs";
      document.body.append(defs);
    }
    this.world.style.transform = frame.matrix;
    const live = new Set<string>();
    const glow = theme.backdrop.glow > 0;
    for (const plane of frame.planes) {
      live.add(plane.id);
      this.drawPlane(plane, theme, glow);
    }
    for (const [id, view] of this.planes) {
      if (!live.has(id)) {
        view.element.remove();
        this.planes.delete(id);
      }
    }
    this.credits.textContent = frame.credits.lines.join("\n");
    this.credits.style.opacity = frame.credits.opacity.toFixed(3);
    this.drawMotes(frame.time, frame, theme);
    if (theme.backdrop.kind === "grain") this.drawGrain(frame.time, 1);
  }

  async settle(): Promise<void> {
    await document.fonts.ready;
    const images = [...this.world.querySelectorAll("image")].map((node) => node.getAttribute("href") ?? node.getAttribute("xlink:href"));
    await Promise.all(
      images.filter((href): href is string => Boolean(href)).map((href) => {
        const probe = new Image();
        probe.src = href;
        return probe.decode().catch(() => undefined);
      }),
    );
    for (let index = 0; index < SETTLE_FRAMES; index += 1) await new Promise<void>((done) => requestAnimationFrame(() => done()));
  }
}
