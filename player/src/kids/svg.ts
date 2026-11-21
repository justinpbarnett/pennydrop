const SVG_NS = "http://www.w3.org/2000/svg";

export type Shape = [tag: "path" | "circle" | "rect" | "ellipse", attributes: Record<string, string | number>];

export function drawing(viewBox: string, shapes: Shape[], className?: string): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("viewBox", viewBox);
  root.setAttribute("aria-hidden", "true");
  if (className) root.setAttribute("class", className);
  for (const [tag, attributes] of shapes) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    root.append(element);
  }
  return root;
}

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": 9, "stroke-linecap": "round", "stroke-linejoin": "round" };

export const icons = {
  mic: () => drawing("0 0 100 100", [
    ["rect", { x: 35, y: 10, width: 30, height: 52, rx: 15, fill: "currentColor" }],
    ["path", { d: "M22 48 C22 70 36 76 50 76 C64 76 78 70 78 48", ...STROKE }],
    ["path", { d: "M50 76 L50 92", ...STROKE }],
  ]),
  why: () => drawing("0 0 100 100", [
    ["path", { d: "M30 34 C30 14 70 12 70 34 C70 50 50 52 50 66", ...STROKE, "stroke-width": 13 }],
    ["circle", { cx: 50, cy: 88, r: 8, fill: "currentColor" }],
  ]),
  play: () => drawing("0 0 100 100", [["path", { d: "M32 18 L82 50 L32 82 Z", fill: "currentColor", stroke: "currentColor", "stroke-width": 8, "stroke-linejoin": "round" }]]),
  pause: () => drawing("0 0 100 100", [
    ["rect", { x: 24, y: 18, width: 18, height: 64, rx: 6, fill: "currentColor" }],
    ["rect", { x: 58, y: 18, width: 18, height: 64, rx: 6, fill: "currentColor" }],
  ]),
};

export function mascot(): SVGSVGElement {
  return drawing("0 0 200 200", [
    ["circle", { class: "coin-edge", cx: 100, cy: 100, r: 92 }],
    ["circle", { class: "coin-face", cx: 100, cy: 100, r: 78 }],
    ["path", { class: "coin-shine", d: "M46 70 C58 42 84 30 112 30" }],
    ["ellipse", { class: "coin-eye", cx: 72, cy: 92, rx: 11, ry: 15 }],
    ["ellipse", { class: "coin-eye", cx: 128, cy: 92, rx: 11, ry: 15 }],
    ["path", { class: "coin-mouth happy", d: "M66 124 C80 150 120 150 134 124" }],
    ["path", { class: "coin-mouth sad", d: "M70 146 C84 124 116 124 130 146" }],
    ["ellipse", { class: "coin-mouth open", cx: 100, cy: 138, rx: 15, ry: 18 }],
  ], "mascot");
}

const AVATAR_COLORS = ["#FF6B35", "#1E7FE0", "#1FA867", "#D81B8A", "#8A4FD6", "#E59A00"];
const EARS: Shape[][] = [
  [["circle", { cx: 40, cy: 40, r: 22 }], ["circle", { cx: 160, cy: 40, r: 22 }]],
  [["path", { d: "M32 76 L44 14 L84 46 Z" }], ["path", { d: "M168 76 L156 14 L116 46 Z" }]],
  [["ellipse", { cx: 62, cy: 26, rx: 18, ry: 42 }], ["ellipse", { cx: 138, cy: 26, rx: 18, ry: 42 }]],
  [["circle", { cx: 100, cy: 20, r: 18 }]],
  [["path", { d: "M30 70 C14 40 30 14 52 30 C62 38 66 52 66 62 Z" }], ["path", { d: "M170 70 C186 40 170 14 148 30 C138 38 134 52 134 62 Z" }]],
  [],
];

export function avatar(id: number): SVGSVGElement {
  const color = AVATAR_COLORS[id % AVATAR_COLORS.length]!;
  const ears = EARS[Math.floor(id / AVATAR_COLORS.length) % EARS.length]!;
  return drawing("0 0 200 200", [
    ...ears.map(([tag, attributes]): Shape => [tag, { ...attributes, fill: color }]),
    ["circle", { cx: 100, cy: 108, r: 76, fill: color }],
    ["circle", { cx: 100, cy: 118, r: 56, fill: "#FFFFFF", opacity: 0.35 }],
    ["circle", { cx: 74, cy: 98, r: 11, fill: "#2A1A4D" }],
    ["circle", { cx: 126, cy: 98, r: 11, fill: "#2A1A4D" }],
    ["path", { d: "M72 130 C86 152 114 152 128 130", fill: "none", stroke: "#2A1A4D", "stroke-width": 8, "stroke-linecap": "round" }],
  ], "avatar");
}
