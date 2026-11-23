import { clamp01, type Drawable, fail, type LabDef, type LabOp, lerp, lerpRect, type Paint, type Point, type Rect, type Running, type Size } from "../../lab";
import { textWidth } from "../../text-metrics";
import { landRings } from "../land";

type Allegiance = "lead" | "foe";

interface Place {
  name: string;
  lon: number;
  lat: number;
}

interface Stop {
  place: number;
  back: number;
  clashesOnArrival: number;
}

interface Army {
  id: string;
  label: string;
  allegiance: Allegiance;
  stops: Stop[];
}

interface MapState {
  objectId: string;
  west: number;
  east: number;
  south: number;
  north: number;
  places: Place[];
  reached: number;
  armies: Army[];
  clashes: number[];
}

interface Sizes {
  k: number;
  dot: number;
  route: number;
  name: number;
  gap: number;
  w: number;
  h: number;
  trail: number;
  label: number;
  sabre: number;
}

const WIDTH = 3200;
const FRAME_ASPECT = 16 / 9;
const TRAVEL_SECONDS = 1.6;
const CLASH_SECONDS = 1.6;
const OLD_OPACITY = 0.5;
const HALO = 12;
const ARMY_PAINT: Record<Allegiance, Paint> = { lead: "accent", foe: "muted" };
const LAND_CACHE = new Map<string, Drawable[]>();

function scaleOf(state: MapState): { kx: number; ky: number; height: number } {
  const middle = ((state.north + state.south) / 2) * (Math.PI / 180);
  const spanX = (state.east - state.west) * Math.cos(middle);
  const spanY = state.north - state.south;
  const ky = WIDTH / spanX;
  return { kx: ky * Math.cos(middle), ky, height: spanY * ky };
}

function sizesOf(state: MapState): Sizes {
  const k = Math.max(1, (scaleOf(state).height * FRAME_ASPECT) / WIDTH);
  return { k, dot: 15 * k, route: 9 * k, name: 60 * k, gap: 36 * k, w: 96 * k, h: 62 * k, trail: 30 * k, label: 56 * k, sabre: 30 * k };
}

function project(state: MapState, lon: number, lat: number): Point {
  const { kx, ky } = scaleOf(state);
  return { x: (lon - state.west) * kx, y: (state.north - lat) * ky };
}

const placeAt = (state: MapState, index: number) => project(state, state.places[index]!.lon, state.places[index]!.lat);
const along = (from: Point, to: Point, t: number): Point => ({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) });
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function unit(from: Point, to: Point, fallback: Point): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return length < 1e-6 ? fallback : { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

function clipRing(ring: number[][], edges: { inside: (p: number[]) => boolean; cross: (a: number[], b: number[]) => number[] }[]): number[][] {
  return edges.reduce((points, edge) => {
    const out: number[][] = [];
    points.forEach((current, index) => {
      const previous = points[(index + points.length - 1) % points.length]!;
      if (edge.inside(current)) {
        if (!edge.inside(previous)) out.push(edge.cross(previous, current));
        out.push(current);
      } else if (edge.inside(previous)) {
        out.push(edge.cross(previous, current));
      }
    });
    return out;
  }, ring);
}

function landDrawables(state: MapState, s: Sizes): Drawable[] {
  const key = `${state.west},${state.east},${state.south},${state.north}`;
  const cached = LAND_CACHE.get(key);
  if (cached) return cached;
  const margin = 0.01;
  const at = (limit: number, axis: 0 | 1) => (a: number[], b: number[]) => {
    const t = (limit - a[axis]!) / (b[axis]! - a[axis]!);
    return axis === 0 ? [limit, lerp(a[1]!, b[1]!, t)] : [lerp(a[0]!, b[0]!, t), limit];
  };
  const edges = [
    { inside: (p: number[]) => p[0]! >= state.west - margin, cross: at(state.west - margin, 0) },
    { inside: (p: number[]) => p[0]! <= state.east + margin, cross: at(state.east + margin, 0) },
    { inside: (p: number[]) => p[1]! >= state.south - margin, cross: at(state.south - margin, 1) },
    { inside: (p: number[]) => p[1]! <= state.north + margin, cross: at(state.north + margin, 1) },
  ];
  const drawables: Drawable[] = [];
  landRings().forEach((ring, index) => {
    const longitudes = ring.map((p) => p[0]!);
    const latitudes = ring.map((p) => p[1]!);
    if (Math.max(...longitudes) < state.west || Math.min(...longitudes) > state.east || Math.max(...latitudes) < state.south || Math.min(...latitudes) > state.north) return;
    const clipped = clipRing(ring, edges);
    if (clipped.length < 3) return;
    const points = clipped.flatMap((p) => {
      const { x, y } = project(state, p[0]!, p[1]!);
      return [x, y];
    });
    drawables.push({ id: `land-${index}`, kind: "path", x: 0, y: 0, points, closed: true, fill: "fill2", stroke: "edge", strokeWidth: 3 * s.k, z: 1 });
  });
  LAND_CACHE.set(key, drawables);
  return drawables;
}

function besideRect(at: Point, toward: Point, size: Size, near: Size, gap: Point): Rect {
  const x = toward.x === 0 ? at.x - size.w / 2
    : toward.y === 0 ? (toward.x > 0 ? at.x + near.w + gap.x : at.x - near.w - gap.x - size.w)
    : toward.x > 0 ? at.x + near.w / 2 : at.x - near.w / 2 - size.w;
  const y = toward.y === 0 ? at.y - size.h / 2 : toward.y > 0 ? at.y + near.h + gap.y : at.y - near.h - gap.y - size.h;
  return { x, y, w: size.w, h: size.h };
}

function markerHalf(state: MapState, s: Sizes, index: number): Size {
  const held = state.armies.some((army) => army.stops[army.stops.length - 1]!.place === index && army.stops[army.stops.length - 1]!.back === 0);
  return held ? { w: s.w / 2, h: s.h / 2 } : { w: s.dot, h: s.dot };
}

const iconWidth = (s: Sizes) => s.sabre * 2 + s.name * 0.2;

function stopPoint(state: MapState, s: Sizes, army: Army, leg: number): Point {
  const stop = army.stops[leg]!;
  const at = placeAt(state, stop.place);
  if (stop.back === 0) return at;
  const from = leg > 0 ? placeAt(state, army.stops[leg - 1]!.place) : { x: at.x - 1, y: at.y };
  const toward = unit(at, from, { x: -1, y: 0 });
  const back = stop.back * s.w * 1.3;
  return { x: at.x + toward.x * back, y: at.y + toward.y * back };
}

const hereOf = (army: Army) => army.stops[army.stops.length - 1]!.place;

function shuttlesBack(state: MapState, army: Army, to: number): boolean {
  const arrived = army.stops[army.stops.length - 1]!;
  const left = army.stops[army.stops.length - 2];
  return left?.place === to && !state.clashes.slice(arrived.clashesOnArrival).includes(arrived.place);
}

function placeIndex(state: MapState, value: unknown, what: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < state.places.length) return value;
  const index = typeof value === "string" ? state.places.findIndex((place) => place.name === value) : -1;
  if (index < 0) fail(`${what} must name one of the places: ${state.places.map((place) => place.name).join(", ")}`);
  return index;
}

function armyOf(state: MapState, op: LabOp): Army {
  const army = state.armies.find((entry) => entry.id === op.parts[0]);
  if (!army) fail(`op "${op.name}" needs an army in "on", such as ${state.objectId}[${state.armies[0]?.id ?? "french"}]; this map has ${state.armies.map((entry) => entry.id).join(", ") || "no armies"}`);
  return army;
}

interface Footprint {
  owner: string;
  what: string;
  rect: Rect;
}

interface Track {
  from: Point;
  to: Point;
  width: number;
}

interface Layout {
  names: Rect[];
  labels: Map<string, Rect>;
  problem: string | null;
}

const NAME_SPOTS: Point[] = [{ x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: -1 }, { x: -1, y: 1 }];
const LABEL_SPOTS: Point[] = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 1, y: -1 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
const LAYOUTS = new WeakMap<MapState, Layout>();

function grown(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

function within(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function crosses(from: Point, to: Point, rect: Rect): boolean {
  let enter = 0;
  let leave = 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (const [p, q] of [[-dx, from.x - rect.x], [dx, rect.x + rect.w - from.x], [-dy, from.y - rect.y], [dy, rect.y + rect.h - from.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return false;
  }
  return true;
}

function pointToRect(p: Point, rect: Rect): number {
  return Math.hypot(Math.max(rect.x - p.x, 0, p.x - rect.x - rect.w), Math.max(rect.y - p.y, 0, p.y - rect.y - rect.h));
}

function pointToSegment(p: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const t = dx || dy ? clamp01(((p.x - from.x) * dx + (p.y - from.y) * dy) / (dx * dx + dy * dy)) : 0;
  return Math.hypot(p.x - from.x - t * dx, p.y - from.y - t * dy);
}

function trackToRect(track: Track, rect: Rect): number {
  if (crosses(track.from, track.to, rect)) return 0;
  const corners = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y }, { x: rect.x, y: rect.y + rect.h }, { x: rect.x + rect.w, y: rect.y + rect.h }];
  return Math.min(pointToRect(track.from, rect), pointToRect(track.to, rect), ...corners.map((corner) => pointToSegment(corner, track.from, track.to)));
}

function layoutOf(state: MapState, s: Sizes): Layout {
  const cached = LAYOUTS.get(state);
  if (cached) return cached;
  const pad = 6 * s.k;
  const frame = { x: 0, y: 0, w: WIDTH, h: scaleOf(state).height };
  const solids: Footprint[] = [];
  const tracks: Track[] = [];
  const nameAt = (index: number) => state.places[index]!.name;
  state.places.forEach((place, index) => {
    const at = placeAt(state, index);
    const half = markerHalf(state, s, index);
    solids.push({ owner: `place ${index}`, what: `the ${place.name} marker`, rect: { x: at.x - half.w, y: at.y - half.h, w: half.w * 2, h: half.h * 2 } });
  });
  for (let index = 1; index < state.reached; index += 1) tracks.push({ from: placeAt(state, index - 1), to: placeAt(state, index), width: s.route });
  for (const army of state.armies) {
    const stops = army.stops.map((_, leg) => stopPoint(state, s, army, leg));
    stops.slice(1).forEach((to, leg) => tracks.push({ from: stops[leg]!, to, width: s.trail }));
    const at = stops[stops.length - 1]!;
    if (army.stops[army.stops.length - 1]!.back > 0) solids.push({ owner: `army ${army.id}`, what: `the ${army.label} marker`, rect: { x: at.x - s.w / 2, y: at.y - s.h / 2, w: s.w, h: s.h } });
  }
  let problem: string | null = null;
  solids.forEach((a, i) => solids.slice(i + 1).forEach((b) => {
    if (!problem && a.owner !== b.owner && overlaps(grown(a.rect, pad), b.rect)) problem = `${a.what} overlaps ${b.what}`;
  }));
  const settle = (owner: string, what: string, at: Point, spots: Point[], size: Size, near: Size, gap: Point): Rect => {
    const scored = spots.map((toward) => {
      const rect = besideRect(at, toward, size, near, gap);
      const blocked = solids.filter((solid) => solid.owner !== owner && overlaps(grown(solid.rect, pad), rect)).map((solid) => solid.what);
      if (!within(frame, rect)) blocked.push("the edge of the map");
      const crossed = tracks.filter((track) => trackToRect(track, rect) < track.width / 2 + pad * 2).length;
      return { rect, blocked, score: blocked.length * 100 + crossed };
    });
    const best = scored.reduce((a, b) => (b.score < a.score ? b : a));
    if (!problem && best.blocked.length) problem = `there is no room for ${what}: every spot beside it would cover ${best.blocked[0]}`;
    solids.push({ owner, what, rect: best.rect });
    return best.rect;
  };
  const names = state.places.map((place, index) => {
    const size = { w: (state.clashes.includes(index) ? iconWidth(s) : 0) + textWidth(place.name, s.name, "read"), h: s.name };
    return settle(`place ${index}`, `the name ${nameAt(index)}`, placeAt(state, index), NAME_SPOTS, size, markerHalf(state, s, index), { x: s.gap * 0.5, y: s.gap * 0.5 });
  });
  const labels = new Map(state.armies.map((army) => {
    const size = { w: textWidth(army.label, s.label, "read"), h: s.label };
    const rest = stopPoint(state, s, army, army.stops.length - 1);
    return [army.id, settle(`army ${army.id}`, `the label ${army.label}`, rest, LABEL_SPOTS, size, { w: s.w / 2, h: s.h / 2 }, labelGap(s))] as const;
  }));
  const layout = { names, labels, problem };
  LAYOUTS.set(state, layout);
  return layout;
}

const labelGap = (s: Sizes): Point => ({ x: s.gap * 0.5, y: s.gap * 0.4 });

function clearOfMarker(offset: Point, fallback: Point, s: Sizes, army: Army): Point {
  const gap = labelGap(s);
  const room = { x: s.w / 2 + gap.x + textWidth(army.label, s.label, "read") / 2, y: s.h / 2 + gap.y + s.label / 2 };
  if (Math.abs(offset.x) >= room.x || Math.abs(offset.y) >= room.y) return offset;
  const stretch = Math.min(offset.x ? room.x / Math.abs(offset.x) : Infinity, offset.y ? room.y / Math.abs(offset.y) : Infinity);
  return Number.isFinite(stretch) ? { x: offset.x * stretch, y: offset.y * stretch } : fallback;
}

function labelOffset(state: MapState, s: Sizes, id: string): Point | null {
  const army = state.armies.find((entry) => entry.id === id);
  const rect = layoutOf(state, s).labels.get(id);
  if (!army || !rect) return null;
  const rest = stopPoint(state, s, army, army.stops.length - 1);
  return { x: rect.x + rect.w / 2 - rest.x, y: rect.y + rect.h / 2 - rest.y };
}

function roomy(state: MapState): MapState {
  const { problem } = layoutOf(state, sizesOf(state));
  if (problem) fail(`${state.objectId}: ${problem}. Leave out a place the story does not need, or change "region" so the places spread out with room around them`);
  return state;
}

function marchSeconds(state: MapState, op: LabOp): number {
  const s = sizesOf(state);
  const army = armyOf(state, op);
  const from = stopPoint(state, s, army, army.stops.length - 1);
  const to = placeAt(state, placeIndex(state, op.args.to, `op "march" "to"`));
  return Math.min(4, Math.max(1.8, 1.4 + Math.hypot(to.x - from.x, to.y - from.y) / (900 * s.k)));
}

function band(from: Point, to: Point, tail: number, head: number): number[] {
  const n = unit(from, to, { x: 1, y: 0 });
  return [
    from.x - n.y * tail, from.y + n.x * tail, to.x - n.y * head, to.y + n.x * head,
    to.x + n.y * head, to.y - n.x * head, from.x + n.y * tail, from.y - n.x * tail,
  ];
}

function trailDrawables(id: string, s: Sizes, from: Point, to: Point, paint: Paint, opacity: number, clock: number | null): Drawable[] {
  const half = s.trail / 2;
  const out: Drawable[] = [{ id, kind: "path", x: 0, y: 0, points: band(from, to, half * 0.35, half), closed: true, fill: paint, stroke: "ground", strokeWidth: 4 * s.k, opacity, z: 3 }];
  if (clock === null) return out;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const u = unit(from, to, { x: 1, y: 0 });
  const gap = 70 * s.k;
  for (let d = (clock * 140 * s.k) % gap, i = 0; d < length - s.w * 0.6; d += gap, i++) {
    const w = half * (0.35 + 0.65 * (d / length)) * 0.7;
    const tip = { x: from.x + u.x * (d + w * 0.6), y: from.y + u.y * (d + w * 0.6) };
    const back = { x: from.x + u.x * (d - w * 0.4), y: from.y + u.y * (d - w * 0.4) };
    out.push({ id: `${id}.step${i}`, kind: "path", x: 0, y: 0, points: [back.x - u.y * w, back.y + u.x * w, tip.x, tip.y, back.x + u.y * w, back.y - u.x * w], stroke: "ground", strokeWidth: 5 * s.k, fill: "none", opacity, z: 3 });
  }
  return out;
}

function tokenDrawables(s: Sizes, army: Army, at: Point, label: Point): Drawable[] {
  const paint = ARMY_PAINT[army.allegiance];
  const id = `army-${army.id}`;
  const inset = 6 * s.k;
  const [left, top, right, bottom] = [at.x - s.w / 2 + inset, at.y - s.h / 2 + inset, at.x + s.w / 2 - inset, at.y + s.h / 2 - inset];
  return [
    { id: `${id}.box`, kind: "rect", x: at.x, y: at.y, w: s.w, h: s.h, fill: paint, stroke: "ground", strokeWidth: 6 * s.k, radius: 4 * s.k, z: 7 },
    { id: `${id}.x1`, kind: "line", x: left, y: top, x2: right, y2: bottom, stroke: "ground", strokeWidth: 5 * s.k, z: 7 },
    { id: `${id}.x2`, kind: "line", x: left, y: bottom, x2: right, y2: top, stroke: "ground", strokeWidth: 5 * s.k, z: 7 },
    { id: `${id}.label`, kind: "text", x: at.x + label.x, y: at.y + label.y, text: army.label, size: s.label, font: "read", fill: paint, stroke: "ground", strokeWidth: HALO * s.k, z: 8 },
  ];
}

function sabres(id: string, s: Sizes, at: Point, opacity: number): Drawable[] {
  const r = s.sabre;
  const blade = (sign: number, paint: Paint, width: number, suffix: string): Drawable => ({
    id: `${id}.${suffix}`, kind: "line", x: at.x - r * sign, y: at.y - r, x2: at.x + r * sign, y2: at.y + r, stroke: paint, strokeWidth: width, opacity, z: 6,
  });
  const guard = (sign: number, suffix: string): Drawable => {
    const hilt = { x: at.x + r * sign * 0.55, y: at.y + r * 0.55 };
    const g = r * 0.32;
    return { id: `${id}.${suffix}`, kind: "line", x: hilt.x - g, y: hilt.y + g * sign, x2: hilt.x + g, y2: hilt.y - g * sign, stroke: "highlight", strokeWidth: r * 0.2, opacity, z: 6 };
  };
  return [blade(1, "ground", r * 0.42, "h1"), blade(-1, "ground", r * 0.42, "h2"), blade(1, "highlight", r * 0.18, "b1"), blade(-1, "highlight", r * 0.18, "b2"), guard(1, "g1"), guard(-1, "g2")];
}

function burst(id: string, s: Sizes, at: Point, progress: number): Drawable[] {
  const out: Drawable[] = [];
  const pop = progress * 2.6;
  if (pop < 1) {
    const r = (40 + 120 * Math.sin(Math.PI * pop)) * s.k;
    const points = Array.from({ length: 18 }, (_, i) => {
      const a = (i / 18) * Math.PI * 2 + 0.17;
      const reach = i % 2 === 0 ? r : r * 0.42;
      return [at.x + reach * Math.cos(a), at.y + reach * Math.sin(a)];
    }).flat();
    out.push({ id: `${id}.burst`, kind: "path", x: 0, y: 0, points, closed: true, fill: "highlight", stroke: "none", z: 6 });
  }
  [0, 0.18].forEach((delay, i) => {
    const t = clamp01((progress - delay) / 0.7);
    if (t > 0 && t < 1) out.push({ id: `${id}.ring${i}`, kind: "circle", x: at.x, y: at.y, r: (60 + 220 * (1 - (1 - t) ** 3)) * s.k, fill: "none", stroke: "accent", strokeWidth: (8 * (1 - t) + 1) * s.k, opacity: 1 - t, z: 6 });
  });
  return out;
}

const runningOf = (list: Running<MapState>[], name: string) => list.filter((entry) => entry.op.name === name);

function drawMap(state: MapState, now: Running<MapState>[], clock: number): Drawable[] {
  const s = sizesOf(state);
  const out = [...landDrawables(state, s)];
  const shown = new Map<number, number>();
  const show = (index: number, opacity: number) => shown.set(index, Math.max(shown.get(index) ?? 0, opacity));
  const arrival = (u: number) => clamp01((u - 0.75) * 4);

  const going = runningOf(now, "go")[0];
  for (let index = 0; index < state.reached; index += 1) {
    const latest = index === state.reached - 1;
    const u = latest && going ? going.progress : 1;
    show(index, index === 0 ? 1 : arrival(u));
    if (index === 0) continue;
    const from = placeAt(state, index - 1);
    const to = placeAt(state, index);
    out.push({ id: `leg-${index}`, kind: "path", x: 0, y: 0, points: [from.x, from.y, to.x, to.y], stroke: "accent", strokeWidth: s.route, draw: clamp01(u * 1.25), opacity: latest ? 1 : OLD_OPACITY, z: 2 });
  }
  if (state.reached) out.push({ id: "route-head", kind: "circle", ...placeAt(state, state.reached - 1), r: s.dot * 1.4, fill: "accent", stroke: "ground", strokeWidth: 4 * s.k, opacity: going ? arrival(going.progress) : 1, z: 5 });

  const fighting = new Map(runningOf(now, "clash").map((entry) => [entry.after.clashes[entry.after.clashes.length - 1]!, entry.progress]));
  const marching = new Map(runningOf(now, "march").map((entry) => [entry.op.parts[0], entry.progress]));
  const tokens = state.armies.map((army) => {
    const u = marching.get(army.id);
    const stops = army.stops.map((_, leg) => stopPoint(state, s, army, leg));
    const last = stops.length - 1;
    army.stops.forEach((stop, leg) => {
      const latest = leg === last;
      show(stop.place, latest && u !== undefined ? arrival(u) : 1);
      if (leg === 0) return;
      const head = latest && u !== undefined ? along(stops[leg - 1]!, stops[leg]!, ease(u)) : stops[leg]!;
      out.push(...trailDrawables(`army-${army.id}.leg${leg}`, s, stops[leg - 1]!, head, ARMY_PAINT[army.allegiance], latest ? 0.9 : OLD_OPACITY * 0.8, latest && u !== undefined && u < 1 ? clock : null));
    });
    const at = u !== undefined && last > 0 ? along(stops[last - 1]!, stops[last]!, ease(u)) : stops[last]!;
    return { army, at, rest: stops[last]! };
  });

  for (const [place, u] of fighting) {
    const here = tokens.filter((token) => hereOf(token.army) === place);
    const center = here.length ? { x: here.reduce((sum, token) => sum + token.at.x, 0) / here.length, y: here.reduce((sum, token) => sum + token.at.y, 0) / here.length } : placeAt(state, place);
    for (const token of here) {
      const toward = unit(token.at, center, { x: 1, y: 0 });
      const lunge = 18 * s.k * Math.sin(Math.PI * u * 6) * (1 - u);
      token.at = { x: token.at.x + toward.x * lunge, y: token.at.y + toward.y * lunge };
    }
    out.push(...burst(`clash-${place}`, s, center, u));
  }
  const settling = now[0];
  const glide = ease(settling?.progress ?? 1);
  for (const token of tokens) {
    const after = labelOffset(state, s, token.army.id)!;
    const before = settling ? labelOffset(settling.before, s, token.army.id) ?? after : after;
    out.push(...tokenDrawables(s, token.army, token.at, clearOfMarker(along(before, after, glide), after, s, token.army)));
  }

  for (const place of state.clashes) show(place, 1);
  const namesNow = layoutOf(state, s).names;
  const namesBefore = settling ? layoutOf(settling.before, s).names : namesNow;
  for (const [index, opacity] of shown) {
    const at = placeAt(state, index);
    const name = state.places[index]!.name;
    const u = fighting.get(index);
    const marked = state.clashes.includes(index) ? (u === undefined ? 1 : ease(clamp01((u - 0.3) / 0.4))) : 0;
    const rect = lerpRect(namesBefore[index]!, namesNow[index]!, glide);
    const y = rect.y + rect.h / 2;
    out.push({ id: `dot-${index}`, kind: "circle", x: at.x, y: at.y, r: s.dot, fill: "ink", stroke: "ground", strokeWidth: 4 * s.k, opacity, z: 4 });
    out.push({ id: `name-${index}`, kind: "text", x: rect.x + rect.w - textWidth(name, s.name, "read") / 2, y, text: name, size: s.name, font: "read", fill: "ink", stroke: "ground", strokeWidth: HALO * s.k, opacity, z: 6 });
    if (marked > 0) out.push(...sabres(`sabres-${index}`, s, { x: rect.x + s.sabre, y }, marked * opacity));
  }
  return out;
}

function parsePlaces(raw: unknown, objectId: string): Place[] {
  if (!Array.isArray(raw) || raw.length < 2) fail(`${objectId}: "places" must list at least two places`);
  return raw.map((entry, position) => {
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.lon !== "number" || typeof item.lat !== "number") fail(`${objectId}: places[${position}] needs "name", "lon" and "lat"`);
    return { name: item.name, lon: item.lon, lat: item.lat };
  });
}

function parseArmies(raw: unknown, state: MapState): Army[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${state.objectId}: "armies" must map ids to {"label", "at", "side"}`);
  const armies: Army[] = [];
  for (const [id, value] of Object.entries(raw)) {
    const spec = value as Record<string, unknown>;
    if (typeof spec.label !== "string") fail(`${state.objectId}: armies.${id} needs a "label"`);
    const allegiance = spec.side ?? "lead";
    if (allegiance !== "lead" && allegiance !== "foe") fail(`${state.objectId}: armies.${id} "side" must be lead or foe`);
    const place = placeIndex(state, spec.at, `${state.objectId}: armies.${id} "at"`);
    armies.push({ id, label: spec.label, allegiance, stops: [{ place, back: armies.filter((army) => hereOf(army) === place).length, clashesOnArrival: 0 }] });
  }
  return armies;
}

export const primitive: LabDef<Record<string, unknown>, MapState> = {
  id: "map",
  title: "Campaign map",
  reading: "required",
  catalog: {
    summary: "A map with real coastlines where a journey is drawn stop by stop, armies march between places as unit markers trailing a widening band, and battles burst between the armies and leave crossed sabres by the place's name. An army that reaches a place another army holds stops short of it, facing it. Use it for where things happened and how forces moved. Aim the camera at part of it with a camera move's focus.",
    spec: {
      region: "[west, south, east, north] in degrees; keep it tight around the places so their names have room",
      places: 'every place the scene names, in journey order: [{"name": "Toulon", "lon": 5.93, "lat": 43.12}]; each name sets itself beside its place, clear of other names, markers and paths. A place shows once something reaches it',
      armies: 'optional forces: {"french": {"label": "Army of Italy", "at": "Nice", "side": "lead"}}; side is lead for the story\'s own side or foe for the other',
    },
    example: [
      '{"scene":{"italy":{"kind":"map","region":[6.6,43.4,11.3,46],"places":[{"name":"Nice","lon":7.27,"lat":43.7},{"name":"Lodi","lon":9.5,"lat":45.31},{"name":"Milan","lon":9.19,"lat":45.46}],"armies":{"french":{"label":"Army of Italy","at":"Nice","side":"lead"},"austria":{"label":"Austrians","at":"Milan","side":"foe"}}}},"do":[{"cue":"marched","op":"march","on":["italy[french]"],"to":"Lodi"},{"cue":"bridge","op":"clash","on":["italy"],"at":"Lodi"},{"cue":"fell back","op":"march","on":["italy[austria]"],"to":"Lodi"}]}',
    ],
  },
  init(spec, objectId) {
    const region = spec.region;
    if (!Array.isArray(region) || region.length !== 4 || region.some((value) => typeof value !== "number")) fail(`${objectId}: "region" must be [west, south, east, north] in degrees`);
    const [west, south, east, north] = region as number[];
    if (east! <= west! || north! <= south!) fail(`${objectId}: "region" must have east after west and north after south`);
    const state: MapState = { objectId, west: west!, south: south!, east: east!, north: north!, places: parsePlaces(spec.places, objectId), reached: 0, armies: [], clashes: [] };
    return roomy({ ...state, armies: parseArmies(spec.armies, state) });
  },
  ops: {
    go: {
      doc: 'draws the journey on to a place: {"to": "Milan"} (a place name, or its index from 0); the first go to place 0 just marks the start',
      seconds: TRAVEL_SECONDS,
      apply(state, op) {
        const to = placeIndex(state, op.args.to, `op "go" "to"`);
        if (to < state.reached) fail(`op "go": the journey on ${state.objectId} has already reached ${state.places[to]!.name}; go on to a later place, march an army or clash`);
        return { ...state, reached: to + 1 };
      },
    },
    march: {
      doc: 'moves an army in "on", such as "italy[french]", to place "to" along a widening band; its old legs stay faint',
      seconds: (op, state) => marchSeconds(state, op),
      apply(state, op) {
        const army = armyOf(state, op);
        const to = placeIndex(state, op.args.to, `op "march" "to"`);
        if (to === hereOf(army)) fail(`op "march": ${state.objectId}[${army.id}] is already at ${state.places[to]!.name}`);
        if (shuttlesBack(state, army, to)) fail(`op "march": ${state.objectId}[${army.id}] would march straight back to ${state.places[to]!.name}, where it came from, with no battle at ${state.places[hereOf(army)]!.name} between, so it shuttles and shows nothing that happened; march it on to where the story sends it, clash where it stands, or act the line on a stage`);
        const back = state.armies.filter((other) => other.id !== army.id && hereOf(other) === to).length;
        return roomy({ ...state, armies: state.armies.map((entry) => (entry.id === army.id ? { ...entry, stops: [...entry.stops, { place: to, back, clashesOnArrival: state.clashes.length }] } : entry)) });
      },
    },
    clash: {
      doc: 'a battle bursts at place "at", between any armies there, and leaves crossed sabres by its name',
      seconds: CLASH_SECONDS,
      apply: (state, op) => roomy({ ...state, clashes: [...state.clashes, placeIndex(state, op.args.at, `op "clash" "at"`)] }),
    },
  },
  size: (state) => ({ w: WIDTH, h: scaleOf(state).height }),
  draw: (state) => drawMap(state, [], 0),
  live: (state, now, ctx) => drawMap(state, now, ctx.clock),
};
