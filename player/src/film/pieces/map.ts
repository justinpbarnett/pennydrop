import { clamp01, type Drawable, integerArg, type LabDef, lerp } from "../../lab";
import { landRings } from "../land";

interface Place {
  name: string;
  lon: number;
  lat: number;
  side: "left" | "right" | "above" | "below";
}

interface MapState {
  west: number;
  east: number;
  south: number;
  north: number;
  places: Place[];
  reached: number;
}

const WIDTH = 3200;
const DOT = 15;
const ROUTE_WIDTH = 9;
const NAME_SIZE = 60;
const NAME_GAP = 36;
const TRAVEL_SECONDS = 1.6;
const OLD_LEG_OPACITY = 0.5;
const LAND_CACHE = new Map<string, Drawable[]>();

function scaleOf(state: MapState): { kx: number; ky: number; height: number } {
  const middle = ((state.north + state.south) / 2) * (Math.PI / 180);
  const spanX = (state.east - state.west) * Math.cos(middle);
  const spanY = state.north - state.south;
  const ky = WIDTH / spanX;
  return { kx: ky * Math.cos(middle), ky, height: spanY * ky };
}

function project(state: MapState, lon: number, lat: number): { x: number; y: number } {
  const { kx, ky } = scaleOf(state);
  return { x: (lon - state.west) * kx, y: (state.north - lat) * ky };
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

function landDrawables(state: MapState): Drawable[] {
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
      const at2 = project(state, p[0]!, p[1]!);
      return [at2.x, at2.y];
    });
    drawables.push({ id: `land-${index}`, kind: "path", x: 0, y: 0, points, closed: true, fill: "fill2", stroke: "edge", strokeWidth: 3, z: 1 });
  });
  LAND_CACHE.set(key, drawables);
  return drawables;
}

function labelAt(place: Place, at: { x: number; y: number }, index: number, role: "ink" | "muted"): Drawable {
  const gap = DOT + NAME_GAP;
  const spot = {
    left: { x: at.x - gap, y: at.y, anchor: "end" as const },
    right: { x: at.x + gap, y: at.y, anchor: "start" as const },
    above: { x: at.x, y: at.y - gap - NAME_SIZE / 2, anchor: "middle" as const },
    below: { x: at.x, y: at.y + gap + NAME_SIZE / 2, anchor: "middle" as const },
  }[place.side];
  return { id: `name-${index}`, kind: "text", ...spot, text: place.name, size: NAME_SIZE, font: "read", fill: role, z: 4 };
}

function stopDrawables(state: MapState, index: number, progress: number): Drawable[] {
  const place = state.places[index]!;
  const at = project(state, place.lon, place.lat);
  const out: Drawable[] = [];
  if (index > 0) {
    const from = project(state, state.places[index - 1]!.lon, state.places[index - 1]!.lat);
    out.push({ id: `leg-${index}`, kind: "path", x: 0, y: 0, points: [from.x, from.y, at.x, at.y], stroke: "accent", strokeWidth: ROUTE_WIDTH, draw: clamp01(progress * 1.25), z: 2 });
  }
  const arrival = clamp01((progress - 0.75) * 4);
  out.push({ id: `dot-${index}`, kind: "circle", x: at.x, y: at.y, r: DOT * 1.4, fill: "accent", stroke: "ground", strokeWidth: 4, opacity: arrival, z: 5 }, { ...labelAt(place, at, index, "ink"), opacity: arrival });
  return out;
}

function parsePlaces(raw: unknown, objectId: string): Place[] {
  if (!Array.isArray(raw) || raw.length < 2) throw new Error(`${objectId}: "places" must list at least two stops in travel order`);
  return raw.map((entry, position) => {
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.lon !== "number" || typeof item.lat !== "number") throw new Error(`${objectId}: places[${position}] needs "name", "lon" and "lat"`);
    const side = item.side ?? "right";
    if (side !== "left" && side !== "right" && side !== "above" && side !== "below") throw new Error(`${objectId}: places[${position}] "side" must be left, right, above or below`);
    return { name: item.name, lon: item.lon, lat: item.lat, side };
  });
}

export const primitive: LabDef<Record<string, unknown>, MapState> = {
  id: "map",
  title: "Route map",
  reading: "required",
  catalog: {
    summary: "A map with real coastlines and a route that is drawn stop by stop. Aim the camera at part of it with a camera move's focus.",
    spec: {
      region: "[west, south, east, north] in degrees",
      places: 'the stops in travel order: [{"name": "Toulon", "lon": 5.93, "lat": 43.12, "side": "left"}]; side puts the name left, right, above or below the dot',
    },
    example: ['{"scene":{"route":{"kind":"map","region":[-6,27,36,53],"places":[{"name":"Paris","lon":2.35,"lat":48.86,"side":"above"},{"name":"Milan","lon":9.19,"lat":45.46}]}},"do":[{"cue":"Milan","op":"go","on":["route"],"to":1}]}'],
  },
  init(spec, objectId) {
    const region = spec.region;
    if (!Array.isArray(region) || region.length !== 4 || region.some((value) => typeof value !== "number")) throw new Error(`${objectId}: "region" must be [west, south, east, north] in degrees`);
    const [west, south, east, north] = region as number[];
    if (east! <= west! || north! <= south!) throw new Error(`${objectId}: "region" must have east after west and north after south`);
    return { west: west!, south: south!, east: east!, north: north!, places: parsePlaces(spec.places, objectId), reached: 0 };
  },
  ops: {
    go: {
      doc: 'travels to a stop: {"to": 3} draws the route up to the fourth stop; "to" counts from 0 and stop 0 is where the route begins',
      seconds: TRAVEL_SECONDS,
      apply: (state, op) => ({ ...state, reached: integerArg(op.args, "to", "go", 0, state.places.length - 1) + 1 }),
      during: (_before, after, _op, progress) => stopDrawables(after, after.reached - 1, progress),
    },
  },
  size: (state) => ({ w: WIDTH, h: scaleOf(state).height }),
  draw(state) {
    const out = [...landDrawables(state)];
    for (let index = 0; index < state.reached; index += 1) {
      const place = state.places[index]!;
      const at = project(state, place.lon, place.lat);
      if (index > 0) {
        const from = project(state, state.places[index - 1]!.lon, state.places[index - 1]!.lat);
        out.push({ id: `leg-${index}`, kind: "path", x: 0, y: 0, points: [from.x, from.y, at.x, at.y], stroke: "accent", strokeWidth: ROUTE_WIDTH, opacity: index === state.reached - 1 ? 1 : OLD_LEG_OPACITY, z: 2 });
      }
      const latest = index === state.reached - 1;
      out.push({ id: `dot-${index}`, kind: "circle", x: at.x, y: at.y, r: DOT * (latest ? 1.4 : 1), fill: "accent", opacity: latest ? 1 : OLD_LEG_OPACITY, stroke: "ground", strokeWidth: 4, z: 5 }, labelAt(place, at, index, latest ? "ink" : "muted"));
    }
    return out;
  },
};
