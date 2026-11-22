import { clamp01, type Drawable, type LabDef, type Paint, stringField } from "../../lab";

interface Stroke {
  points: number[];
  closed?: boolean;
  stroke: Paint;
  width?: number;
}

type Drawing = "cannon" | "bridge" | "fleet";

interface FigureState {
  drawing: Drawing;
  caption: string;
  drawn: boolean;
}

const SIZE = { w: 1800, h: 1100 };
const DRAW_SECONDS = 3.2;
const CAPTION_Y = SIZE.h - 80;
const STROKE_WIDTH = 8;
const STROKE_SHARE = 0.3;

function arc(cx: number, cy: number, r: number, from: number, to: number, steps = 24): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  }).flat();
}

function wheel(cx: number, cy: number, r: number): Stroke[] {
  return [
    { points: arc(cx, cy, r, 0, 360, 36), closed: true, stroke: "ink" },
    { points: arc(cx, cy, r * 0.18, 0, 360, 12), closed: true, stroke: "ink" },
    ...[0, 45, 90, 135].map((angle) => {
      const rad = (angle * Math.PI) / 180;
      return { points: [cx - r * Math.cos(rad), cy - r * Math.sin(rad), cx + r * Math.cos(rad), cy + r * Math.sin(rad)], stroke: "muted" as Paint, width: 5 };
    }),
  ];
}

function ship(x: number, y: number, scale: number, burning: boolean): Stroke[] {
  const s = (px: number, py: number) => [x + px * scale, y + py * scale];
  const hull = [...s(-170, 0), ...s(170, 0), ...s(130, 60), ...s(-130, 60)];
  const strokes: Stroke[] = [
    { points: hull, closed: true, stroke: "ink" },
    { points: [...s(-60, 0), ...s(-60, -230)], stroke: "ink" },
    { points: [...s(40, 0), ...s(40, -260)], stroke: "ink" },
    { points: [...s(-60, -210), ...s(-60, -40), ...s(-150, -60)], closed: true, stroke: "muted", width: 5 },
    { points: [...s(40, -240), ...s(40, -50), ...s(130, -70)], closed: true, stroke: "muted", width: 5 },
  ];
  if (burning) strokes.push({ points: [...s(40, -260), ...s(10, -310), ...s(60, -350), ...s(20, -400), ...s(80, -330), ...s(40, -260)], stroke: "warn", width: 7 });
  return strokes;
}

const DRAWINGS: Record<Drawing, () => Stroke[]> = {
  cannon: () => [
    { points: [250, 610, 1010, 520, 1040, 590, 250, 680], closed: true, stroke: "ink" },
    { points: [1010, 520, 1060, 505, 1075, 605, 1040, 590], closed: true, stroke: "ink" },
    { points: [250, 680, 330, 760, 760, 760, 800, 630], stroke: "ink" },
    ...wheel(560, 800, 170),
    ...[-90, -30, 30, 90].map((dy, i) => ({ points: [1130, 560 + dy * 0.2, 1650, 560 + dy * 2.2 - i * 6], stroke: "accent" as Paint, width: 5 })),
    { points: [140, 960, 1700, 960], stroke: "edge", width: 4 },
  ],
  bridge: () => [
    { points: [120, 560, 1680, 560], stroke: "ink" },
    { points: [120, 610, 1680, 610], stroke: "ink" },
    { points: arc(450, 870, 200, 180, 360, 24), stroke: "ink" },
    { points: arc(900, 870, 200, 180, 360, 24), stroke: "ink" },
    { points: arc(1350, 870, 200, 180, 360, 24), stroke: "ink" },
    { points: [210, 610, 210, 870, 1590, 870, 1590, 610], stroke: "edge", width: 4 },
    { points: [150, 940, 330, 920, 520, 950, 700, 920, 900, 950, 1100, 920, 1300, 950, 1500, 920, 1680, 940], stroke: "muted", width: 5 },
    { points: [1020, 560, 1020, 360], stroke: "ink" },
    { points: arc(1020, 300, 60, 0, 360, 16), closed: true, stroke: "ink" },
    { points: [1020, 360, 1020, 470, 960, 560], stroke: "ink" },
    { points: [1020, 470, 1080, 560], stroke: "ink" },
    { points: [1020, 390, 940, 330], stroke: "ink" },
    { points: [940, 330, 940, 40], stroke: "ink" },
    { points: [940, 40, 1190, 90, 940, 170], closed: true, stroke: "accent" },
  ],
  fleet: () => [
    { points: [80, 700, 1720, 700], stroke: "edge", width: 4 },
    ...ship(360, 640, 1, false),
    ...ship(850, 640, 1, true),
    ...ship(1340, 640, 1, false),
    { points: [100, 780, 300, 760, 500, 790, 700, 760, 900, 790, 1100, 760, 1300, 790, 1500, 760, 1700, 780], stroke: "muted", width: 5 },
    { points: [200, 870, 400, 850, 600, 880, 800, 850, 1000, 880, 1200, 850, 1400, 880, 1600, 860], stroke: "muted", width: 5 },
  ],
};

function strokesAt(state: FigureState, progress: number): Drawable[] {
  const strokes = DRAWINGS[state.drawing]();
  return strokes.map((stroke, index) => ({
    id: `stroke-${index}`,
    kind: "path",
    x: 0,
    y: 0,
    points: stroke.points,
    closed: stroke.closed,
    stroke: stroke.stroke,
    strokeWidth: stroke.width ?? STROKE_WIDTH,
    draw: clamp01((progress - (index / Math.max(1, strokes.length - 1)) * (1 - STROKE_SHARE)) / STROKE_SHARE),
    z: 2,
  }));
}

export const primitive: LabDef<Record<string, unknown>, FigureState> = {
  id: "figure",
  title: "Line drawing",
  reading: "optional",
  catalog: {
    summary: "A simple line drawing that is traced stroke by stroke: a cannon, a bridge or a fleet of ships.",
    spec: { drawing: "cannon, bridge or fleet", caption: "optional line under the drawing" },
    example: ['{"scene":{"sketch":{"kind":"figure","drawing":"bridge","caption":"Arcole, 1796"}},"do":[{"cue":"bridge","op":"draw","on":["sketch"]}]}'],
  },
  init(spec, objectId) {
    const drawing = spec.drawing;
    if (drawing !== "cannon" && drawing !== "bridge" && drawing !== "fleet") throw new Error(`${objectId}: "drawing" must be cannon, bridge or fleet`);
    return { drawing, caption: stringField(spec, "caption", objectId, ""), drawn: false };
  },
  ops: {
    draw: {
      doc: "traces the drawing stroke by stroke",
      seconds: DRAW_SECONDS,
      apply: (state) => ({ ...state, drawn: true }),
      during: (_before, after, _op, progress) => strokesAt(after, progress),
    },
  },
  size: () => SIZE,
  draw(state) {
    const out: Drawable[] = state.drawn ? strokesAt(state, 1) : [];
    if (state.caption) out.push({ id: "caption", kind: "text", x: SIZE.w / 2, y: CAPTION_Y, text: state.caption.toUpperCase(), size: 52, font: "read", fill: "muted", z: 2 });
    return out;
  },
};
