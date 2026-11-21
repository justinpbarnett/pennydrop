import { boxDrawable, clamp01, fail, fitText, lerp, readsWords, textDrawable, type Drawable, type LabDef, type LabOp, type Role } from "../lab";

const functions = {
  linear: { expression: "ax", value: (x: number) => x, slope: (_x: number) => 1, primitive: (x: number) => (x * x) / 2 },
  square: { expression: "ax²", value: (x: number) => x * x, slope: (x: number) => 2 * x, primitive: (x: number) => x ** 3 / 3 },
  sine: { expression: "a sin(x)", value: Math.sin, slope: Math.cos, primitive: (x: number) => -Math.cos(x) },
};

type Family = keyof typeof functions;
type Spec = Record<string, unknown>;
type Interval = { from: number; to: number };
interface State {
  id: string;
  reading: boolean;
  family: Family;
  a: number;
  tangent: number | null;
  area: Interval | null;
}

const WIDTH = 1200;
const X_LIMIT = 2;
const Y_LIMIT = 4;
const px = (x: number) => 620 + 270 * x;
const py = (y: number) => 352 - 60 * y;
const PLOT_LEFT = px(-X_LIMIT);
const PLOT_RIGHT = px(X_LIMIT);
const TRACK_LEFT = px(1);
const TICK_LABEL_Y = py(-Y_LIMIT) + 38;
const CAPTION_Y = TICK_LABEL_Y + 50;

function panelHeight(state: State): number {
  if (!state.reading) return py(-Y_LIMIT) + 44;
  const lastRow = state.area || state.tangent !== null ? CAPTION_Y : TICK_LABEL_Y;
  return lastRow + 44;
}
const format = (n: number) => String(Number(n.toFixed(3)));

function target(state: State, op: LabOp, keys: string[]) {
  if (op.parts.length || Object.keys(op.args).some((key) => !keys.includes(key))) {
    fail(`${state.id}: use ${op.name} on the whole plot with ${keys.join(", ")}`);
  }
}

function number(value: unknown, limit: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) {
    fail(`${field}: use a number from ${-limit} to ${limit}`);
  }
  return value;
}

function family(value: unknown, id: string): Family {
  if (typeof value !== "string" || !Object.hasOwn(functions, value)) fail(`${id}: use linear, square or sine for function`);
  return value as Family;
}

function line(id: string, x: number, y: number, x2: number, y2: number, stroke: Role, strokeWidth = 2, z = 1): Drawable {
  return { id, kind: "line", x, y, x2, y2, stroke, strokeWidth, z };
}

function label(id: string, content: string, x: number, y: number, size: number, room = WIDTH, anchor: Drawable["anchor"] = "middle"): Drawable {
  return textDrawable(id, content, { x, y }, { anchor, size: fitText(content, size, room, "read"), z: 6 });
}

function grid(state: State): Drawable[] {
  const marks: Drawable[] = [];
  for (let i = -X_LIMIT; i <= X_LIMIT; i++) {
    marks.push(line(`vertical-${i}`, px(i), py(Y_LIMIT), px(i), py(-Y_LIMIT), i === 0 ? "muted" : "rule"), line(`x-tick-${i}`, px(i), py(0) - 7, px(i), py(0) + 7, "muted"));
    if (state.reading) marks.push(label(`x-value-${i}`, String(i), px(i), TICK_LABEL_Y, 28));
  }
  for (let i = -Y_LIMIT; i <= Y_LIMIT; i++) {
    marks.push(line(`horizontal-${i}`, px(-X_LIMIT), py(i), px(X_LIMIT), py(i), i === 0 ? "muted" : "rule"), line(`y-tick-${i}`, px(0) - 7, py(i), px(0) + 7, py(i), "muted"));
    if (state.reading && i % 2 === 0) marks.push(label(`y-value-${i}`, String(i), 32, py(i), 28));
  }
  return marks;
}

function draw(state: State): Drawable[] {
  const fn = functions[state.family];
  const samples = 100;
  const xs = new Set(Array.from({ length: samples + 1 }, (_, i) => lerp(-X_LIMIT, X_LIMIT, i / samples)));
  if (state.area) {
    xs.add(state.area.from);
    xs.add(state.area.to);
  }
  const curve = [...xs].sort((a, b) => a - b).map((x) => ({ x, point: [px(x), py(state.a * fn.value(x))] }));
  const marks: Drawable[] = [
    boxDrawable("panel", { x: 0, y: 0, w: WIDTH, h: panelHeight(state) }, { fill: "fill", z: 0 }),
    ...grid(state),
    { id: "curve", kind: "path", x: px(-X_LIMIT), y: py(state.a * fn.value(-X_LIMIT)), points: curve.flatMap((sample) => sample.point), stroke: "series1", fill: "none", strokeWidth: 5, z: 4 },
    line("track", TRACK_LEFT, 54, PLOT_RIGHT, 54, "edge", 4),
    { id: "thumb", kind: "circle", x: lerp(TRACK_LEFT, PLOT_RIGHT, (state.a + 1) / 2), y: 54, r: 11, fill: "series1", z: 4 },
  ];
  if (state.reading) marks.push(label("formula", "y = " + fn.expression, PLOT_LEFT, 54, 42, 500, "start"), label("coefficient", "a = " + format(state.a), TRACK_LEFT - 36, 54, 32, 300, "end"));
  if (state.area) {
    const { from, to } = state.area;
    marks.push({
      id: "area",
      kind: "path",
      x: px(from),
      y: py(0),
      points: [px(from), py(0), ...curve.filter((sample) => sample.x >= from && sample.x <= to).flatMap((sample) => sample.point), px(to), py(0)],
      closed: true,
      fill: "series3",
      stroke: "none",
      opacity: 0.48,
      z: 2,
    });
    const area = state.a * (fn.primitive(to) - fn.primitive(from));
    if (state.reading) marks.push(label("integral", `Signed area [${format(from)}, ${format(to)}] ≈ ${format(area)}`, PLOT_RIGHT, CAPTION_Y, 28, 640, "end"));
  }
  if (state.tangent !== null) {
    const x = state.tangent;
    const y = state.a * fn.value(x);
    const m = state.a * fn.slope(x);
    const limits = [(-Y_LIMIT - y) / m, (Y_LIMIT - y) / m];
    const left = m === 0 ? -X_LIMIT : Math.max(-X_LIMIT, x + Math.min(...limits));
    const right = m === 0 ? X_LIMIT : Math.min(X_LIMIT, x + Math.max(...limits));
    const segments = state.area ? 36 : 1;
    for (let i = 0; i < segments; i++) {
      const start = lerp(left, right, i / segments);
      const end = lerp(left, right, (i + (state.area && i < segments - 1 ? 0.6 : 1)) / segments);
      marks.push(line(i === 0 ? "tangent" : `tangent-${i}`, px(start), py(y + m * (start - x)), px(end), py(y + m * (end - x)), "series2", state.area ? 2 : 3, 5));
    }
    marks.push({ id: "contact", kind: "circle", x: px(x), y: py(y), r: 8, fill: "series2", stroke: "fill", strokeWidth: 2, z: 6 });
    if (state.reading) marks.push(label("slope", `Slope at ${format(x)} ≈ ${format(m)}`, PLOT_LEFT, CAPTION_Y, 28, 420, "start"));
  }
  return marks;
}

export const lab: LabDef<Spec, State> = {
  id: "plot",
  title: "Plot",
  reading: "optional",
  catalog: {
    summary: "A coordinate grid shows how a coefficient changes a curve, its tangent slope and its signed area. All ops target the whole plot.",
    spec: {
      function: "Optional linear (ax), square (ax²), or sine (a sin x in radians). Defaults to linear.",
      a: "Optional coefficient from −1 to 1, default 1.",
      reading: "Optional boolean, default true. False hides all text.",
    },
    example: [
      '{"step":1,"say":"Graph a parabola and draw its tangent at one.","scene":{"p":{"lab":"plot"}},"do":[{"cue":"Graph","op":"graph","on":["p"],"function":"square"},{"cue":"draw its tangent","op":"tangent","on":["p"],"x":1}]}',
    ],
  },
  init(spec, id) {
    if (spec.reading !== undefined && typeof spec.reading !== "boolean") fail(`${id}: use true or false for reading`);
    return {
      id,
      reading: readsWords(spec),
      family: family(spec.function === undefined ? "linear" : spec.function, id),
      a: number(spec.a === undefined ? 1 : spec.a, 1, id + " a"),
      tangent: null,
      area: null,
    };
  },
  ops: {
    graph: {
      doc: '{"function":"square"} selects linear, square or sine, preserves a and clears measurements.',
      seconds: 0.9,
      apply(s, op) {
        target(s, op, ["function"]);
        return { ...s, family: family(op.args.function, s.id + " graph"), area: null, tangent: null };
      },
      during(_before, after, _op, t) {
        return draw(after)
          .filter((d) => d.id === "curve")
          .map((d) => ({ ...d, draw: clamp01(t) }));
      },
    },
    slide: {
      doc: '{"to":0.5} sweeps a to a number from −1 to 1 and updates all measurements.',
      seconds: 1.6,
      apply(s, op) {
        target(s, op, ["to"]);
        return { ...s, a: number(op.args.to, 1, s.id + " slide to") };
      },
      during(before, after, _op, t) {
        return draw({ ...after, a: lerp(before.a, after.a, clamp01(t)) });
      },
    },
    tangent: {
      doc: '{"x":1} shows the tangent and slope at x from −2 to 2.',
      seconds: 1,
      apply(s, op) {
        target(s, op, ["x"]);
        return { ...s, tangent: number(op.args.x, X_LIMIT, s.id + " tangent x") };
      },
      during(before, after, _op, t) {
        return draw({ ...after, tangent: lerp(before.tangent ?? 0, after.tangent!, clamp01(t)) });
      },
    },
    shade: {
      doc: '{"from":0,"to":2} shades the interval and reports its signed integral. Both bounds must be within [−2,2], with from less than to.',
      seconds: 1.3,
      apply(s, op) {
        target(s, op, ["from", "to"]);
        const from = number(op.args.from, X_LIMIT, s.id + " shade from");
        const to = number(op.args.to, X_LIMIT, s.id + " shade to");
        if (from >= to) fail(`${s.id}: shade needs from less than to`);
        return { ...s, area: { from, to } };
      },
      during(before, after, _op, t) {
        const { from, to } = after.area!;
        return draw({ ...after, area: { from: lerp(before.area?.from ?? from, from, clamp01(t)), to: lerp(before.area?.to ?? from, to, clamp01(t)) } });
      },
    },
  },
  size: (state) => ({ w: WIDTH, h: panelHeight(state) }),
  draw,
};
