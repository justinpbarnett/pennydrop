import { clamp01, type Drawable, fail, type FontRole, type LabDef, type LabOp, lerp, type OpDef, type Paint, type Point, readsWords, type Rect, type Role, segmentDrawable, type Size, textDrawable } from "../lab";
import { type Body, bodyAt, endTime, integrate, type Leg, legStart, SIM_STEP, type System, timesBetween, type Trajectory } from "../physics-sim";
import { textWidth } from "../text-metrics";

type Args = Record<string, unknown>;

interface LegSpec {
  event: string;
  count: number;
}

interface Attempt<P> {
  id: number;
  params: P;
  legs: LegSpec[];
}

interface PhysicsState {
  objectId: string;
  reading: boolean;
  setup: SetupName;
  params: any;
  ghosts: Attempt<any>[];
  attempt: Attempt<any> | null;
  started: number;
  vectors: string[];
  trail: boolean;
  marks: string[];
}

interface Ghost<P> {
  params: P;
  trajectory: Trajectory;
  role: Role;
}

interface View<P> {
  objectId: string;
  reading: boolean;
  params: P;
  trajectory: Trajectory;
  time: number;
  role: Role;
  ran: boolean;
  vectors: string[];
  trail: boolean;
  marks: string[];
  ghosts: Ghost<P>[];
}

interface EventDef<P> {
  terminal: boolean;
  stuck: string;
  make(params: P, count: number): (from: Body) => Leg;
}

interface Showing {
  vectors: boolean;
  apex: boolean;
  lowest: boolean;
}

interface Kind<P, L extends { size: Size }> {
  startOp: string;
  spec: Record<string, string>;
  settable: Record<string, string>;
  runArgs: string;
  vectors: Record<string, string>;
  marks: Record<string, string>;
  ghosts: boolean;
  events: Record<string, EventDef<P>>;
  init(spec: Args, objectId: string): P;
  change(params: P, args: Args, who?: string): P;
  system(params: P): System;
  ready(params: P): Body;
  legSpec(params: P, args: Args): LegSpec;
  seconds(params: P, span: number): number;
  layout(all: P[], reading: boolean, showing: Showing): L;
  scene(layout: L, view: View<P>): Drawable[];
  header(params: P, body: Body, time: number): Readout[];
  markKey?(params: P, args: Args): string;
}

interface Readout {
  text: string;
  widest: string;
}

const readout = (text: string, widest: string): Readout => ({ text, widest });

type AnyKind = Kind<any, any>;
type SetupName = "launch" | "drop" | "ramp" | "pendulum" | "orbit";

const GRAVITY = 9.81;
const GM = 4 * Math.PI * Math.PI;
const ORBIT_STEP = 1 / 2000;
const MAX_STEPS = 40000;
const ORBIT_MAX_STEPS = 130000;
const REST_SECONDS = 1.5;
const MAX_GHOSTS = 4;
const ATTEMPT_ROLES: Role[] = ["accent", "series3", "series5", "series6", "series1"];
const PLANET_ROLES: Role[] = ["series2", "series3", "series4", "series5"];
const VECTOR_ROLE: Record<string, Role> = { velocity: "series2", gravity: "fault", normal: "ok", friction: "series5", tension: "series3", net: "ink" };

const HEADER_HEIGHT = 74;
const READOUT_GAP = 64;
const HEADER_TEXT = 26;
const LABEL_TEXT = 26;
const TICK_TEXT = 20;
const ARROW_MIN_PX = 28;
const NET_MIN_PX = 44;
const TICK_LABEL_DROP = 36;
const VELOCITY_PX = 120;
const RUN_MIN_SECONDS = 0.8;
const RUN_MAX_SECONDS = 9;
const ORBIT_SECONDS_PER_ORBIT = 4.5;
const ORBIT_MIN_SECONDS = 1.5;
const ORBIT_MAX_SECONDS = 14;

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const fmt = (value: number, digits = 1) => (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toFixed(digits);
const sum = (points: Point[]): Point => ({ x: points.reduce((total, point) => total + point.x, 0), y: points.reduce((total, point) => total + point.y, 0) });

function niceStep(span: number, targetCount: number): number {
  const raw = span / targetCount;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((multiple) => multiple * power >= raw) ?? 10) * power;
}

function boundedNumber(source: Args, key: string, fallback: number, min: number, max: number, who: string, unit = ""): number {
  const value = source[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${who}: "${key}" must be a number from ${min} to ${max}${unit}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function onlyKeys(source: Args, allowed: string[], who: string, ignore: string[] = []): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key) && !ignore.includes(key));
  if (unknown.length > 0) fail(`${who} has no field ${unknown.map((key) => `"${key}"`).join(", ")}; its fields are ${allowed.join(", ")}`);
}

function line(id: string, from: Point, to: Point, stroke: Paint, strokeWidth: number, z: number, extra: Partial<Drawable> = {}): Drawable {
  return { ...segmentDrawable("line", from, to, stroke, strokeWidth, z), id, ...extra };
}

function circle(id: string, at: Point, r: number, fill: Paint, stroke: Paint, strokeWidth: number, z: number, extra: Partial<Drawable> = {}): Drawable {
  return { id, kind: "circle", x: at.x, y: at.y, r, fill, stroke, strokeWidth, z, ...extra };
}

function trace(id: string, points: Point[], stroke: Paint, strokeWidth: number, z: number, opacity = 1): Drawable[] {
  if (points.length < 2) return [];
  return [{ id, kind: "path", x: 0, y: 0, points: points.flatMap((point) => [point.x, point.y]), fill: "none", stroke, strokeWidth, opacity, z }];
}

function pathOf(trajectory: Trajectory, from: number, to: number, count: number, place: (body: Body) => Point): Point[] {
  if (to - from < 1e-9) return [];
  return timesBetween(from, to, count).map((time) => place(bodyAt(trajectory, time)));
}

function groundDrawables(width: number, groundY: number, band: number): Drawable[] {
  return [
    { id: "ground-fill", kind: "rect", x: width / 2, y: groundY + band / 2, w: width, h: band, fill: "fill2", z: 0 },
    line("ground", { x: 2, y: groundY }, { x: width - 2, y: groundY }, "ink", 5, 3),
  ];
}

function groundTicks(originX: number, scale: number, width: number, groundY: number, reading: boolean, busy: { from: number; to: number } | null): Drawable[] {
  const step = niceStep(100 / scale, 1);
  const count = Math.floor((width - originX) / (step * scale));
  return Array.from({ length: count + 1 }, (_, index): Drawable[] => {
    const x = originX + index * step * scale;
    const text = `${fmt(index * step, step < 1 ? 1 : 0)} m`;
    const half = textWidth(text, TICK_TEXT, "read") / 2;
    const shown = reading && index > 0 && x + half <= width && !(busy && x + half > busy.from && x - half < busy.to);
    return [
      line(`tick-${index}`, { x, y: groundY }, { x, y: groundY + 12 }, "edge", 2.5, 2),
      ...(shown ? [textDrawable(`tick-${index}-label`, text, { x, y: groundY + TICK_LABEL_DROP }, { size: TICK_TEXT, fill: "muted", z: 2 })] : []),
    ];
  }).flat();
}

function verticalRuler(x: number, groundY: number, topY: number, scale: number, reading: boolean): Drawable[] {
  const step = niceStep((groundY - topY) / scale, 6);
  const count = Math.floor((groundY - topY) / (step * scale) + 1e-9);
  return [
    line("ruler", { x, y: groundY }, { x, y: topY }, "edge", 2.5, 2),
    ...Array.from({ length: count + 1 }, (_, index): Drawable[] => {
      const y = groundY - index * step * scale;
      return [
        line(`ruler-${index}`, { x: x - 6, y }, { x: x + 12, y }, "edge", 2.5, 2),
        ...(reading && index > 0 ? [textDrawable(`ruler-${index}-label`, `${fmt(index * step, step < 1 ? 1 : 0)} m`, { x: x - 14, y }, { size: TICK_TEXT, fill: "muted", z: 2, anchor: "end" })] : []),
      ];
    }).flat(),
  ];
}

function dimension(id: string, from: Point, to: Point, role: Paint): Drawable[] {
  const across = { x: -(to.y - from.y), y: to.x - from.x };
  const unit = Math.hypot(across.x, across.y) || 1;
  const cap = { x: (across.x / unit) * 9, y: (across.y / unit) * 9 };
  return [
    line(`${id}-span`, from, to, role, 4, 4),
    line(`${id}-start`, { x: from.x - cap.x, y: from.y - cap.y }, { x: from.x + cap.x, y: from.y + cap.y }, role, 4, 4),
    line(`${id}-end`, { x: to.x - cap.x, y: to.y - cap.y }, { x: to.x + cap.x, y: to.y + cap.y }, role, 4, 4),
  ];
}

interface ArrowStyle {
  clear: number;
  lift?: Record<string, Point>;
  shift?: Record<string, Point>;
  edge?: (unit: Point) => number;
  avoid?: Rect[];
}

const LABEL_CLEARANCE = 6;
const LABEL_NUDGE = 4;
const MAX_LABEL_REACH = 400;
const MASS_LABEL_SIDE = 22;
const ARROW_BLOCK = 14;

function textRect(text: string, at: Point, size: number, font: FontRole): Rect {
  const w = textWidth(text, size, font);
  return { x: at.x - w / 2, y: at.y - size * 0.6, w, h: size * 1.2 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + LABEL_CLEARANCE && b.x < a.x + a.w + LABEL_CLEARANCE && a.y < b.y + b.h + LABEL_CLEARANCE && b.y < a.y + a.h + LABEL_CLEARANCE;
}

function arrowFloor(name: string): number {
  return name === "net" ? NET_MIN_PX : ARROW_MIN_PX;
}

interface PlacedArrow {
  name: string;
  unit: Point;
  shift: Point;
  offset: number;
  span: number;
  start: Point;
  tip: Point;
}

function shaftBlocks(from: Point, to: Point): Rect[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / ARROW_BLOCK));
  return Array.from({ length: steps + 1 }, (_, index) => ({ x: lerp(from.x, to.x, index / steps) - ARROW_BLOCK / 2, y: lerp(from.y, to.y, index / steps) - ARROW_BLOCK / 2, w: ARROW_BLOCK, h: ARROW_BLOCK }));
}

function arrows(prefix: string, view: { reading: boolean; vectors: string[] }, at: Point, vectors: Record<string, Point | undefined>, symbols: Record<string, string>, style: ArrowStyle): Drawable[] {
  const placed = view.vectors.flatMap((name): PlacedArrow[] => {
    const delta = vectors[name];
    const length = delta ? Math.hypot(delta.x, delta.y) : 0;
    if (!delta || length < 6) return [];
    const unit = { x: delta.x / length, y: delta.y / length };
    const offset = style.edge ? style.edge(unit) : 0;
    const shift = style.shift?.[name] ?? { x: 0, y: 0 };
    const start = { x: at.x + unit.x * offset + shift.x, y: at.y + unit.y * offset + shift.y };
    const span = Math.max(length, arrowFloor(name));
    return [{ name, unit, shift, offset, span, start, tip: { x: start.x + unit.x * span, y: start.y + unit.y * span } }];
  });
  const taken: Rect[] = [...(style.avoid ?? []), ...placed.flatMap((arrow) => shaftBlocks(arrow.start, arrow.tip))];
  return placed.flatMap(({ name, unit, shift, offset, span, start, tip }): Drawable[] => {
    const role = VECTOR_ROLE[name]!;
    const out: Drawable[] = [{ id: `${prefix}vec-${name}`, kind: "arrow", x: start.x, y: start.y, x2: tip.x, y2: tip.y, stroke: role, strokeWidth: name === "net" ? 6 : 3, z: 5 }];
    if (view.reading) {
      const lift = style.lift?.[name] ?? { x: 0, y: 0 };
      const base = Math.max(offset + span, style.clear) + 26;
      const side = { x: -unit.y, y: unit.x };
      const candidate = (along: number, across: number) => ({ x: at.x + unit.x * (base + along) + side.x * across + shift.x + lift.x, y: at.y + unit.y * (base + along) + side.y * across + shift.y + lift.y });
      const fits = (point: Point) => !taken.some((rect) => overlaps(textRect(symbols[name]!, point, LABEL_TEXT, "mark"), rect));
      let label = candidate(0, 0);
      for (let step = 1; !fits(label) && step * LABEL_NUDGE < MAX_LABEL_REACH; step++) {
        const distance = step * LABEL_NUDGE;
        label = [candidate(0, distance), candidate(0, -distance), candidate(distance, 0), candidate(-distance / 2, distance), candidate(-distance / 2, -distance)].find(fits) ?? label;
      }
      taken.push(textRect(symbols[name]!, label, LABEL_TEXT, "mark"));
      out.push(textDrawable(`${prefix}vec-${name}-label`, symbols[name]!, label, { size: LABEL_TEXT, fill: role, z: 7, font: "mark" }));
    }
    return out;
  });
}

function moving(view: View<unknown>, place: (body: Body) => Point): Drawable[] {
  return view.trail && view.ran ? trace("trail", pathOf(view.trajectory, 0, view.time, Math.min(300, Math.max(2, Math.ceil(view.time * 90))), place), view.role, 6, 4, 0.85) : [];
}

function hold<P>(map: WeakMap<object, P>, key: object, make: () => P): P {
  const found = map.get(key);
  if (found) return found;
  const made = make();
  map.set(key, made);
  return made;
}

const trajectories = new WeakMap<object, Trajectory>();

function runAttempt<P>(kind: Kind<P, any>, params: P, legs: LegSpec[]): { trajectory: Trajectory; failed: number | null } {
  return integrate(kind.system(params), kind.ready(params), legs.map((leg) => kind.events[leg.event]!.make(params, leg.count)));
}

function trajectoryOfAttempt(kind: AnyKind, attempt: Attempt<unknown>): Trajectory {
  return hold(trajectories, attempt, () => runAttempt(kind, attempt.params, attempt.legs).trajectory);
}

function readyTrajectory(kind: AnyKind, params: object): Trajectory {
  return hold(trajectories, params, () => runAttempt(kind, params, []).trajectory);
}

function fullTrajectory(kind: AnyKind, params: object, event: string): Trajectory {
  return hold(fullTrajectories, params, () => runAttempt(kind, params, [{ event, count: 1 }]).trajectory);
}

const fullTrajectories = new WeakMap<object, Trajectory>();

function extremes(trajectory: Trajectory, dim: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let index = dim; index < trajectory.q.length; index += trajectory.dims) {
    min = Math.min(min, trajectory.q[index]!);
    max = Math.max(max, trajectory.q[index]!);
  }
  return { min, max };
}

interface LaunchParams {
  angle: number;
  speed: number;
  height: number;
  gravity: number;
}

interface LaunchLayout {
  size: Size;
  scale: number;
  originX: number;
  groundY: number;
  band: number;
  ball: number;
}

const LAUNCH_W = 1360;
const LAUNCH_APEX_MAX_PX = 400;
const LAUNCH_LEFT = 80;
const LAUNCH_RIGHT = 160;
const LAUNCH_TOP = 10;
const LAUNCH_LABEL_ROOM = 66;
const LAUNCH_G_PX = 5;
const LAUNCH_VELOCITY_PX = 90;

const launchStops = {
  apex: (before: Body, after: Body) => (before.v[1]! > 0 && after.v[1]! <= 0 ? before.v[1]! / (before.v[1]! - after.v[1]!) : null),
  lands: (before: Body, after: Body) => (before.q[1]! > 0 && after.q[1]! <= 0 ? before.q[1]! / (before.q[1]! - after.q[1]!) : null),
};

function launchFlight(params: LaunchParams): Trajectory {
  return fullTrajectory(launch, params, "lands");
}

const launch: Kind<LaunchParams, LaunchLayout> = {
  startOp: "launch",
  spec: {
    angle: "launch angle above the ground in degrees, 1 to 89, default 45",
    speed: "launch speed in m/s, 1 to 200, default 20",
    height: "launch height above the ground in m, 0 to 100, default 0",
    gravity: "optional gravity in m/s^2, 0.5 to 30, default 9.81 (the Moon is 1.62)",
  },
  settable: { angle: "degrees", speed: "m/s", height: "m", gravity: "m/s^2" },
  runArgs: '{"until": "lands"} or {"until": "apex"}, default lands',
  vectors: { velocity: "the velocity, tangent to the path", gravity: "the downward pull, constant everywhere" },
  marks: { apex: "ring at the highest point with its height", range: "ruler along the ground from launch to landing with the distance" },
  ghosts: true,
  events: {
    apex: { terminal: false, stuck: "the ball never reached its highest point", make: () => () => ({ stop: launchStops.apex, maxSteps: MAX_STEPS }) },
    lands: { terminal: true, stuck: "the ball did not land within 160 s; lower the speed", make: () => () => ({ stop: launchStops.lands, maxSteps: MAX_STEPS }) },
  },
  init(spec, objectId) {
    return launch.change({ angle: 45, speed: 20, height: 0, gravity: GRAVITY }, spec, objectId);
  },
  change(params, args, who = "op set") {
    return {
      angle: boundedNumber(args, "angle", params.angle, 1, 89, who, " degrees"),
      speed: boundedNumber(args, "speed", params.speed, 1, 200, who, " m/s"),
      height: boundedNumber(args, "height", params.height, 0, 100, who, " m"),
      gravity: boundedNumber(args, "gravity", params.gravity, 0.5, 30, who, " m/s^2"),
    };
  },
  system: (params) => ({ step: SIM_STEP, accel: () => [0, -params.gravity] }),
  ready: (params) => ({ q: [0, params.height], v: [params.speed * Math.cos(rad(params.angle)), params.speed * Math.sin(rad(params.angle))] }),
  legSpec(_params, args) {
    const until = args.until ?? "lands";
    if (until !== "apex" && until !== "lands") fail(`op argument "until" must be "apex" or "lands", got ${JSON.stringify(until)}`);
    return { event: until, count: 1 };
  },
  seconds: (_params, span) => clamp01Seconds(span),
  layout(all, reading, showing) {
    const flights = all.map((params) => launchFlight(params));
    const ball = reading ? 16 : 26;
    const band = reading ? 130 : 78;
    const range = Math.max(...flights.map((flight) => extremes(flight, 0).max), 1e-6);
    const apex = Math.max(...flights.map((flight) => extremes(flight, 1).max), 1e-6);
    const scale = Math.min((LAUNCH_W - LAUNCH_LEFT - LAUNCH_RIGHT) / range, LAUNCH_APEX_MAX_PX / apex);
    const groundY = (showing.apex && reading ? ball + LAUNCH_LABEL_ROOM : ball + LAUNCH_TOP) + apex * scale + ball;
    return { size: { w: LAUNCH_W, h: groundY + band }, scale, originX: LAUNCH_LEFT, groundY, band, ball };
  },
  scene(layout, view) {
    const { scale, originX, groundY, ball, band } = layout;
    const place = (body: Body): Point => ({ x: originX + body.q[0]! * scale, y: groundY - ball - Math.max(0, body.q[1]!) * scale });
    const at = place(bodyAt(view.trajectory, view.time));
    const body = bodyAt(view.trajectory, view.time);
    const start = place(bodyAt(view.trajectory, 0));
    const aim = rad(view.params.angle);
    const out: Drawable[] = [...groundDrawables(layout.size.w, groundY, band), ...groundTicks(originX, scale, layout.size.w, groundY, view.reading, view.vectors.length > 0 && at.y + 90 > groundY ? { from: at.x - 50, to: at.x + 130 } : null)];
    if (view.params.height > 0) out.push({ id: "pillar", kind: "rect", x: originX - 30, y: (start.y + ball + groundY) / 2, w: 48, h: groundY - start.y - ball, fill: "fill2", stroke: "edge", strokeWidth: 3, z: 1 });
    out.push(
      line("barrel", start, { x: start.x + 64 * Math.cos(aim), y: start.y - 64 * Math.sin(aim) }, "edge", 16, 2, { opacity: 1 }),
      circle("mount", start, ball + 8, "fill2", "edge", 3, 1),
    );
    view.ghosts.forEach((ghost, index) => {
      const landing = bodyAt(ghost.trajectory, endTime(ghost.trajectory));
      const landed = { x: originX + landing.q[0]! * scale, y: groundY };
      out.push(
        ...trace(`ghost-${index}`, pathOf(ghost.trajectory, 0, endTime(ghost.trajectory), 160, place), ghost.role, 5, 3, 0.55),
        circle(`ghost-${index}-landing`, landed, 11, ghost.role, "ground", 3, 4),
      );
      if (view.reading) out.push(textDrawable(`ghost-${index}-range`, `${fmt(landing.q[0]!)} m`, { x: landed.x, y: groundY + 92 }, { size: LABEL_TEXT, fill: ghost.role, z: 4 }));
    });
    out.push(...moving(view, place));
    out.push(circle("body", at, ball, view.role, "ink", 3, 6));
    out.push(...arrows("", view, at, {
      velocity: { x: body.v[0]! * (LAUNCH_VELOCITY_PX / view.params.speed), y: -body.v[1]! * (LAUNCH_VELOCITY_PX / view.params.speed) },
      gravity: { x: 0, y: view.params.gravity * LAUNCH_G_PX },
    }, { velocity: "v", gravity: "g" }, { clear: ball + 8 }));
    const path = view.trajectory;
    const apexAt = bodyAt(path, path.times[argMax(path, 1)]!);
    const landing = bodyAt(path, endTime(path));
    view.marks.forEach((mark) => {
      if (mark === "apex") {
        const top = place(apexAt);
        out.push(
          circle("mark-apex-ring", top, ball + 12, "none", "ink", 4, 5),
          line("mark-apex-drop", { x: top.x, y: top.y + ball + 12 }, { x: top.x, y: groundY }, "muted", 2.5, 2),
        );
        if (view.reading) out.push(textDrawable("mark-apex-label", `apex ${fmt(apexAt.q[1]!)} m`, { x: top.x, y: top.y - ball - 42 }, { size: LABEL_TEXT, z: 5 }));
      } else {
        const y = groundY + (view.reading ? 24 : 42);
        const end = originX + landing.q[0]! * scale;
        out.push(...dimension("mark-range", { x: originX, y }, { x: end, y }, "ink"));
        if (view.reading) out.push(textDrawable("mark-range-label", `range ${fmt(landing.q[0]!)} m`, { x: (originX + end) / 2, y: y + 28 }, { size: LABEL_TEXT, z: 5 }));
      }
    });
    return out;
  },
  header: (_params, body, time) => [readout(`t ${fmt(time, 2)} s`, "t 88.88 s"), readout(`speed ${fmt(Math.hypot(body.v[0]!, body.v[1]!))} m/s`, "speed 888.8 m/s"), readout(`height ${fmt(Math.max(0, body.q[1]!))} m`, "height 8888.8 m"), readout(`range ${fmt(body.q[0]!)} m`, "range 8888.8 m")],
};

function argMax(trajectory: Trajectory, dim: number): number {
  let best = 0;
  for (let index = 1; index < trajectory.times.length; index++) {
    if (trajectory.q[index * trajectory.dims + dim]! > trajectory.q[best * trajectory.dims + dim]!) best = index;
  }
  return best;
}

function clamp01Seconds(span: number): number {
  return Math.min(RUN_MAX_SECONDS, Math.max(RUN_MIN_SECONDS, span));
}

interface DropParams {
  height: number;
  masses: number[];
  gravity: number;
}

interface DropLayout {
  size: Size;
  scale: number;
  groundY: number;
  band: number;
  radii: number[];
  xs: number[];
  top: number;
}

const DROP_W = 760;
const DROP_H = 590;
const DROP_TOP = 56;
const DROP_PITCH = 180;
const STROBE_DOT = 6;
const STROBE_GAP = 20;

const drop: Kind<DropParams, DropLayout> = {
  startOp: "release",
  spec: {
    height: "release height in m, 0.5 to 200, default 10",
    masses: "optional list of 2 or 3 masses in kg, each 0.1 to 100, default [1, 5]; the bigger one is drawn bigger, and they still land together",
    gravity: "optional gravity in m/s^2, 0.5 to 30, default 9.81",
  },
  settable: { height: "m", masses: "list of kg", gravity: "m/s^2" },
  runArgs: "no arguments; both objects fall until they land",
  vectors: { velocity: "the downward velocity", gravity: "the downward pull, the same on every object" },
  marks: { height: "ruler from the ground up to the release height with the distance" },
  ghosts: false,
  events: {
    lands: {
      terminal: true,
      stuck: "the objects did not land within 160 s",
      make: () => () => ({
        stop: (before, after) => (before.q.some((height) => height > 0) && after.q.every((height) => height <= 0) ? Math.max(...before.q.map((height, index) => (height > 0 ? height / (height - after.q[index]!) : 0))) : null),
        maxSteps: MAX_STEPS,
      }),
    },
  },
  init(spec, objectId) {
    return drop.change({ height: 10, masses: [1, 5], gravity: GRAVITY }, spec, objectId);
  },
  change(params, args, who = "op set") {
    const masses = args.masses ?? params.masses;
    if (!Array.isArray(masses) || masses.length < 2 || masses.length > 3 || masses.some((mass) => typeof mass !== "number" || !(mass >= 0.1 && mass <= 100))) {
      fail(`${who}: "masses" must be a list of 2 or 3 numbers from 0.1 to 100 kg, such as [1, 5], got ${JSON.stringify(masses)}`);
    }
    return {
      height: boundedNumber(args, "height", params.height, 0.5, 200, who, " m"),
      masses: masses as number[],
      gravity: boundedNumber(args, "gravity", params.gravity, 0.5, 30, who, " m/s^2"),
    };
  },
  system: (params) => ({ step: SIM_STEP, accel: (q) => q.map(() => -params.gravity) }),
  ready: (params) => ({ q: params.masses.map(() => params.height), v: params.masses.map(() => 0) }),
  legSpec: () => ({ event: "lands", count: 1 }),
  seconds: (_params, span) => clamp01Seconds(span),
  layout(all, reading) {
    const params = all[0]!;
    const base = reading ? 20 : 30;
    const radii = params.masses.map((mass) => Math.min(64, Math.max(12, base * Math.cbrt(mass))));
    const band = reading ? 100 : 70;
    const groundY = DROP_H - band;
    const scale = (groundY - DROP_TOP - 2 * Math.max(...radii)) / Math.max(...all.map((one) => one.height));
    const xs = params.masses.map((_, index) => DROP_W / 2 + 30 + (index - (params.masses.length - 1) / 2) * DROP_PITCH);
    return { size: { w: DROP_W, h: DROP_H }, scale, groundY, band, radii, xs, top: groundY - params.height * scale };
  },
  scene(layout, view) {
    const { scale, groundY, band, radii, xs } = layout;
    const body = bodyAt(view.trajectory, view.time);
    const ballRoles: Role[] = ["accent", "series3", "series5"];
    const vscale = VELOCITY_PX / Math.sqrt(2 * view.params.gravity * view.params.height);
    const heightAt = (index: number, height: number) => groundY - radii[index]! - Math.max(0, height) * scale;
    const out: Drawable[] = [...groundDrawables(layout.size.w, groundY, band), ...verticalRuler(96, groundY, layout.top - Math.max(...radii), scale, view.reading)];
    out.push(line("release-line", { x: 110, y: layout.top }, { x: xs[xs.length - 1]! + radii[xs.length - 1]! + 40, y: layout.top }, "edge", 2, 1));
    view.params.masses.forEach((mass, index) => {
      const at = { x: xs[index]!, y: heightAt(index, body.q[index]!) };
      const role = ballRoles[index]!;
      if (view.trail && view.ran) {
        const stride = niceStep(endTime(view.trajectory), 8);
        let last = Infinity;
        for (let tick = 1; tick * stride <= endTime(view.trajectory) + 1e-9; tick++) {
          const y = heightAt(index, bodyAt(view.trajectory, tick * stride).q[index]!);
          if (Math.abs(y - last) < STROBE_GAP) continue;
          last = y;
          if (tick * stride <= view.time + 1e-9) out.push(circle(`strobe-${index}-${tick}`, { x: xs[index]!, y }, STROBE_DOT, role, "none", 0, 3, { opacity: 0.55 }));
        }
      }
      out.push(circle(`body-${index}`, at, radii[index]!, role, "ink", 3, 6, { part: `${view.objectId}[${index}]` }));
      const massText = `${fmt(mass, mass < 10 ? 1 : 0)} kg`;
      const massAt = { x: xs[index]! + MASS_LABEL_SIDE + textWidth(massText, LABEL_TEXT, "read") / 2, y: groundY + 42 };
      out.push(...arrows(`${index}-`, view, at, {
        velocity: { x: 0, y: -body.v[index]! * vscale },
        gravity: { x: 0, y: view.params.gravity * LAUNCH_G_PX },
      }, { velocity: "v", gravity: "g" }, { clear: radii[index]! + 6, avoid: view.reading ? [textRect(massText, massAt, LABEL_TEXT, "read")] : [] }));
      if (view.reading) out.push(textDrawable(`mass-${index}`, massText, massAt, { size: LABEL_TEXT, fill: role, z: 4 }));
    });
    if (view.marks.includes("height")) {
      const x = DROP_W - 60;
      out.push(...dimension("mark-height", { x, y: groundY }, { x, y: layout.top }, "ink"));
      if (view.reading) out.push(textDrawable("mark-height-label", `height ${fmt(view.params.height)} m`, { x: DROP_W - 12, y: layout.top - 34 }, { size: LABEL_TEXT, z: 5, anchor: "end" }));
    }
    return out;
  },
  header: (_params, body, time) => [readout(`t ${fmt(time, 2)} s`, "t 88.88 s"), readout(`speed ${fmt(Math.abs(body.v[0]!))} m/s`, "speed 888.8 m/s"), readout(`height ${fmt(Math.max(0, body.q[0]!))} m`, "height 888.8 m")],
};

interface RampParams {
  angle: number;
  friction: number;
  length: number;
  gravity: number;
}

interface RampLayout {
  size: Size;
  scale: number;
  block: number;
  top: Point;
  bottom: Point;
  groundY: number;
  band: number;
}

const RAMP_W = 1180;
const RAMP_H = 580;
const RAMP_LEFT = 150;
const RAMP_RIGHT = 220;
const RAMP_TOP = 180;
const RAMP_MARGIN = 0.12;
const RAMP_ARROW_PX = 80;

function rampRunout(angle: number, reading: boolean): number {
  return RAMP_ARROW_PX + (reading ? 24 + 14 / Math.sin(rad(angle)) : 12 + 8 / Math.sin(rad(angle)));
}

function slides(params: RampParams): boolean {
  return Math.tan(rad(params.angle)) > params.friction + 1e-12;
}

function slideAccel(params: RampParams): number {
  return slides(params) ? params.gravity * (Math.sin(rad(params.angle)) - params.friction * Math.cos(rad(params.angle))) : 0;
}

const ramp: Kind<RampParams, RampLayout> = {
  startOp: "release",
  spec: {
    angle: "slope angle in degrees, 5 to 80, default 30",
    friction: "friction coefficient, 0 to 2, default 0.2; the block slides exactly when tan(angle) is bigger than this",
    length: "distance the block can travel along the slope in m, 0.5 to 20, default 3",
    gravity: "optional gravity in m/s^2, 0.5 to 30, default 9.81",
  },
  settable: { angle: "degrees", friction: "coefficient", length: "m", gravity: "m/s^2" },
  runArgs: "no arguments; the block slides to the bottom, or stays put for 1.5 s if friction holds it",
  vectors: {
    velocity: "the block's velocity along the slope",
    gravity: "weight, straight down",
    normal: "the push of the surface, straight out of the slope",
    friction: "friction along the slope, up the slope; it holds the block when it stays",
    net: "the sum of the forces, which is zero when the block stays",
  },
  marks: { angle: "arc at the foot of the slope with the angle" },
  ghosts: false,
  events: {
    bottom: {
      terminal: true,
      stuck: "the block did not reach the bottom within 160 s",
      make: (params) => () => ({ stop: (before, after) => (before.q[0]! < params.length && after.q[0]! >= params.length ? (params.length - before.q[0]!) / (after.q[0]! - before.q[0]!) : null), maxSteps: MAX_STEPS }),
    },
    rest: {
      terminal: true,
      stuck: "the block did not settle",
      make: () => () => {
        let elapsed = 0;
        return {
          stop: () => {
            elapsed += SIM_STEP;
            return elapsed >= REST_SECONDS - 1e-9 ? 1 : null;
          },
          maxSteps: MAX_STEPS,
        };
      },
    },
  },
  init(spec, objectId) {
    return ramp.change({ angle: 30, friction: 0.2, length: 3, gravity: GRAVITY }, spec, objectId);
  },
  change(params, args, who = "op set") {
    return {
      angle: boundedNumber(args, "angle", params.angle, 5, 80, who, " degrees"),
      friction: boundedNumber(args, "friction", params.friction, 0, 2, who),
      length: boundedNumber(args, "length", params.length, 0.5, 20, who, " m"),
      gravity: boundedNumber(args, "gravity", params.gravity, 0.5, 30, who, " m/s^2"),
    };
  },
  system: (params) => ({ step: SIM_STEP, accel: () => [slideAccel(params)] }),
  ready: () => ({ q: [0], v: [0] }),
  legSpec: (params) => ({ event: slides(params) ? "bottom" : "rest", count: 1 }),
  seconds: (_params, span) => clamp01Seconds(span),
  layout(all, reading) {
    const params = all[0]!;
    const block = reading ? 72 : 88;
    const band = reading ? 130 : 100;
    const groundY = RAMP_H - band;
    const surface = rad(params.angle);
    const room = { w: RAMP_W - RAMP_LEFT - RAMP_RIGHT, h: groundY - RAMP_TOP };
    const runout = rampRunout(params.angle, reading);
    const fixed = block * (1 + RAMP_MARGIN) + runout;
    const scale = Math.min((room.w / Math.cos(surface) - fixed) / params.length, (room.h / Math.sin(surface) - fixed) / params.length);
    const length = params.length * scale + fixed;
    const bottom = { x: RAMP_W - RAMP_RIGHT, y: groundY };
    return { size: { w: RAMP_W, h: RAMP_H }, scale, block, bottom, top: { x: bottom.x - length * Math.cos(surface), y: groundY - length * Math.sin(surface) }, groundY, band };
  },
  scene(layout, view) {
    const { block, top, bottom, groundY, scale, band } = layout;
    const theta = rad(view.params.angle);
    const direction = { x: Math.cos(theta), y: Math.sin(theta) };
    const normal = { x: Math.sin(theta), y: -Math.cos(theta) };
    const place = (body: Body): Point => ({
      x: top.x + direction.x * (block * (0.5 + RAMP_MARGIN) + body.q[0]! * scale) + normal.x * (block / 2),
      y: top.y + direction.y * (block * (0.5 + RAMP_MARGIN) + body.q[0]! * scale) + normal.y * (block / 2),
    });
    const body = bodyAt(view.trajectory, view.time);
    const at = place(body);
    const sliding = slides(view.params);
    const weight: Point = { x: 0, y: RAMP_ARROW_PX };
    const push: Point = { x: normal.x * RAMP_ARROW_PX * Math.cos(theta), y: normal.y * RAMP_ARROW_PX * Math.cos(theta) };
    const grip = sliding ? view.params.friction * Math.cos(theta) : Math.sin(theta);
    const drag: Point = { x: -direction.x * RAMP_ARROW_PX * grip, y: -direction.y * RAMP_ARROW_PX * grip };
    const fastest = Math.sqrt(2 * Math.abs(slideAccel(view.params)) * view.params.length) || 1;
    const net = sum([weight, push, drag]);
    const speedPx = Math.max(Math.abs(body.v[0]!) * (RAMP_ARROW_PX / fastest), ARROW_MIN_PX);
    const netPx = Math.max(Math.hypot(net.x, net.y), NET_MIN_PX);
    const beyondVelocity = Math.max(speedPx - netPx, 0) + 40;
    const out: Drawable[] = [
      ...groundDrawables(layout.size.w, groundY, band),
      { id: "wedge", kind: "path", x: 0, y: 0, points: [top.x, top.y, bottom.x, bottom.y, top.x, groundY], closed: true, fill: "fill2", stroke: "edge", strokeWidth: 3, z: 1 },
      line("slope", top, bottom, "ink", 6, 3),
      ...moving(view, place),
      { id: "body", kind: "rect", x: at.x, y: at.y, w: block, h: block, rotation: view.params.angle, fill: view.role, stroke: "ink", strokeWidth: 4, radius: 0.18, z: 6 },
      ...arrows("", view, at, {
        velocity: { x: direction.x * body.v[0]! * (RAMP_ARROW_PX / fastest), y: direction.y * body.v[0]! * (RAMP_ARROW_PX / fastest) },
        gravity: weight,
        normal: push,
        friction: drag,
        net,
      }, { velocity: "v", gravity: "W", normal: "N", friction: "f", net: "net" }, {
        clear: 0,
        edge: (unit) => (block / 2 + 3) / Math.max(Math.abs(unit.x * direction.x + unit.y * direction.y), Math.abs(unit.x * normal.x + unit.y * normal.y)),
        shift: { velocity: { x: normal.x * block * 0.4, y: normal.y * block * 0.4 }, friction: { x: normal.x * block * 0.3, y: normal.y * block * 0.3 } },
        lift: { net: { x: direction.x * beyondVelocity + normal.x * 8, y: direction.y * beyondVelocity + normal.y * 8 }, velocity: { x: normal.x * 20, y: normal.y * 20 } },
      }),
    ];
    if (view.marks.includes("angle")) {
      const radius = 78;
      out.push({ id: "mark-angle-arc", kind: "path", x: 0, y: 0, points: timesBetween(0, theta, 16).flatMap((phi) => [bottom.x - radius * Math.cos(phi), bottom.y - radius * Math.sin(phi)]), fill: "none", stroke: "ink", strokeWidth: 5, z: 5 });
      const parked = (rampRunout(view.params.angle, view.reading) + block / 2) * Math.cos(theta);
      if (view.reading) out.push(textDrawable("mark-angle-label", `${fmt(view.params.angle, 0)}°`, { x: bottom.x + (parked > 110 ? -60 : 60), y: bottom.y + 34 }, { size: LABEL_TEXT + 4, z: 5 }));
    }
    return out;
  },
  header: (params, body, time) => [readout(`angle ${fmt(params.angle, 0)}°`, "angle 88°"), readout(`friction ${fmt(params.friction, 2)}`, "friction 8.88"), readout(`speed ${fmt(Math.abs(body.v[0]!))} m/s`, "speed 88.8 m/s"), readout(`t ${fmt(time, 2)} s`, "t 88.88 s")],
};

interface PendulumParams {
  length: number;
  angle: number;
  damping: number;
  gravity: number;
}

interface PendulumLayout {
  size: Size;
  pxPerM: number;
  pivot: Point;
  ball: number;
}

const PENDULUM_LONGEST_PX = 520;
const PENDULUM_TOP = 54;
const PENDULUM_SIDE = 260;
const PENDULUM_BELOW = 36;
const PENDULUM_BELOW_LABEL = 96;
const PENDULUM_BELOW_FORCES = 190;
const PENDULUM_FORCE_PX = 90;

function pendulumAnchor(pivot: Point, length: number, theta: number): Point {
  return { x: pivot.x + length * Math.sin(theta), y: pivot.y + length * Math.cos(theta) };
}

const pendulum: Kind<PendulumParams, PendulumLayout> = {
  startOp: "swing",
  spec: {
    length: "rod length in m, 0.5 to 4, default 1",
    angle: "start angle from straight down in degrees, 2 to 90, default 30",
    damping: "optional air drag rate per second, 0 to 1, default 0 (no loss); the swings shrink when above 0",
    gravity: "optional gravity in m/s^2, 0.5 to 30, default 9.81",
  },
  settable: { length: "m", angle: "degrees", damping: "per second", gravity: "m/s^2" },
  runArgs: '{"swings": 2}; a swing is out and back to the start side, halves like 0.5 are allowed, 0.5 to 20, default 1',
  vectors: {
    velocity: "the velocity, along the arc",
    gravity: "weight, straight down",
    tension: "the pull of the rod toward the pivot",
    net: "the sum of weight and tension, which points to where the bob speeds up",
  },
  marks: { lowest: "ring at the lowest point with the fastest speed", highest: "ring at the start point with how high it is above the lowest point", angle: "arc at the pivot with the start angle" },
  ghosts: false,
  events: {
    turns: {
      terminal: false,
      stuck: "the pendulum stopped swinging before it made that many swings; ask for fewer swings or less damping",
      make: (_params, count) => () => {
        let seen = 0;
        return {
          stop: (before, after) => {
            if (Math.abs(before.v[0]!) < 1e-9 || before.v[0]! * after.v[0]! >= 0) return null;
            seen += 1;
            return seen === count ? before.v[0]! / (before.v[0]! - after.v[0]!) : null;
          },
          maxSteps: MAX_STEPS,
        };
      },
    },
  },
  init(spec, objectId) {
    return pendulum.change({ length: 1, angle: 30, damping: 0, gravity: GRAVITY }, spec, objectId);
  },
  change(params, args, who = "op set") {
    return {
      length: boundedNumber(args, "length", params.length, 0.5, 4, who, " m"),
      angle: boundedNumber(args, "angle", params.angle, 2, 90, who, " degrees"),
      damping: boundedNumber(args, "damping", params.damping, 0, 1, who, " per second"),
      gravity: boundedNumber(args, "gravity", params.gravity, 0.5, 30, who, " m/s^2"),
    };
  },
  system: (params) => ({ step: SIM_STEP, damping: params.damping, accel: (q) => [-(params.gravity / params.length) * Math.sin(q[0]!)] }),
  ready: (params) => ({ q: [rad(params.angle)], v: [0] }),
  legSpec(_params, args) {
    const swings = boundedNumber(args, "swings", 1, 0.5, 20, 'op argument');
    if (Math.abs(swings * 2 - Math.round(swings * 2)) > 1e-9) fail(`op argument "swings" must be a multiple of 0.5, got ${swings}`);
    return { event: "turns", count: Math.round(swings * 2) };
  },
  seconds: (_params, span) => clamp01Seconds(span),
  layout(all, reading, showing) {
    const longest = Math.max(...all.map((params) => params.length));
    const pxPerM = PENDULUM_LONGEST_PX / longest;
    const reach = Math.max(...all.map((params) => Math.sin(Math.min(rad(params.angle), Math.PI / 2)) * params.length)) * pxPerM;
    const half = Math.max(reach, 100) + PENDULUM_SIDE;
    return { size: { w: 2 * half, h: PENDULUM_TOP + PENDULUM_LONGEST_PX + (showing.vectors ? PENDULUM_BELOW_FORCES : showing.lowest ? PENDULUM_BELOW_LABEL : PENDULUM_BELOW) }, pxPerM, pivot: { x: half, y: PENDULUM_TOP }, ball: reading ? 26 : 38 };
  },
  scene(layout, view) {
    const { pivot, ball } = layout;
    const length = view.params.length * layout.pxPerM;
    const place = (body: Body): Point => pendulumAnchor(pivot, length, body.q[0]!);
    const body = bodyAt(view.trajectory, view.time);
    const theta = body.q[0]!;
    const start = rad(view.params.angle);
    const at = place(body);
    const lowest = { x: pivot.x, y: pivot.y + length };
    const speed = length * body.v[0]!;
    const fastest = Math.sqrt(2 * view.params.gravity * view.params.length * (1 - Math.cos(start))) * layout.pxPerM || 1;
    const weight: Point = { x: 0, y: PENDULUM_FORCE_PX };
    const pull = ((view.params.gravity * Math.cos(theta) + view.params.length * body.v[0]! ** 2) / view.params.gravity) * PENDULUM_FORCE_PX;
    const tension: Point = { x: -Math.sin(theta) * pull, y: -Math.cos(theta) * pull };
    const out: Drawable[] = [
      { id: "ceiling", kind: "rect", x: pivot.x, y: pivot.y - 10, w: 200, h: 20, fill: "fill2", stroke: "edge", strokeWidth: 3, z: 1 },
      ...trace("guide", timesBetween(-start, start, 40).map((phi) => ({ x: pivot.x + length * Math.sin(phi), y: pivot.y + length * Math.cos(phi) })), "edge", 2.5, 1, 0.6),
      line("plumb", pivot, lowest, "rule", 2.5, 1),
      ...moving(view, place),
      line("rod", pivot, at, "ink", 5, 4),
      circle("pivot", pivot, 9, "ink", "none", 0, 7),
      circle("body", at, ball, view.role, "ink", 3, 6),
      ...arrows("", view, at, {
        velocity: { x: speed * Math.cos(theta) * (VELOCITY_PX / fastest) / 1, y: -speed * Math.sin(theta) * (VELOCITY_PX / fastest) },
        gravity: weight,
        tension,
        net: sum([weight, tension]),
      }, { velocity: "v", gravity: "W", tension: "T", net: "net" }, { clear: ball + 8, lift: { tension: { x: Math.cos(theta) * 30, y: -Math.sin(theta) * 30 }, net: { x: -Math.sign(theta) * Math.cos(theta) * 30 - Math.sin(theta) * 36, y: Math.sign(theta) * Math.sin(theta) * 30 - Math.cos(theta) * 48 } } }),
    ];
    view.marks.forEach((mark) => {
      if (mark === "lowest") {
        const peak = Math.max(...Array.from({ length: view.trajectory.times.length }, (_, index) => Math.abs(view.trajectory.v[index]!))) * view.params.length;
        out.push(circle("mark-lowest-ring", lowest, ball + 12, "none", "ink", 4, 5));
        if (view.reading) out.push(textDrawable("mark-lowest-label", `fastest ${fmt(peak)} m/s`, { x: lowest.x, y: lowest.y + 72 }, { size: LABEL_TEXT, z: 5 }));
      } else if (mark === "highest") {
        const top = pendulumAnchor(pivot, length, start);
        out.push(circle("mark-highest-ring", top, ball + 12, "none", "ink", 4, 5));
        if (view.reading) out.push(textDrawable("mark-highest-label", `${fmt(view.params.length * (1 - Math.cos(start)), 2)} m up`, { x: top.x + ball + 24, y: top.y }, { size: LABEL_TEXT, z: 5, anchor: "start" }));
      } else {
        out.push({ id: "mark-angle-arc", kind: "path", x: 0, y: 0, points: timesBetween(0, start, 16).flatMap((phi) => [pivot.x + 78 * Math.sin(phi), pivot.y + 78 * Math.cos(phi)]), fill: "none", stroke: "ink", strokeWidth: 5, z: 5 });
        if (view.reading) out.push(textDrawable("mark-angle-label", `${fmt(view.params.angle, 0)}°`, { x: pivot.x + 124 * Math.sin(start / 2), y: pivot.y + 124 * Math.cos(start / 2) }, { size: LABEL_TEXT + 4, z: 5 }));
      }
    });
    return out;
  },
  header: (params, body, time) => [readout(`length ${fmt(params.length, 2)} m`, "length 88.88 m"), readout(`angle ${fmt((body.q[0]! * 180) / Math.PI, 0)}°`, "angle -888°"), readout(`speed ${fmt(Math.abs(body.v[0]!) * params.length, 2)} m/s`, "speed 88.88 m/s"), readout(`t ${fmt(time, 2)} s`, "t 88.88 s")],
};

interface Planet {
  id: string;
  distance: number;
  speed: number;
}

interface OrbitParams {
  planets: Planet[];
}

interface OrbitLayout {
  size: Size;
  scale: number;
  center: Point;
  planet: number;
  sun: number;
}

const ORBIT_W = 1300;
const ORBIT_H = 780;
const ORBIT_PAD = 60;
const ORBIT_MAX_PLANETS = 4;

function orbitSemiMajor(planet: Planet): number {
  return planet.distance / (2 - planet.speed ** 2);
}

function orbitFarthest(planet: Planet): number {
  return Math.max(planet.distance, 2 * orbitSemiMajor(planet) - planet.distance);
}

function planetStart(planet: Planet): Body {
  return { q: [planet.distance, 0], v: [0, planet.speed * Math.sqrt(GM / planet.distance)] };
}

function orbitSystem(params: OrbitParams): System {
  return {
    step: ORBIT_STEP,
    accel: (q) => params.planets.flatMap((_, index) => {
      const x = q[2 * index]!;
      const y = q[2 * index + 1]!;
      const pull = -GM / Math.hypot(x, y) ** 3;
      return [pull * x, pull * y];
    }),
  };
}

function orbitGuide(planet: Planet): Trajectory {
  return hold(trajectories, planet, () => integrate(orbitSystem({ planets: [planet] }), planetStart(planet), [orbitEvents.orbits!.make({ planets: [planet] }, 1)]).trajectory);
}

const orbitEvents: Record<string, EventDef<OrbitParams>> = {
  orbits: {
    terminal: false,
    stuck: "that run is too long to simulate; ask for fewer orbits or planets nearer the sun",
    make: (_params, count) => () => {
      let swept = 0;
      const target = 2 * Math.PI * count;
      return {
        stop: (before, after) => {
          let turn = Math.atan2(after.q[1]!, after.q[0]!) - Math.atan2(before.q[1]!, before.q[0]!);
          if (turn > Math.PI) turn -= 2 * Math.PI;
          if (turn < -Math.PI) turn += 2 * Math.PI;
          const done = swept + turn >= target - 1e-12 ? (target - swept) / turn : null;
          swept += turn;
          return done;
        },
        maxSteps: ORBIT_MAX_STEPS,
      };
    },
  },
};

function planetOf(params: OrbitParams, name: unknown, who: string): Planet {
  if (name === undefined) return params.planets[0]!;
  const found = params.planets.find((planet) => planet.id === name);
  if (!found) fail(`${who}: no planet "${String(name)}"; planets are ${params.planets.map((planet) => `"${planet.id}"`).join(", ")}`);
  return found;
}

function readPlanets(raw: unknown, objectId: string): Planet[] {
  const example = '"planets": [{"id":"Earth","distance":1},{"id":"Mars","distance":1.52}]';
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ORBIT_MAX_PLANETS) fail(`${objectId}: "planets" must be a list of 1 to ${ORBIT_MAX_PLANETS} planets such as ${example}`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail(`${objectId}: planets[${index}] must be an object such as {"id":"Earth","distance":1}`);
    const fields = entry as Args;
    const where = `${objectId}: planets[${index}]`;
    onlyKeys(fields, ["id", "distance", "speed"], where);
    const id = fields.id ?? `P${index + 1}`;
    if (typeof id !== "string" || id.trim() === "" || id.length > 8) fail(`${where} "id" must be text of 1 to 8 characters`);
    if (seen.has(id)) fail(`${objectId}: planet id "${id}" appears twice; ids must be unique`);
    seen.add(id);
    return { id, distance: boundedNumber(fields, "distance", 1, 0.3, 10, where, " AU"), speed: boundedNumber(fields, "speed", 1, 0.6, 1.3, where) };
  });
}

const orbit: Kind<OrbitParams, OrbitLayout> = {
  startOp: "orbit",
  spec: {
    planets: 'list of 1 to 4 planets {"id":"Earth","distance":1,"speed":1}; distance is the start distance from the sun in AU, 0.3 to 10; speed is the start speed as a fraction of the circular speed there, 0.6 to 1.3, default 1 (a circle), below 1 gives a stretched ellipse that starts at its farthest point, above 1 starts at its nearest point; all planets start on the right of the sun and circle counterclockwise; the sun is fixed and the planets do not pull on each other; time is in years',
  },
  settable: { speed: "start speed fraction for every planet, or one planet with \"planet\": \"Mars\"", distance: "start distance in AU for every planet, or one planet with \"planet\": \"Mars\"" },
  runArgs: '{"orbits": 1}; run until the first planet has gone round this many times, 0.25 to 20, default 1; the other planets move for the same time',
  vectors: { velocity: "the velocity, tangent to the orbit", gravity: "the pull toward the sun, bigger when the planet is closer" },
  marks: { perihelion: 'ring at the nearest point of one planet ("planet": id, default the first) with its distance', aphelion: 'ring at the farthest point of one planet ("planet": id, default the first) with its distance' },
  ghosts: false,
  events: orbitEvents,
  init(spec, objectId) {
    return { planets: readPlanets(spec.planets ?? [{ distance: 1 }], objectId) };
  },
  change(params, args, who = "op set") {
    onlyKeys(args, ["speed", "distance", "planet"], who);
    if (args.speed === undefined && args.distance === undefined) fail(`${who}: give "speed" or "distance"`);
    const target = args.planet === undefined ? undefined : planetOf(params, args.planet, who);
    return {
      planets: params.planets.map((planet) => (target && planet !== target
        ? planet
        : { ...planet, distance: boundedNumber(args, "distance", planet.distance, 0.3, 10, who, " AU"), speed: boundedNumber(args, "speed", planet.speed, 0.6, 1.3, who) })),
    };
  },
  system: orbitSystem,
  ready: (params) => ({ q: params.planets.flatMap((planet) => planetStart(planet).q), v: params.planets.flatMap((planet) => planetStart(planet).v) }),
  legSpec(_params, args) {
    return { event: "orbits", count: boundedNumber(args, "orbits", 1, 0.25, 20, "op argument") };
  },
  seconds: (params, span) => {
    const first = params.planets[0]!;
    return Math.min(ORBIT_MAX_SECONDS, Math.max(ORBIT_MIN_SECONDS, (ORBIT_SECONDS_PER_ORBIT * span) / orbitSemiMajor(first) ** 1.5));
  },
  layout(all, reading) {
    const params = all[0]!;
    const reach = Math.max(...params.planets.map(orbitFarthest));
    const nearest = Math.min(...params.planets.map((planet) => Math.min(planet.distance, 2 * orbitSemiMajor(planet) - planet.distance)));
    const planet = reading ? 12 : 20;
    const scale = (ORBIT_H / 2 - ORBIT_PAD) / reach;
    return { size: { w: ORBIT_W, h: ORBIT_H }, scale, center: { x: ORBIT_W / 2, y: ORBIT_H / 2 }, planet, sun: Math.min(32, Math.max(9, nearest * scale * 0.5)) };
  },
  scene(layout, view) {
    const { center, scale, planet: radius, sun } = layout;
    const body = bodyAt(view.trajectory, view.time);
    const where = (x: number, y: number): Point => ({ x: center.x + x * scale, y: center.y - y * scale });
    const guides = view.params.planets.map(orbitGuide);
    const fastest = Math.max(...guides.map((guide) => Math.max(...Array.from({ length: guide.times.length }, (_, index) => Math.hypot(guide.v[2 * index]!, guide.v[2 * index + 1]!)))));
    const strongest = Math.max(...view.params.planets.map((planet) => GM / Math.min(planet.distance, 2 * orbitSemiMajor(planet) - planet.distance) ** 2));
    const out: Drawable[] = [
      circle("sun-glow", center, sun * 1.45, "accent", "none", 0, 1, { opacity: 0.25 }),
      circle("sun", center, sun, "accent", "ink", 3, 2),
    ];
    view.params.planets.forEach((planet, index) => {
      const role = PLANET_ROLES[index]!;
      const guide = guides[index]!;
      const place = (state: Body) => where(state.q[2 * index]!, state.q[2 * index + 1]!);
      const state = { q: [body.q[2 * index]!, body.q[2 * index + 1]!], v: [body.v[2 * index]!, body.v[2 * index + 1]!] };
      const at = place(body);
      out.push(
        ...trace(`guide-${index}`, pathOf(guide, 0, endTime(guide), 240, (sample) => where(sample.q[0]!, sample.q[1]!)), "edge", 2.5, 1, 0.55),
        ...(view.trail && view.ran ? trace(`trail-${index}`, pathOf(view.trajectory, 0, view.time, Math.min(500, Math.max(2, Math.ceil(view.time * 120))), place), role, 6, 3, 0.9) : []),
        circle(`body-${index}`, at, radius, role, "ink", 3, 6, { part: `${view.objectId}[${planet.id}]` }),
        ...arrows(`${index}-`, view, at, {
          velocity: { x: (state.v[0]! * VELOCITY_PX) / fastest, y: (-state.v[1]! * VELOCITY_PX) / fastest },
          gravity: (() => {
            const distance = Math.hypot(state.q[0]!, state.q[1]!);
            const pull = (GM / distance ** 2 / strongest) * VELOCITY_PX;
            return { x: (-state.q[0]! / distance) * pull, y: (state.q[1]! / distance) * pull };
          })(),
        }, { velocity: "v", gravity: "g" }, { clear: radius + 8 }),
      );
    });
    view.marks.forEach((key) => {
      const [what, id] = key.split("@") as [string, string];
      const index = view.params.planets.findIndex((planet) => planet.id === id);
      const guide = guides[index]!;
      let best = 0;
      for (let sample = 1; sample < guide.times.length; sample++) {
        const distance = Math.hypot(guide.q[2 * sample]!, guide.q[2 * sample + 1]!);
        const bestDistance = Math.hypot(guide.q[2 * best]!, guide.q[2 * best + 1]!);
        if (what === "perihelion" ? distance < bestDistance : distance > bestDistance) best = sample;
      }
      const point = where(guide.q[2 * best]!, guide.q[2 * best + 1]!);
      const distance = Math.hypot(guide.q[2 * best]!, guide.q[2 * best + 1]!);
      out.push(
        circle(`mark-${key}-ring`, point, radius + 12, "none", "ink", 4, 5),
      );
      if (view.reading) {
        const text = `${what} ${fmt(distance, 2)} AU`;
        const half = textWidth(text, LABEL_TEXT, "read") / 2;
        const outward = { x: (point.x - center.x) / Math.hypot(point.x - center.x, point.y - center.y), y: (point.y - center.y) / Math.hypot(point.x - center.x, point.y - center.y) };
        const reach = radius + 30;
        const spot = { x: point.x + outward.x * (reach + half * Math.abs(outward.x)), y: point.y + outward.y * reach };
        out.push(textDrawable(`mark-${key}-label`, text, { x: Math.min(ORBIT_W - half - 8, Math.max(half + 8, spot.x)), y: spot.y }, { size: LABEL_TEXT, z: 5 }));
      }
    });
    return out;
  },
  header: (params, body, time) => [readout(`t ${fmt(time, 2)} yr`, "t 888.88 yr"), ...params.planets.map((planet, index) => readout(`${planet.id} ${fmt(Math.hypot(body.q[2 * index]!, body.q[2 * index + 1]!), 2)} AU`, `${planet.id} 88.88 AU`))],
  markKey(params, args) {
    const planet = planetOf(params, args.planet, 'op "mark"');
    const what = args.what;
    if (Math.abs(planet.speed - 1) < 1e-9) fail(`op "mark": ${planet.id} has a circular orbit, so it has no nearest or farthest point; set its speed below 1 first`);
    return `${String(what)}@${planet.id}`;
  },
};

const KINDS: Record<SetupName, AnyKind> = { launch, drop, ramp, pendulum, orbit };
const SETUP_NAMES = Object.keys(KINDS) as SetupName[];
const SHARED_OPS = ["resume", "set", "vectors", "trail", "mark"];

function kindOf(state: PhysicsState): AnyKind {
  return KINDS[state.setup];
}

function opsOf(kind: AnyKind): string[] {
  return [kind.startOp, ...SHARED_OPS];
}

function attemptRole(attempt: Attempt<unknown>): Role {
  return ATTEMPT_ROLES[attempt.id % ATTEMPT_ROLES.length]!;
}

function viewOf(state: PhysicsState, time: number | "end"): View<any> {
  const kind = kindOf(state);
  const attempt = state.attempt;
  const trajectory = attempt ? trajectoryOfAttempt(kind, attempt) : readyTrajectory(kind, state.params);
  return {
    objectId: state.objectId,
    reading: state.reading,
    params: attempt?.params ?? state.params,
    trajectory,
    time: time === "end" ? endTime(trajectory) : time,
    role: attempt ? attemptRole(attempt) : ATTEMPT_ROLES[state.started % ATTEMPT_ROLES.length]!,
    ran: attempt !== null,
    vectors: state.vectors,
    trail: state.trail,
    marks: state.marks,
    ghosts: state.ghosts.map((ghost) => ({ params: ghost.params, trajectory: trajectoryOfAttempt(kind, ghost), role: attemptRole(ghost) })),
  };
}

function allParams(state: PhysicsState): object[] {
  return [state.params, ...state.ghosts.map((ghost) => ghost.params), ...(state.attempt ? [state.attempt.params] : [])];
}

interface Composition {
  size: Size;
  headerHeight: number;
  plotLeft: number;
  starts: number[];
}

function compose(state: PhysicsState): { layout: { size: Size }; composition: Composition } {
  const kind = kindOf(state);
  const layout = kind.layout(allParams(state), state.reading, { vectors: state.vectors.length > 0, apex: state.marks.includes("apex"), lowest: state.marks.includes("lowest") });
  const slots = state.reading ? kind.header(state.params, kind.ready(state.params), 0).map((item) => textWidth(item.widest, HEADER_TEXT, "read")) : [];
  const headerWidth = slots.reduce((sum, slot) => sum + slot, 0) + Math.max(0, slots.length - 1) * READOUT_GAP;
  const width = Math.max(layout.size.w, headerWidth);
  const headerHeight = slots.length > 0 ? HEADER_HEIGHT : 0;
  const starts = slots.map((_, index) => (width - headerWidth) / 2 + slots.slice(0, index).reduce((sum, slot) => sum + slot + READOUT_GAP, 0));
  return { layout, composition: { size: { w: width, h: headerHeight + layout.size.h }, headerHeight, plotLeft: (width - layout.size.w) / 2, starts } };
}

function shifted(drawables: Drawable[], dx: number, dy: number): Drawable[] {
  return drawables.map((item) => ({
    ...item,
    x: item.x + dx,
    y: item.y + dy,
    ...(item.x2 === undefined ? {} : { x2: item.x2 + dx, y2: item.y2! + dy }),
    ...(item.points ? { points: item.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) } : {}),
  }));
}

function render(state: PhysicsState, time: number | "end"): Drawable[] {
  const kind = kindOf(state);
  const { layout, composition } = compose(state);
  const view = viewOf(state, time);
  const plot = shifted(kind.scene(layout, view), composition.plotLeft, composition.headerHeight);
  if (composition.headerHeight === 0) return plot;
  const items = kind.header(view.params, bodyAt(view.trajectory, view.time), view.time);
  return [...items.map((item, index) => textDrawable(`readout-${index}`, item.text, { x: composition.starts[index]!, y: composition.headerHeight / 2 - 4 }, { size: HEADER_TEXT, z: 8, anchor: "start" })), ...plot];
}

function lastLeg(state: PhysicsState): { span: number; start: number; end: number } {
  const trajectory = trajectoryOfAttempt(kindOf(state), state.attempt!);
  const start = legStart(trajectory, state.attempt!.legs.length - 1);
  return { span: endTime(trajectory) - start, start, end: endTime(trajectory) };
}

function run(state: PhysicsState, op: LabOp, resuming: boolean): PhysicsState {
  const kind = kindOf(state);
  const leg = kind.legSpec(state.params, op.args);
  const args = Object.keys(op.args);
  const allowed = resuming || op.name === kind.startOp ? runKeys(kind) : [];
  const stray = args.filter((key) => !allowed.includes(key));
  if (stray.length > 0) fail(`op "${op.name}" has no argument ${stray.map((key) => `"${key}"`).join(", ")}; ${kind.runArgs}`);
  let attempt: Attempt<unknown>;
  let ghosts = state.ghosts;
  if (resuming) {
    const current = state.attempt;
    if (!current) return fail(`op "resume" needs a run to continue; start one with "${kind.startOp}" first`);
    const last = current.legs[current.legs.length - 1]!;
    if (kind.events[last.event]!.terminal) fail(`op "resume": the run already ended (${last.event}); start a new one with "${kind.startOp}"`);
    attempt = { ...current, legs: [...current.legs, leg] };
  } else {
    ghosts = kind.ghosts && state.attempt ? [...state.ghosts, state.attempt].slice(-MAX_GHOSTS) : [];
    attempt = { id: state.started, params: state.params, legs: [leg] };
  }
  const { trajectory, failed } = runAttempt(kind, attempt.params, attempt.legs);
  if (failed !== null) fail(`op "${op.name}": ${kind.events[attempt.legs[failed]!.event]!.stuck}`);
  trajectories.set(attempt, trajectory);
  return { ...state, ghosts, attempt, started: resuming ? state.started : state.started + 1, marks: resuming ? state.marks : [] };
}

function runKeys(kind: AnyKind): string[] {
  return kind.runArgs.includes("{") ? [...kind.runArgs.matchAll(/"(\w+)":/g)].map((match) => match[1]!) : [];
}

function setOp(state: PhysicsState, op: LabOp): PhysicsState {
  const kind = kindOf(state);
  if (Object.keys(op.args).length === 0) fail(`op "set" needs at least one of ${Object.keys(kind.settable).join(", ")}`);
  const unknown = Object.keys(op.args).filter((key) => !(key in kind.settable) && !(state.setup === "orbit" && key === "planet"));
  if (unknown.length > 0) fail(`op "set" cannot change ${unknown.map((key) => `"${key}"`).join(", ")} on a ${state.setup}; it can change ${Object.entries(kind.settable).map(([key, unit]) => `${key} (${unit})`).join(", ")}`);
  const params = kind.change(state.params, op.args);
  return { ...state, params, ghosts: kind.ghosts && state.attempt ? [...state.ghosts, state.attempt].slice(-MAX_GHOSTS) : [], attempt: null, marks: [] };
}

function vectorsOp(state: PhysicsState, op: LabOp): PhysicsState {
  const kind = kindOf(state);
  onlyKeys(op.args, ["show"], 'op "vectors"');
  const names = Object.keys(kind.vectors);
  const wanted = op.args.show;
  const list = typeof wanted === "string" ? (wanted === "all" ? names : wanted === "none" ? [] : [wanted]) : wanted;
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string" || !names.includes(name))) {
    fail(`op "vectors" needs "show" as "all", "none" or a list of ${names.join(", ")} for a ${state.setup}, got ${JSON.stringify(wanted)}`);
  }
  return { ...state, vectors: names.filter((name) => list.includes(name)) };
}

function trailOp(state: PhysicsState, op: LabOp): PhysicsState {
  onlyKeys(op.args, ["on"], 'op "trail"');
  const on = op.args.on ?? true;
  if (typeof on !== "boolean") fail('op "trail" needs "on" as true or false');
  return { ...state, trail: on };
}

function markOp(state: PhysicsState, op: LabOp): PhysicsState {
  const kind = kindOf(state);
  const names = Object.keys(kind.marks);
  if (typeof op.args.what !== "string" || !names.includes(op.args.what)) fail(`op "mark" needs "what" as one of ${names.join(", ")} for a ${state.setup}, got ${JSON.stringify(op.args.what)}`);
  if (state.setup !== "orbit") onlyKeys(op.args, ["what"], 'op "mark"');
  if (!state.attempt) fail(`op "mark": nothing to mark yet; run "${kind.startOp}" first`);
  const key = kind.markKey ? kind.markKey(state.params, op.args) : op.args.what;
  return { ...state, marks: state.marks.includes(key) ? state.marks : [...state.marks, key] };
}

function requireStartOp(state: PhysicsState, op: LabOp): void {
  const kind = kindOf(state);
  if (op.name !== kind.startOp) fail(`a ${state.setup} setup has no op "${op.name}"; its ops are ${opsOf(kind).join(", ")}`);
}

function runFrame(before: PhysicsState, after: PhysicsState, progress: number): Drawable[] {
  const { start, end } = lastLeg(after);
  const frame = render(after, lerp(start, end, clamp01(progress)));
  const earlier = new Map(render(before, "end").map((item) => [item.id, item]));
  const retired = frame.flatMap((item) => (item.kind === "text" && earlier.get(item.id)?.text !== undefined && earlier.get(item.id)!.text !== item.text ? [{ ...item, id: `${item.id}~out`, opacity: 0 }] : []));
  return [...frame, ...retired];
}

function runOp(doc: string, resuming: boolean): OpDef<PhysicsState> {
  const guard = (state: PhysicsState, op: LabOp) => {
    if (!resuming) requireStartOp(state, op);
  };
  return {
    doc,
    trueTime: true,
    seconds(op, state) {
      guard(state, op);
      const after = run(state, op, resuming);
      return kindOf(after).seconds(after.attempt!.params, lastLeg(after).span);
    },
    apply(state, op) {
      guard(state, op);
      return run(state, op, resuming);
    },
    during: (before, after, _op, progress) => runFrame(before, after, progress),
  };
}

const ops: Record<string, OpDef<PhysicsState>> = {
  launch: runOp('{"until": "lands"|"apex"}; for a launch setup: fire the ball from the start and run until it lands (default) or reaches its highest point; a new launch keeps the earlier flights on screen as fainter trails with their landing spots', false),
  release: runOp("no arguments; for a drop or a ramp setup: let go; the objects fall until they land, or the block slides to the bottom, or stays put when friction holds it", false),
  swing: runOp('{"swings": 2}; for a pendulum setup: let go and run this many swings, out and back to the start side (halves like 0.5 allowed, 0.5 to 20, default 1)', false),
  orbit: runOp('{"orbits": 1}; for an orbit setup: run until the first planet has gone round this many times (0.25 to 20, default 1); the other planets move for the same time, and the playback is sped up so one orbit takes about 4.5 s', false),
  resume: runOp("same arguments as the run op of the setup (launch, swing or orbit); continues the current run from where it stopped, for example from the highest point on to the landing; not allowed once a run has ended", true),
  set: {
    doc: 'launch: angle, speed, height, gravity; drop: height, masses, gravity; ramp: angle, friction, length, gravity; pendulum: length, angle, damping, gravity; orbit: speed or distance, for every planet or one planet with "planet": "Mars"; puts the setup back to its start with the new values, ready for the next run',
    seconds: 0.8,
    apply: setOp,
  },
  vectors: {
    doc: '{"show": ["velocity", "gravity"]} or {"show": "all"} or {"show": "none"}; shows exactly these arrows and hides the rest; velocity and gravity everywhere, normal, friction and net on a ramp, tension and net on a pendulum; arrows follow the body with one length scale for the whole object',
    seconds: 0.6,
    apply: vectorsOp,
  },
  trail: {
    doc: '{"on": true}; shows or hides the path the body has taken (a dotted record at equal time steps on a drop); on by default',
    seconds: 0.5,
    apply: trailOp,
  },
  mark: {
    doc: '{"what": "apex"|"range"|"height"|"angle"|"lowest"|"highest"|"perihelion"|"aphelion"}; draws a marker on the current run: launch: apex, range; drop: height; ramp: angle; pendulum: lowest, highest, angle; orbit: perihelion or aphelion of one planet ("planet": id)',
    seconds: 0.9,
    apply: markOp,
    during(before, after, _op, progress) {
      const added = after.marks.filter((key) => !before.marks.includes(key));
      return render(after, "end").filter((item) => added.some((key) => item.id.startsWith(`mark-${key}`))).map((item) => ({ ...item, opacity: (item.opacity ?? 1) * clamp01(progress) }));
    },
  },
};

function specDocs(): Record<string, string> {
  return {
    setup: `one of ${SETUP_NAMES.join(", ")}`,
    reading: "optional, default true; false draws no numbers, words or units at all, for a small child: only a big body, bold paths and arrows",
    ...Object.fromEntries(SETUP_NAMES.map((name) => [`setup "${name}"`, Object.entries(KINDS[name].spec).map(([field, doc]) => `${field}: ${doc}`).join("; ")])),
  };
}

export function trajectoryOf(state: PhysicsState): Trajectory {
  return viewOf(state, "end").trajectory;
}

export const lab: LabDef<Args, PhysicsState> = {
  id: "physics",
  title: "Physics",
  reading: "optional",
  catalog: {
    summary: "Motion computed, not drawn: a fixed step integrator runs real Newtonian physics and every path on screen comes from it. Setups: launch (a ball fired at an angle and speed over a ground line), drop (objects of different mass falling from a height together), ramp (a block on a slope with friction that slides or stays), pendulum (a bob on a rod, optionally with drag), orbit (planets circling a fixed sun). A tap on a dropped ball names it by its place in \"masses\" (drop[0] is the first), and a tap on a planet names it by its id (sky[Mars]). You give intent (angle, speed, length, friction); the Lab owns the layout and every number. Set \"reading\": false for a small child: nothing on screen needs reading.",
    spec: specDocs(),
    example: [
      '{"step":1,"say":"A ball leaves the ground at forty five degrees. Watch where it lands, then see its top.","scene":{"shot":{"lab":"physics","setup":"launch","angle":45,"speed":20}},"do":[{"cue":"Watch","op":"launch","on":["shot"]},{"cue":"top","op":"mark","on":["shot"],"what":"apex"}]}',
      '{"step":2,"say":"Aim lower, at thirty degrees, and it lands nearer. Show the pull of gravity and the velocity.","do":[{"cue":"lower","op":"set","on":["shot"],"angle":30},{"cue":"lands","op":"launch","on":["shot"]},{"cue":"velocity","op":"vectors","on":["shot"],"show":["velocity","gravity"]}]}',
      '{"step":3,"say":"Clear the stage for a pendulum, and let it swing twice.","scene":{"bob":{"lab":"physics","setup":"pendulum","length":1,"angle":30}},"do":[{"cue":"Clear","op":"remove","on":["shot"]},{"cue":"swing","op":"swing","on":["bob"],"swings":2}]}',
    ],
  },

  init(spec, objectId) {
    const setup = spec.setup;
    if (typeof setup !== "string" || !SETUP_NAMES.includes(setup as SetupName)) fail(`${objectId}: "setup" must be one of ${SETUP_NAMES.join(", ")}, got ${JSON.stringify(setup)}`);
    const kind = KINDS[setup as SetupName];
    onlyKeys(spec, [...Object.keys(kind.spec), "setup", "reading"], `${objectId}: setup "${setup}"`, ["lab"]);
    if (spec.reading != null && typeof spec.reading !== "boolean") fail(`${objectId}: "reading" must be true or false`);
    return { objectId, reading: readsWords(spec), setup: setup as SetupName, params: kind.init(spec, objectId), ghosts: [], attempt: null, started: 0, vectors: [], trail: true, marks: [] };
  },

  ops,

  size: (state) => compose(state).composition.size,

  draw: (state) => render(state, "end"),
};
