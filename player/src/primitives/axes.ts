import { type Drawable, fail, type LabDef, positiveField, readsWords, type Role, roleField } from "../lab";

interface Series {
  id: string;
  points: [number, number][];
  role: Role;
  label: string;
}

interface AxesState {
  x: [number, number];
  y: [number, number];
  w: number;
  h: number;
  xLabel: string;
  yLabel: string;
  series: Series[];
  reading: boolean;
}

const PAD = { left: 90, right: 30, top: 30, bottom: 70 };
const TICKS = 5;

function range(value: unknown, name: string, objectId: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number" || value[0] >= value[1]) {
    fail(`${objectId}: "${name}" must be [min, max] with min below max`);
  }
  return value as [number, number];
}

function readSeries(list: unknown, objectId: string, offset = 0): Series[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail(`${objectId}: "series" must be a list of {points: [[x, y], ...]}`);
  return (list as Record<string, unknown>[]).map((entry, index) => {
    const points = entry.points;
    if (!Array.isArray(points) || points.length < 2) fail(`${objectId}: series ${index} needs "points" with at least two [x, y] pairs`);
    return { id: `s${offset + index}`, points: points as [number, number][], role: roleField(entry, "role", "accent", objectId), label: typeof entry.label === "string" ? entry.label : "" };
  });
}

function niceTick(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export const primitive: LabDef<Record<string, unknown>, AxesState> = {
  id: "axes",
  title: "Axes",
  reading: "optional",
  catalog: {
    summary: "Labeled axes with optional plotted series.",
    spec: {
      x: "[min, max]",
      y: "[min, max]",
      series: 'optional list of {"points": [[x, y], ...], "role"?, "label"?}',
      xLabel: "optional text",
      yLabel: "optional text",
      w: "px, default 760",
      h: "px, default 460",
    },
    example: ['{"scene":{"ax":{"kind":"axes","x":[0,10],"y":[0,100],"series":[{"points":[[0,0],[10,100]]}]}}}'],
  },
  ops: {
    series: {
      doc: '{"points": [[x, y], ...], "role"?: "accent", "label"?: text} adds a series; draws on with trace',
      seconds: 1.2,
      apply: (state, op) => ({ ...state, series: [...state.series, ...readSeries([op.args], "axes", state.series.length)] }),
    },
  },
  init(spec, objectId) {
    return {
      x: range(spec.x, "x", objectId),
      y: range(spec.y, "y", objectId),
      w: positiveField(spec, "w", 760, objectId),
      h: positiveField(spec, "h", 460, objectId),
      xLabel: typeof spec.xLabel === "string" ? spec.xLabel : "",
      yLabel: typeof spec.yLabel === "string" ? spec.yLabel : "",
      series: readSeries(spec.series, objectId),
      reading: readsWords(spec),
    };
  },
  size: (state) => ({ w: state.w, h: state.h }),
  draw(state) {
    const left = PAD.left;
    const right = state.w - PAD.right;
    const top = PAD.top;
    const bottom = state.h - PAD.bottom;
    const px = (value: number) => left + ((value - state.x[0]) / (state.x[1] - state.x[0])) * (right - left);
    const py = (value: number) => bottom - ((value - state.y[0]) / (state.y[1] - state.y[0])) * (bottom - top);
    const out: Drawable[] = [
      { id: "axis-x", kind: "line", x: left, y: bottom, x2: right, y2: bottom, stroke: "ink", strokeWidth: 1.4 },
      { id: "axis-y", kind: "line", x: left, y: bottom, x2: left, y2: top, stroke: "ink", strokeWidth: 1.4 },
    ];
    for (let tick = 0; tick <= TICKS; tick++) {
      const xv = state.x[0] + ((state.x[1] - state.x[0]) * tick) / TICKS;
      const yv = state.y[0] + ((state.y[1] - state.y[0]) * tick) / TICKS;
      out.push(
        { id: `grid-x-${tick}`, kind: "line", x: px(xv), y: bottom, x2: px(xv), y2: top, stroke: "rule", strokeWidth: 0.6, z: -1 },
        { id: `grid-y-${tick}`, kind: "line", x: left, y: py(yv), x2: right, y2: py(yv), stroke: "rule", strokeWidth: 0.6, z: -1 },
      );
      if (state.reading) {
        out.push(
          { id: `tick-x-${tick}`, kind: "text", x: px(xv), y: bottom + 28, text: niceTick(xv), size: 22, font: "read", fill: "muted" },
          { id: `tick-y-${tick}`, kind: "text", x: left - 16, y: py(yv), text: niceTick(yv), size: 22, font: "read", fill: "muted", anchor: "end" },
        );
      }
    }
    if (state.reading && state.xLabel) out.push({ id: "label-x", kind: "text", x: (left + right) / 2, y: state.h - 14, text: state.xLabel, size: 26, font: "mark", fill: "ink" });
    if (state.reading && state.yLabel) out.push({ id: "label-y", kind: "text", x: 22, y: (top + bottom) / 2, text: state.yLabel, size: 26, font: "mark", fill: "ink", rotation: -90 });
    for (const series of state.series) {
      out.push({ id: `series-${series.id}`, kind: "path", x: 0, y: 0, points: series.points.flatMap(([xv, yv]) => [px(xv), py(yv)]), fill: "none", stroke: series.role, strokeWidth: 2.4, z: 2 });
      if (state.reading && series.label) {
        const last = series.points.at(-1)!;
        out.push({ id: `series-${series.id}-label`, kind: "text", x: px(last[0]) - 8, y: py(last[1]) - 20, text: series.label, size: 24, font: "mark", fill: series.role, anchor: "end", z: 2 });
      }
    }
    return out;
  },
};
