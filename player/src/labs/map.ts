import {
  boxDrawable,
  clamp01,
  type Drawable,
  fail,
  fitText,
  type LabDef,
  type LabOp,
  lerp,
  numberArg,
  type Paint,
  type Point,
  type Rect,
  readsWords,
  type Role,
  type Size,
  stringArg,
  textDrawable,
} from "../lab";
import { textWidth } from "../text-metrics";
import land from "./assets/map/land.json";

interface Place {
  name: string;
  lat: number;
  lon: number;
}

interface Route {
  through: number[];
  color: Role;
}

interface Era {
  name: string;
  from: number;
  to: number;
  color: Role;
}

interface MapEvent {
  name: string;
  year: number;
  place: number | null;
}

interface Axis {
  from: number;
  to: number;
  step: number;
  bc: boolean;
}

interface CoastGrid {
  cols: number;
  rows: number;
  sums: number[];
}

interface MapState {
  objectId: string;
  reading: boolean;
  places: Place[];
  shown: number[];
  routes: Route[];
  eras: Era[];
  events: MapEvent[];
  axis: Axis;
  trail: Layout[];
}

interface Layout {
  shown: number;
  routes: number;
}

interface Geometry {
  places: (Place & { at: Point })[];
  land: Point[][];
  coast: CoastGrid;
}

interface Laid extends Omit<MapState, "places">, Geometry {
  labels: PlaceLabel[];
}

interface MapSpec {
  places?: unknown;
  from?: unknown;
  to?: unknown;
  reading?: unknown;
}

interface Projection {
  west: number;
  north: number;
  scale: number;
  squeeze: number;
}

interface ClipEdge {
  inside(point: Point): boolean;
  cross(from: Point, to: Point): Point;
}

interface PlaceLabel {
  place: number;
  plate: Rect;
  leader: [Point, Point] | null;
}

interface EventSlot {
  event: number;
  row: number;
  box: Rect;
}

interface EraSlot {
  era: number;
  row: number;
  span: Rect;
  label: { at: Point; size: number; anchor: "start" | "middle" | "end" };
}

type Interval = [number, number];

const RINGS = (land as { rings: number[][][] }).rings;
const SERIES: Role[] = ["series1", "series2", "series3", "series4", "series5", "series6"];
const MAX_PLACES = 12;
const MAX_ROUTES = SERIES.length;
const MAX_LAT = 85;
const MIN_YEAR = -10000;
const MAX_YEAR = 3000;

const WIDTH = 1480;
const HEIGHT = 780;
const PANEL_GAP = 20;
const PANEL_PAD = 24;
const EVENT_TEXT = 26;
const EVENT_ROW_PITCH = EVENT_TEXT + 12;
const EVENT_ROWS = 4;
const STEM_LENGTH = 32;
const STEM_LABEL_INSET = 10;
const AXIS_INSET = 70;
const TICK_LENGTH = 8;
const TICK_TEXT = 22;
const TICK_LABEL_OFFSET = 32;
const TICK_GAP = 40;
const YEAR_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
const ERA_OFFSET = 58;
const ERA_HEIGHT = 38;
const ERA_GAP = 12;
const ERA_ROWS = 2;
const ERA_TEXT = 24;
const MIN_TEXT = 22;
const ERA_INSIDE_PAD = 8;
const ERA_SIDE_GAP = 16;
const ERA_MIN_WIDTH = 8;
const ERA_LABEL_FADE = 0.3;
const MOST_ABOVE_AXIS = EVENT_ROWS * EVENT_ROW_PITCH + STEM_LENGTH;
const MOST_BELOW_AXIS = ERA_OFFSET + ERA_ROWS * ERA_HEIGHT + (ERA_ROWS - 1) * ERA_GAP;
const PANEL_HEIGHT = 2 * PANEL_PAD + MOST_ABOVE_AXIS + MOST_BELOW_AXIS;
const MAP_AREA: Size = { w: WIDTH, h: HEIGHT - PANEL_GAP - PANEL_HEIGHT };
const PANEL_TOP = MAP_AREA.h + PANEL_GAP;
const AXIS_LEFT = AXIS_INSET;
const AXIS_RIGHT = WIDTH - AXIS_INSET;

const EXTENT_PAD = 0.18;
const MIN_PAD_DEGREES = 1.5;
const MIN_POINT_STEP = 0.75;
const MIN_RING_SPAN = 2.5;
const COAST_CELL = 6;
const COAST_WIDTH = 1.2;

const DOT_RADIUS = 10;
const EVENT_DOT_RADIUS = 9;
const PLACE_TEXT = 28;
const PLATE_PAD = 8;
const LABEL_REACHES = [14, 24, 36, 50, 65, 80, 100, 125];
const LABEL_DIRECTIONS = 48;
const LEADER_START_GAP = 4;
const LEADER_COAST_SKIP = 24;
const LEADER_ROUTE_ANGLE = 70;
const LEADER_ROUTE_MIN_ANGLE = 40;
const STRAIN_COST = 400;
const PLATE_LINE_CLEAR = 8;
const MIN_LEADER = 12;
const LEADER_TEXT_GAP = 18;
const EDGE_CLEAR = 12;
const LABEL_GAP = 16;
const PLATE_GAP = 6;
const LINE_CLEAR = 20;
const COAST_CLEAR = 4;
const BLOCKED_COST = 1e6;
const COAST_COST = 8;
const ISLAND_SPAN = 160;
const ISLAND_COST = 5000;
const REACH_COST = 6;
const LEADER_COAST_COST = 400;

const ROUTE_WIDTH = 4;
const THICKEST_THEME_STROKE = 2.4;
const WIDEST_HEAD_LENGTH = 16 + 2 * ROUTE_WIDTH * THICKEST_THEME_STROKE;
const WIDEST_HEAD_WING = 16;
const HEAD_CLEAR = WIDEST_HEAD_WING + EDGE_CLEAR;
const ROUTE_CLEAR = DOT_RADIUS + 9;
const ARROW_STOP = DOT_RADIUS + 7;
const MIN_LEG = 3 * ROUTE_CLEAR;
const MIN_SHAFT = 4;
const MIN_LAST_LEG = ROUTE_CLEAR + ARROW_STOP + WIDEST_HEAD_LENGTH + MIN_SHAFT;
const MIN_GROWING_ARROW = WIDEST_HEAD_LENGTH + MIN_SHAFT;
const TRAVELLER_RADIUS = 8;
const SETTLE_SHARE = 0.3;

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}

function yearText(year: number, axis: Axis): string {
  if (year < 0) return `${-year} BC`;
  return axis.bc && year > 0 ? `AD ${year}` : String(year);
}

function readPlaces(raw: unknown, objectId: string): Place[] {
  const example = '"places": [{"name": "Rome", "lat": 41.9, "lon": 12.5}]';
  if (!Array.isArray(raw) || raw.length === 0) fail(`${objectId}: "places" must be a non-empty list such as ${example}`);
  if (raw.length > MAX_PLACES) fail(`${objectId}: at most ${MAX_PLACES} places fit on one map, got ${raw.length}; drop some`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const where = `places[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail(`${objectId}: ${where} must be an object such as {"name": "Rome", "lat": 41.9, "lon": 12.5}`);
    const { name, lat, lon } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "") fail(`${objectId}: ${where} needs a "name" as text, such as "Rome"`);
    if (seen.has(name)) fail(`${objectId}: place "${name}" appears twice; names must be unique`);
    seen.add(name);
    if (typeof lat !== "number" || !Number.isFinite(lat) || Math.abs(lat) > MAX_LAT)
      fail(`${objectId}: ${where} "lat" must be degrees north from -${MAX_LAT} to ${MAX_LAT} (south is negative), such as 41.9`);
    if (typeof lon !== "number" || !Number.isFinite(lon) || Math.abs(lon) > 180) fail(`${objectId}: ${where} "lon" must be degrees east from -180 to 180 (west is negative), such as 12.5`);
    return { name, lat, lon };
  });
}

function readYear(spec: MapSpec, key: "from" | "to", objectId: string): number {
  const value = spec[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_YEAR || value > MAX_YEAR) {
    fail(`${objectId}: "${key}" must be a whole year from ${MIN_YEAR} to ${MAX_YEAR} (BC is negative, so 218 BC is -218), got ${JSON.stringify(value)}`);
  }
  return value;
}

function readReading(spec: MapSpec, objectId: string): boolean {
  if (spec.reading !== undefined && typeof spec.reading !== "boolean") fail(`${objectId}: "reading" must be true or false`);
  return readsWords({ ...spec });
}

function projectionFor(places: Place[], map: Size): Projection {
  const lats = places.map((place) => place.lat);
  const lons = places.map((place) => place.lon);
  const latPad = Math.max((Math.max(...lats) - Math.min(...lats)) * EXTENT_PAD, MIN_PAD_DEGREES);
  const lonPad = Math.max((Math.max(...lons) - Math.min(...lons)) * EXTENT_PAD, MIN_PAD_DEGREES);
  const south = Math.max(-MAX_LAT, Math.min(...lats) - latPad);
  const north = Math.min(MAX_LAT, Math.max(...lats) + latPad);
  const west = Math.min(...lons) - lonPad;
  const east = Math.max(...lons) + lonPad;
  const squeeze = Math.cos(degrees((south + north) / 2));
  const scale = Math.min(map.w / ((east - west) * squeeze), map.h / (north - south));
  return {
    west: (west + east) / 2 - map.w / (2 * scale * squeeze),
    north: (south + north) / 2 + map.h / (2 * scale),
    scale,
    squeeze,
  };
}

function project(projection: Projection, lon: number, lat: number): Point {
  return { x: (lon - projection.west) * projection.squeeze * projection.scale, y: (projection.north - lat) * projection.scale };
}

function ringInView(ring: number[][], projection: Projection, map: Size): boolean {
  const east = projection.west + map.w / (projection.scale * projection.squeeze);
  const south = projection.north - map.h / projection.scale;
  const lons = ring.map((point) => point[0]!);
  const lats = ring.map((point) => point[1]!);
  return Math.max(...lons) >= projection.west && Math.min(...lons) <= east && Math.max(...lats) >= south && Math.min(...lats) <= projection.north;
}

function clipEdge(axis: "x" | "y", limit: number, side: 1 | -1): ClipEdge {
  return {
    inside: (point) => (point[axis] - limit) * side >= 0,
    cross(from, to) {
      const t = (limit - from[axis]) / (to[axis] - from[axis]);
      return axis === "x" ? { x: limit, y: lerp(from.y, to.y, t) } : { x: lerp(from.x, to.x, t), y: limit };
    },
  };
}

function mapEdges(map: Size): ClipEdge[] {
  return [clipEdge("x", 0, 1), clipEdge("x", map.w, -1), clipEdge("y", 0, 1), clipEdge("y", map.h, -1)];
}

function clipAgainst(points: Point[], edge: ClipEdge): Point[] {
  return points.flatMap((current, index) => {
    const previous = points[(index + points.length - 1) % points.length]!;
    const crossing = edge.inside(current) !== edge.inside(previous) ? [edge.cross(previous, current)] : [];
    return edge.inside(current) ? [...crossing, current] : crossing;
  });
}

function thin(points: Point[]): Point[] {
  const kept: Point[] = [];
  points.forEach((point) => {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= MIN_POINT_STEP) kept.push(point);
  });
  return kept;
}

function spansEnough(points: Point[]): boolean {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) >= MIN_RING_SPAN;
}

function usableRing(points: Point[]): boolean {
  return points.length >= 3 && spansEnough(points);
}

function landRings(projection: Projection, map: Size): Point[][] {
  const edges = mapEdges(map);
  return RINGS.flatMap((ring) => {
    if (!ringInView(ring, projection, map)) return [];
    const projected = ring.map((point) => project(projection, point[0]!, point[1]!));
    const outline = thin(edges.reduce(clipAgainst, projected));
    return usableRing(outline) ? [outline] : [];
  });
}

function ringEdges(ring: Point[]): [Point, Point][] {
  return ring.map((point, index) => [point, ring[(index + 1) % ring.length]!]);
}

function coastGrid(rings: Point[][], map: Size): CoastGrid {
  const cols = Math.ceil(map.w / COAST_CELL);
  const rows = Math.ceil(map.h / COAST_CELL);
  const counts = new Array<number>(cols * rows).fill(0);
  const mark = ({ x, y }: Point) => {
    counts[Math.min(rows - 1, Math.floor(y / COAST_CELL)) * cols + Math.min(cols - 1, Math.floor(x / COAST_CELL))]! += 1;
  };
  rings.flatMap(ringEdges).forEach(([from, to]) => {
    const samples = Math.max(1, Math.ceil(legLength([from, to]) / (COAST_CELL / 2)));
    for (let sample = 0; sample < samples; sample++) mark(lerpPoint(from, to, sample / samples));
  });
  const sums = new Array<number>((cols + 1) * (rows + 1)).fill(0);
  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      sums[row * (cols + 1) + col] = counts[(row - 1) * cols + col - 1]! + sums[(row - 1) * (cols + 1) + col]! + sums[row * (cols + 1) + col - 1]! - sums[(row - 1) * (cols + 1) + col - 1]!;
    }
  }
  return { cols, rows, sums };
}

function coastCount(grid: CoastGrid, rect: Rect): number {
  const cell = (value: number, round: (value: number) => number, limit: number) => Math.min(limit, Math.max(0, round(value / COAST_CELL)));
  const sum = (r: number, c: number) => grid.sums[r * (grid.cols + 1) + c]!;
  const left = cell(rect.x, Math.floor, grid.cols);
  const right = cell(rect.x + rect.w, Math.ceil, grid.cols);
  const top = cell(rect.y, Math.floor, grid.rows);
  const bottom = cell(rect.y + rect.h, Math.ceil, grid.rows);
  return sum(bottom, right) - sum(top, right) - sum(bottom, left) + sum(top, left);
}

function timeAxis(from: number, to: number, objectId: string): Axis {
  if (to <= from) fail(`${objectId}: "to" (${to}) must be a later year than "from" (${from})`);
  const bc = from < 0;
  const sample: Axis = { from, to, step: 1, bc };
  const widest = Math.max(...[from, to, Math.round((from + to) / 2)].map((year) => textWidth(yearText(year, sample), TICK_TEXT, "read")));
  const perYear = (AXIS_RIGHT - AXIS_LEFT) / (to - from);
  const step = YEAR_STEPS.find((candidate) => candidate * perYear >= widest + TICK_GAP) ?? YEAR_STEPS[YEAR_STEPS.length - 1]!;
  return { ...sample, step };
}

function yearX(axis: Axis, year: number): number {
  return lerp(AXIS_LEFT, AXIS_RIGHT, (year - axis.from) / (axis.to - axis.from));
}

function tickYears(axis: Axis): number[] {
  const first = Math.ceil(axis.from / axis.step) * axis.step;
  return Array.from({ length: Math.floor((axis.to - first) / axis.step) + 1 }, (_, index) => first + index * axis.step);
}

function placeIndex(state: MapState, name: unknown, opName: string): number {
  const known = state.places.map((place) => place.name);
  const index = typeof name === "string" ? known.indexOf(name) : -1;
  if (index < 0) fail(`op "${opName}": ${state.objectId} has no place ${JSON.stringify(name)}; places are ${known.join(", ")}, or add it to "places" in the spec`);
  return index;
}

function placeList(state: MapState, op: LabOp, key: string, example: string): number[] {
  const names = op.args[key];
  if (!Array.isArray(names) || names.length === 0) fail(`op "${op.name}" needs "${key}" as a list of place names, such as ${example}`);
  return names.map((name) => placeIndex(state, name, op.name));
}

function withShown(state: MapState, places: number[]): MapState {
  return { ...state, shown: [...state.shown, ...places.filter((place, index) => !state.shown.includes(place) && places.indexOf(place) === index)] };
}

const MAX_CACHED = 200;
const geometries = new Map<string, Geometry>();
const labelings = new Map<string, PlaceLabel[]>();
const laidStates = new WeakMap<MapState, Laid>();

function remembered<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const known = cache.get(key);
  if (known) return known;
  if (cache.size >= MAX_CACHED) cache.clear();
  const made = make();
  cache.set(key, made);
  return made;
}

function geometryOf(places: Place[]): Geometry {
  return remembered(geometries, JSON.stringify(places), () => {
    const projection = projectionFor(places, MAP_AREA);
    const land = landRings(projection, MAP_AREA);
    return { places: places.map((place) => ({ ...place, at: project(projection, place.lon, place.lat) })), land, coast: coastGrid(land, MAP_AREA) };
  });
}

function labelsAfter(state: MapState, step: number): PlaceLabel[] {
  if (step < 0) return [];
  const layout = state.trail[step]!;
  const trail = state.trail.slice(0, step + 1);
  const shown = state.shown.slice(0, layout.shown);
  const routes = state.routes.slice(0, layout.routes);
  return remembered(labelings, JSON.stringify([state.places, trail, shown, routes]), () => {
    const view = { ...state, ...geometryOf(state.places), shown, routes, labels: labelsAfter(state, step - 1) };
    return placeLabels(view);
  });
}

function laidOut(state: MapState): Laid {
  const known = laidStates.get(state);
  if (known) return known;
  const laid = { ...state, ...geometryOf(state.places), labels: labelsAfter(state, state.trail.length - 1) };
  laidStates.set(state, laid);
  return laid;
}

function played(state: MapState): MapState {
  return { ...state, trail: [...state.trail, { shown: state.shown.length, routes: state.routes.length }] };
}

function yearArg(state: MapState, op: LabOp, key: string): number {
  const year = numberArg(op.args, key, op.name);
  const { from, to } = state.axis;
  if (year < from || year > to) fail(`op "${op.name}": "${key}" ${year} is outside the timeline (${from} to ${to}); widen "from" and "to" in the spec`);
  return year;
}

function routeLegs(state: Laid, route: Route): [Point, Point][] {
  return route.through.slice(1).map((place, index) => [state.places[route.through[index]!]!.at, state.places[place]!.at]);
}

function pointToward(from: Point, to: Point, distance: number): Point {
  return lerpPoint(from, to, distance / Math.hypot(to.x - from.x, to.y - from.y));
}

function drawnLegs(state: Laid, route: Route): [Point, Point][] {
  return routeLegs(state, route).map(([from, to], index, all) => [pointToward(from, to, ROUTE_CLEAR), pointToward(to, from, index === all.length - 1 ? ARROW_STOP : ROUTE_CLEAR)]);
}

function arrowHeads(state: Laid): [Point, Point][] {
  return state.routes.map((route) => {
    const legs = drawnLegs(state, route);
    const tip = legs[legs.length - 1]![1];
    return [pointToward(tip, legs[legs.length - 1]![0], WIDEST_HEAD_LENGTH), tip];
  });
}

function legLength([from, to]: [Point, Point]): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function checkedRoute(state: Laid, through: number[]): number[] {
  if (through.length < 2) fail(`op "routes" needs at least two places in "through", such as ["New Carthage", "Alps pass"]`);
  through.slice(1).forEach((place, index) => {
    const before = through[index]!;
    if (place === before) fail(`op "routes": "${state.places[place]!.name}" follows itself in "through"; list each stop once in order`);
    if (legLength([state.places[before]!.at, state.places[place]!.at]) < MIN_LEG)
      fail(`op "routes": "${state.places[before]!.name}" and "${state.places[place]!.name}" sit too close on this map to draw a leg between them; skip one of them in "through"`);
  });
  const last = legLength([state.places[through[through.length - 2]!]!.at, state.places[through[through.length - 1]!]!.at]);
  if (last < MIN_LAST_LEG)
    fail(
      `op "routes": the last leg ends at "${state.places[through[through.length - 1]!]!.name}" only ${Math.round(last)} px from the stop before it on this map; end the route at a place farther away`,
    );
  return through;
}

function segmentEntry(from: Point, to: Point, rect: Rect): number | null {
  return segmentSpan(from, to, rect)?.[0] ?? null;
}

function segmentSpan(from: Point, to: Point, rect: Rect): Interval | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bounds: [number, number][] = [
    [-dx, from.x - rect.x],
    [dx, rect.x + rect.w - from.x],
    [-dy, from.y - rect.y],
    [dy, rect.y + rect.h - from.y],
  ];
  let enter = 0;
  let leave = 1;
  for (const [direction, distance] of bounds) {
    if (direction === 0) {
      if (distance < 0) return null;
      continue;
    }
    const t = distance / direction;
    if (direction < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return null;
  }
  return [enter, leave];
}

function turn(a: Point, b: Point, c: Point): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

function segmentsCross([a, b]: [Point, Point], [c, d]: [Point, Point]): boolean {
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
}

function leaderCrossings(grid: CoastGrid, leader: [Point, Point] | null): number {
  if (!leader) return 0;
  const length = legLength(leader);
  if (length <= LEADER_COAST_SKIP) return 0;
  const start = lerpPoint(leader[0], leader[1], LEADER_COAST_SKIP / length);
  const samples = Math.ceil((length - LEADER_COAST_SKIP) / COAST_CELL);
  const onCoast = Array.from({ length: samples + 1 }, (_, index) => coastCount(grid, inflate({ ...lerpPoint(start, leader[1], index / samples), w: 0, h: 0 }, 1)) > 0);
  return onCoast.filter((hit, index) => hit && !onCoast[index - 1]).length;
}

function segmentHitsRect(from: Point, to: Point, rect: Rect): boolean {
  return segmentEntry(from, to, rect) !== null;
}

function pointToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const t = clamp01(((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(from.x + t * dx - point.x, from.y + t * dy - point.y);
}

function pointToRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - rect.x - rect.w);
  const dy = Math.max(rect.y - point.y, 0, point.y - rect.y - rect.h);
  return Math.hypot(dx, dy);
}

function rectCorners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ];
}

function segmentNearRect([from, to]: [Point, Point], rect: Rect, clearance: number): boolean {
  if (segmentHitsRect(from, to, rect)) return true;
  const nearest = Math.min(pointToRect(from, rect), pointToRect(to, rect), ...rectCorners(rect).map((corner) => pointToSegment(corner, from, to)));
  return nearest < clearance;
}

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + 2 * by, h: rect.h + 2 * by };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function insideMap(rect: Rect, map: Size): boolean {
  return rect.x >= EDGE_CLEAR && rect.y >= EDGE_CLEAR && rect.x + rect.w <= map.w - EDGE_CLEAR && rect.y + rect.h <= map.h - EDGE_CLEAR;
}

function dotRect(at: Point): Rect {
  return inflate({ x: at.x, y: at.y, w: 0, h: 0 }, DOT_RADIUS);
}

function plateSize(name: string): Size {
  return { w: textWidth(name, PLACE_TEXT, "read") + 2 * PLATE_PAD, h: PLACE_TEXT + 2 * PLATE_PAD };
}

function textBox(plate: Rect): Rect {
  return inflate(plate, -PLATE_PAD);
}

function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function leaderFor(at: Point, plate: Rect): [Point, Point] | null {
  const center = rectCenter(plate);
  const length = Math.hypot(center.x - at.x, center.y - at.y);
  const entry = segmentEntry(at, center, inflate(textBox(plate), LEADER_TEXT_GAP));
  const start = DOT_RADIUS + LEADER_START_GAP;
  if (entry === null || entry * length - start < MIN_LEADER) return null;
  return [lerpPoint(at, center, start / length), lerpPoint(at, center, entry)];
}

function lerpPoint(from: Point, to: Point, t: number): Point {
  return { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) };
}

interface PlateCandidate {
  plate: Rect;
  preference: number;
}

function plateCandidates(at: Point, size: Size): PlateCandidate[] {
  return LABEL_REACHES.flatMap((reach) =>
    Array.from({ length: LABEL_DIRECTIONS }, (_, index) => {
      const angle = (index * 2 * Math.PI) / LABEL_DIRECTIONS;
      const center = { x: at.x + Math.cos(angle) * (DOT_RADIUS + reach + size.w / 2), y: at.y - Math.sin(angle) * (DOT_RADIUS + reach + size.h / 2) };
      return { plate: { x: center.x - size.w / 2, y: center.y - size.h / 2, w: size.w, h: size.h }, preference: REACH_COST * reach + index / LABEL_DIRECTIONS };
    }),
  );
}

function direction(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function angleBetween(a: number, b: number): number {
  const difference = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(difference, 2 * Math.PI - difference);
}

function legDirectionsAt(legs: [Point, Point][], at: Point): number[] {
  return legs.flatMap(([from, to]) => {
    if (from.x === at.x && from.y === at.y) return [direction(from, to)];
    if (to.x === at.x && to.y === at.y) return [direction(to, from)];
    return [];
  });
}

function leaderAlongLeg(legs: [Point, Point][], at: Point, leader: [Point, Point], limit: number): boolean {
  const aim = direction(at, leader[1]);
  return legDirectionsAt(legs, at).some((leg) => angleBetween(aim, leg) < degrees(limit));
}

function labelOrder(state: Laid, earlier: PlaceLabel[], freedom: (place: number) => number): number[] {
  const kept = earlier.map((label) => label.place).filter((place) => state.shown.includes(place));
  const fresh = state.shown.filter((place) => !kept.includes(place)).sort((a, b) => freedom(a) - freedom(b));
  return [...kept, ...fresh];
}

function ringBounds(ring: Point[]): Rect {
  const xs = ring.map((point) => point.x);
  const ys = ring.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function islandBounds(rings: Point[][]): Rect[] {
  return rings
    .map(ringBounds)
    .filter((bounds) => Math.max(bounds.w, bounds.h) < ISLAND_SPAN)
    .map((bounds) => inflate(bounds, EDGE_CLEAR));
}

function islandsCovered(islands: Rect[], plate: Rect, leader: [Point, Point] | null): { under: number; crossed: number } {
  const under = islands.filter((island) => overlaps(island, plate));
  const crossed = islands.filter((island) => !under.includes(island) && leader !== null && segmentHitsRect(leader[0], leader[1], island));
  return { under: under.length, crossed: crossed.length };
}

function slidInside(plate: Rect, map: Size): Rect {
  const x = Math.min(Math.max(plate.x, EDGE_CLEAR), map.w - EDGE_CLEAR - plate.w);
  const y = Math.min(Math.max(plate.y, EDGE_CLEAR), map.h - EDGE_CLEAR - plate.h);
  return { ...plate, x, y };
}

function headOutline([base, tip]: [Point, Point]): [Point, Point][] {
  const length = legLength([base, tip]);
  const across = { x: (-(tip.y - base.y) / length) * WIDEST_HEAD_WING, y: ((tip.x - base.x) / length) * WIDEST_HEAD_WING };
  const left = { x: base.x + across.x, y: base.y + across.y };
  const right = { x: base.x - across.x, y: base.y - across.y };
  return [
    [tip, left],
    [tip, right],
    [left, right],
  ];
}

function placeLabels(state: Laid): PlaceLabel[] {
  const kept = placeLabelsAround(state, state.labels);
  if (!kept.blocked) return kept.labels;
  const fresh = placeLabelsAround(state, []);
  return fresh.blocked < kept.blocked ? fresh.labels : kept.labels;
}

function placeLabelsAround(state: Laid, earlier: PlaceLabel[]): { labels: PlaceLabel[]; blocked: number } {
  const dots = state.shown.map((place) => dotRect(state.places[place]!.at));
  const legs = state.routes.flatMap((route) => routeLegs(state, route));
  const heads = arrowHeads(state);
  const islands = islandBounds(state.land);
  const previous = new Map(earlier.map((label) => [label.place, label.plate]));
  const nearText = (line: [Point, Point], plate: Rect) => segmentNearRect(line, textBox(plate), LINE_CLEAR);
  const headEdges = heads.flatMap(headOutline);
  const shafts = state.routes.flatMap((route) => drawnLegs(state, route));
  const blocked = (place: number, plate: Rect, labels: PlaceLabel[]) => {
    const at = state.places[place]!.at;
    const leader = leaderFor(at, plate);
    const tie: [Point, Point] = [at, rectCenter(plate)];
    const otherLeaders = labels.flatMap((label) => (label.leader ? [label.leader] : []));
    const lines = [...legs, ...otherLeaders];
    return (
      !insideMap(plate, MAP_AREA) ||
      labels.some((other) => overlaps(inflate(other.plate, PLATE_GAP), plate) || (leader !== null && nearText(leader, other.plate))) ||
      dots.some((dot, index) => overlaps(dot, inflate(textBox(plate), EDGE_CLEAR)) || (leader !== null && state.shown[index] !== place && segmentHitsRect(leader[0], leader[1], dot))) ||
      lines.some((line) => nearText(line, plate)) ||
      headEdges.some((edge) => segmentNearRect(edge, plate, PLATE_LINE_CLEAR)) ||
      shafts.some((shaft) => segmentNearRect(shaft, plate, PLATE_LINE_CLEAR)) ||
      lines.some((line) => segmentsCross(tie, line)) ||
      (leader !== null && leaderAlongLeg(legs, at, leader, LEADER_ROUTE_MIN_ANGLE))
    );
  };
  const strained = (place: number, plate: Rect) => {
    const at = state.places[place]!.at;
    const leader = leaderFor(at, plate);
    return heads.some((head) => segmentNearRect(head, plate, HEAD_CLEAR)) || (leader !== null && leaderAlongLeg(legs, at, leader, LEADER_ROUTE_ANGLE));
  };
  const candidates = (place: number, labels: PlaceLabel[]) => {
    const at = state.places[place]!.at;
    const kept = previous.get(place);
    const spread = plateCandidates(at, plateSize(state.places[place]!.name));
    const slid = spread.filter(({ plate }) => !insideMap(plate, MAP_AREA)).map(({ plate, preference }) => ({ plate: slidInside(plate, MAP_AREA), preference: preference + STRAIN_COST, slid: true }));
    const options = [...(kept ? [{ plate: kept, preference: 0, slid: false }] : []), ...spread.map((option) => ({ ...option, slid: false })), ...slid];
    return options.map(({ plate, preference, slid: moved }) => {
      const leader = leaderFor(at, plate);
      const hard = blocked(place, plate, labels);
      const soft = strained(place, plate);
      const { under, crossed } = islandsCovered(islands, plate, leader);
      return {
        plate,
        hard,
        free: !hard && !soft && !moved,
        cost:
          (hard ? BLOCKED_COST : 0) +
          (insideMap(plate, MAP_AREA) ? 0 : BLOCKED_COST) +
          (soft ? STRAIN_COST : 0) +
          coastCount(state.coast, inflate(textBox(plate), COAST_CLEAR)) * COAST_COST +
          leaderCrossings(state.coast, leader) * LEADER_COAST_COST +
          under * ISLAND_COST +
          crossed * STRAIN_COST +
          preference,
      };
    });
  };
  const freedom = (place: number) => candidates(place, []).filter((candidate) => candidate.free).length;
  return labelOrder(state, earlier, freedom).reduce<{ labels: PlaceLabel[]; blocked: number }>(
    ({ labels, blocked }, place) => {
      const best = candidates(place, labels).reduce((winner, candidate) => (candidate.cost < winner.cost ? candidate : winner));
      return { labels: [...labels, { place, plate: best.plate, leader: leaderFor(state.places[place]!.at, best.plate) }], blocked: blocked + (best.hard ? 1 : 0) };
    },
    { labels: [], blocked: 0 },
  );
}

function intervalFree(occupied: Interval[], [start, end]: Interval): boolean {
  return occupied.every(([left, right]) => end + LABEL_GAP <= left || right + LABEL_GAP <= start);
}

function byYear<T>(items: T[], year: (item: T) => number): number[] {
  return items.map((_, index) => index).sort((a, b) => year(items[a]!) - year(items[b]!) || a - b);
}

function eventText(state: MapState, event: MapEvent): string {
  return `${event.name}, ${yearText(event.year, state.axis)}`;
}

function eventRowY(row: number, axisY: number): number {
  return axisY - STEM_LENGTH - EVENT_ROW_PITCH / 2 - row * EVENT_ROW_PITCH;
}

interface EventFootprint {
  event: number;
  stem: number;
  box: Interval;
}

function eventFootprints(state: MapState, index: number): EventFootprint[] {
  const event = state.events[index]!;
  const stem = yearX(state.axis, event.year);
  const width = textWidth(eventText(state, event), EVENT_TEXT, "read");
  const centered = Math.min(WIDTH - PANEL_PAD - width, Math.max(PANEL_PAD, stem - width / 2));
  const lefts = [centered, stem - STEM_LABEL_INSET, stem + STEM_LABEL_INSET - width].filter((left) => left >= PANEL_PAD && left + width <= WIDTH - PANEL_PAD);
  return [...new Set(lefts)].map((left) => ({ event: index, stem, box: [left, left + width] }));
}

interface RowedEvent {
  footprint: EventFootprint;
  row: number;
}

function eventFits(placed: RowedEvent[], footprint: EventFootprint, row: number): boolean {
  return placed.every((other) => {
    const boxes = other.row === row ? intervalFree([other.footprint.box], footprint.box) : true;
    const ownStem = other.row < row ? intervalFree([other.footprint.box], [footprint.stem, footprint.stem]) : true;
    const theirStem = row < other.row ? intervalFree([footprint.box], [other.footprint.stem, other.footprint.stem]) : true;
    return boxes && ownStem && theirStem;
  });
}

function assignEventRows(candidates: EventFootprint[][], placed: RowedEvent[]): RowedEvent[] | null {
  const [next, ...rest] = candidates;
  if (!next) return placed;
  for (const footprint of next) {
    for (let row = 0; row < EVENT_ROWS; row++) {
      if (!eventFits(placed, footprint, row)) continue;
      const solved = assignEventRows(rest, [...placed, { footprint, row }]);
      if (solved) return solved;
    }
  }
  return null;
}

function eventRows(state: MapState): RowedEvent[] {
  if (!state.reading) return [];
  const candidates = byYear(state.events, (event) => event.year).map((index) => eventFootprints(state, index));
  const assigned = assignEventRows(candidates, []);
  if (!assigned)
    fail(`op "events": no room on the timeline to label "${state.events[state.events.length - 1]!.name}" beside the other events; space the events more years apart or give them shorter names`);
  return assigned;
}

function eventSlots(rows: RowedEvent[], axisY: number): EventSlot[] {
  return rows.map(({ footprint, row }) => ({
    event: footprint.event,
    row,
    box: { x: footprint.box[0], y: eventRowY(row, axisY) - EVENT_TEXT / 2, w: footprint.box[1] - footprint.box[0], h: EVENT_TEXT },
  }));
}

function eraTop(row: number, axisY: number): number {
  return axisY + ERA_OFFSET + row * (ERA_HEIGHT + ERA_GAP);
}

function eraLabel(state: MapState, era: Era, span: Rect): EraSlot["label"] {
  const y = span.y + span.h / 2;
  const inside = fitText(era.name, ERA_TEXT, span.w - 2 * ERA_INSIDE_PAD, "read");
  if (inside >= MIN_TEXT || !state.reading) return { at: { x: span.x + span.w / 2, y }, size: inside, anchor: "middle" };
  const width = textWidth(era.name, ERA_TEXT, "read");
  const fitsRight = span.x + span.w + ERA_SIDE_GAP + width <= WIDTH - PANEL_PAD;
  return fitsRight ? { at: { x: span.x + span.w + ERA_SIDE_GAP, y }, size: ERA_TEXT, anchor: "start" } : { at: { x: span.x - ERA_SIDE_GAP, y }, size: ERA_TEXT, anchor: "end" };
}

function eraExtent(state: MapState, slot: Omit<EraSlot, "row">, name: string): Interval {
  const { label, span } = slot;
  if (!state.reading || label.anchor === "middle") return [span.x, span.x + span.w];
  const width = textWidth(name, label.size, "read");
  return label.anchor === "start" ? [span.x, label.at.x + width] : [label.at.x - width, span.x + span.w];
}

function eraSpan(state: MapState, era: Era, row: number, axisY: number, upTo = era.to): Rect {
  const left = yearX(state.axis, era.from);
  return { x: left, y: eraTop(row, axisY), w: Math.max(ERA_MIN_WIDTH, yearX(state.axis, upTo) - left), h: ERA_HEIGHT };
}

function eraSlots(state: MapState, axisY: number): EraSlot[] {
  const rows: Interval[][] = Array.from({ length: ERA_ROWS }, () => []);
  return byYear(state.eras, (era) => era.from).map((index) => {
    const era = state.eras[index]!;
    const row = rows.findIndex((occupied, level) => {
      const span = eraSpan(state, era, level, axisY);
      return intervalFree(occupied, eraExtent(state, { era: index, span, label: eraLabel(state, era, span) }, era.name));
    });
    if (row < 0) fail(`op "eras": "${era.name}" overlaps two eras already on the timeline, and only ${ERA_ROWS} rows fit; drop an era or shorten its years`);
    const span = eraSpan(state, era, row, axisY);
    const slot = { era: index, row, span, label: eraLabel(state, era, span) };
    rows[row]!.push(eraExtent(state, slot, era.name));
    return slot;
  });
}

interface TimelineLayout {
  axisY: number;
  events: EventSlot[];
  eras: EraSlot[];
}

function timelineLayout(state: MapState): TimelineLayout {
  const axisY = PANEL_TOP + PANEL_PAD + MOST_ABOVE_AXIS;
  return { axisY, events: eventSlots(eventRows(state), axisY), eras: eraSlots(state, axisY) };
}

function mapFrame(): Drawable[] {
  const sea = boxDrawable("sea", { x: 0, y: 0, w: MAP_AREA.w, h: MAP_AREA.h }, { fill: "fill", stroke: "rule", strokeWidth: 1.5, z: 0 });
  return [sea, boxDrawable("timeline-panel", { x: 0, y: PANEL_TOP, w: WIDTH, h: PANEL_HEIGHT }, { fill: "fill", stroke: "rule", strokeWidth: 1.5, z: 0 })];
}

const BORDER_TOLERANCE = 4;

function onMapBorder([from, to]: [Point, Point], map: Size): boolean {
  const near = (value: number, edge: number) => Math.abs(value - edge) < BORDER_TOLERANCE;
  const alongSide = near(from.x, to.x) && (near(from.x, 0) || near(from.x, map.w));
  const alongTop = near(from.y, to.y) && (near(from.y, 0) || near(from.y, map.h));
  return alongSide || alongTop;
}

function coastLines(ring: Point[], map: Size): Point[][] {
  const lines: Point[][] = [];
  let joined = false;
  ringEdges(ring).forEach((edge) => {
    if (onMapBorder(edge, map)) {
      joined = false;
      return;
    }
    if (joined) lines[lines.length - 1]!.push(edge[1]);
    else lines.push([edge[0], edge[1]]);
    joined = true;
  });
  return lines;
}

function pathDrawable(id: string, points: Point[], closed: boolean, fill: Paint, stroke: Role, strokeWidth: number): Drawable {
  const flat = points.flatMap((point) => [point.x, point.y]);
  return { id, kind: "path", x: flat[0]!, y: flat[1]!, points: flat, closed, fill, stroke, strokeWidth, z: 1, backdrop: true };
}

function landDrawables(state: Laid): Drawable[] {
  const clip: Rect = { x: 0, y: 0, w: MAP_AREA.w, h: MAP_AREA.h };
  const coast = state.land.flatMap((ring) => coastLines(ring, MAP_AREA));
  return [
    ...state.land.map((ring, index) => ({ ...pathDrawable(`land-${index}`, ring, true, "fill2", "fill2", 0), clip })),
    ...coast.map((line, index) => ({ ...pathDrawable(`coast-${index}`, line, false, "none", "muted", COAST_WIDTH), clip })),
  ];
}

function markedPlaces(state: MapState): number[] {
  return state.events.flatMap((event) => (event.place === null ? [] : [event.place]));
}

function placeDrawables(state: Laid): Drawable[] {
  const marked = markedPlaces(state);
  const dots = state.shown.map((place): Drawable => {
    const { at } = state.places[place]!;
    const isMarked = marked.includes(place);
    return {
      id: `place-${place}`,
      kind: "circle",
      x: at.x,
      y: at.y,
      r: DOT_RADIUS,
      fill: "ink",
      stroke: isMarked ? "accent" : "ground",
      strokeWidth: isMarked ? 4 : 3,
      z: 5,
      part: `${state.objectId}[${state.places[place]!.name}]`,
    };
  });
  if (!state.reading) return dots;
  const labels = state.labels.flatMap(({ place, plate, leader }): Drawable[] => [
    boxDrawable(`place-${place}-plate`, plate, { fill: "ground", stroke: "none", radius: 1, z: 6 }),
    textDrawable(`place-${place}-label`, state.places[place]!.name, rectCenter(plate), { size: PLACE_TEXT, z: 7 }),
    ...(leader ? [{ id: `place-${place}-leader`, kind: "line" as const, x: leader[0].x, y: leader[0].y, x2: leader[1].x, y2: leader[1].y, stroke: "muted" as const, strokeWidth: 2, z: 5 }] : []),
  ]);
  return [...dots, ...labels];
}

function legDrawable(id: string, from: Point, to: Point, last: boolean, color: Role): Drawable {
  return { id, kind: last ? "arrow" : "line", x: from.x, y: from.y, x2: to.x, y2: to.y, stroke: color, strokeWidth: ROUTE_WIDTH, z: 3 };
}

function routeDrawables(state: Laid, routeIndex: number): Drawable[] {
  const route = state.routes[routeIndex]!;
  const legs = drawnLegs(state, route);
  return legs.map(([from, to], index) => legDrawable(`route-${routeIndex}-leg-${index}`, from, to, index === legs.length - 1, route.color));
}

function growingRoute(state: Laid, routeIndex: number, progress: number): Drawable[] {
  const route = state.routes[routeIndex]!;
  const legs = drawnLegs(state, route);
  const total = legs.reduce((sum, leg) => sum + legLength(leg), 0);
  const travelled = clamp01(progress) * total;
  let start = 0;
  let front = legs[0]![0];
  const drawn = legs.map(([from, to], index): Drawable => {
    const length = legLength([from, to]);
    const share = clamp01((travelled - start) / length);
    start += length;
    const tip = lerpPoint(from, to, share);
    if (share > 0) front = tip;
    const headed = index === legs.length - 1 && share * length >= MIN_GROWING_ARROW;
    return { ...legDrawable(`route-${routeIndex}-leg-${index}`, from, tip, headed, route.color), opacity: share > 0 ? 1 : 0 };
  });
  const traveller: Drawable = {
    id: `route-${routeIndex}-traveller`,
    kind: "circle",
    x: front.x,
    y: front.y,
    r: TRAVELLER_RADIUS,
    fill: route.color,
    stroke: "ground",
    strokeWidth: 2,
    z: 4,
    opacity: progress > 0 && progress < 1 ? 1 : 0,
  };
  return [...drawn, traveller];
}

function axisDrawables(state: MapState, axisY: number): Drawable[] {
  const axisLine: Drawable = { id: "axis", kind: "line", x: AXIS_LEFT, y: axisY, x2: AXIS_RIGHT, y2: axisY, stroke: "edge", strokeWidth: 2.5, z: 2 };
  const ticks = tickYears(state.axis).flatMap((year): Drawable[] => {
    const x = yearX(state.axis, year);
    const mark: Drawable = { id: `tick-${year}`, kind: "line", x, y: axisY, x2: x, y2: axisY + TICK_LENGTH, stroke: "edge", strokeWidth: 1.5, z: 2 };
    if (!state.reading) return [mark];
    return [mark, textDrawable(`tick-${year}-label`, yearText(year, state.axis), { x, y: axisY + TICK_LABEL_OFFSET }, { size: TICK_TEXT, fill: "muted", z: 2 })];
  });
  return [axisLine, ...ticks];
}

function eraDrawables(state: MapState, slot: EraSlot, span = slot.span, labelOpacity = 1): Drawable[] {
  const era = state.eras[slot.era]!;
  const bar = boxDrawable(`era-${slot.era}`, span, { fill: "fill2", stroke: era.color, strokeWidth: 3, radius: 1, z: 2 });
  if (!state.reading) return [bar];
  return [bar, textDrawable(`era-${slot.era}-label`, era.name, slot.label.at, { size: slot.label.size, anchor: slot.label.anchor, z: 3, opacity: labelOpacity })];
}

function eventMarker(index: number, x: number, y: number): Drawable {
  return { id: `event-${index}-dot`, kind: "circle", x, y, r: EVENT_DOT_RADIUS, fill: "accent", stroke: "ground", strokeWidth: 2, z: 4 };
}

function eventDrawables(state: MapState, layout: TimelineLayout): Drawable[] {
  const { axisY } = layout;
  if (!state.reading) return state.events.map((event, index) => eventMarker(index, yearX(state.axis, event.year), axisY));
  return layout.events.flatMap(({ event: index, box }) => {
    const x = yearX(state.axis, state.events[index]!.year);
    return [
      eventMarker(index, x, axisY),
      { id: `event-${index}-stem`, kind: "line", x, y: box.y + box.h + EDGE_CLEAR, x2: x, y2: axisY - EVENT_DOT_RADIUS, stroke: "edge", strokeWidth: 2, z: 3 },
      textDrawable(`event-${index}-label`, eventText(state, state.events[index]!), { x: box.x + box.w / 2, y: box.y + box.h / 2 }, { size: EVENT_TEXT, z: 3 }),
    ];
  });
}

function timelineDrawables(state: MapState): Drawable[] {
  const layout = timelineLayout(state);
  return [...axisDrawables(state, layout.axisY), ...layout.eras.flatMap((slot) => eraDrawables(state, slot)), ...eventDrawables(state, layout)];
}

function changingDrawables(state: Laid): Drawable[] {
  return [...state.routes.flatMap((_, index) => routeDrawables(state, index)), ...placeDrawables(state), ...timelineDrawables(state)];
}

function blendDrawable(before: Drawable, after: Drawable, t: number): Drawable {
  const earlier = before as unknown as Record<string, unknown>;
  const mixed = Object.entries(after).map(([key, value]) => {
    const from = earlier[key];
    return [key, typeof value === "number" && typeof from === "number" ? lerp(from, value, t) : value];
  });
  return Object.fromEntries(mixed) as Drawable;
}

function settle(before: Laid, after: Laid, t: number): Drawable[] {
  const earlier = new Map(changingDrawables(before).map((item) => [item.id, item]));
  return changingDrawables(after).map((item) => {
    const was = earlier.get(item.id);
    return was ? blendDrawable(was, item, t) : { ...item, opacity: (item.opacity ?? 1) * t };
  });
}

function settleShare(progress: number): number {
  return clamp01(progress / SETTLE_SHARE);
}

function actShare(progress: number): number {
  return clamp01((progress - SETTLE_SHARE) / (1 - SETTLE_SHARE));
}

function routeSeconds(op: LabOp): number {
  const through = op.args.through;
  const legs = Array.isArray(through) ? Math.max(1, through.length - 1) : 1;
  return Math.min(5, 1.6 + 0.9 * legs);
}

export const lab: LabDef<MapSpec, MapState> = {
  id: "map",
  title: "Map and timeline",
  reading: "optional",
  catalog: {
    summary:
      "A real map with true coastlines, for geography and history: places are dots at their real latitude and longitude, routes are drawn between places over time, eras are spans on a timeline and events are dated markers on it. The map sits above a timeline panel that keeps the same size from the first Step, so nothing moves when eras and events arrive. The map zooms itself to fit the places you list. Every op targets the whole map object.",
    spec: {
      places:
        'list of up to 12 {"name": "Rome", "lat": 41.9, "lon": 12.5}, every place the Lesson will use, in real degrees (south latitude and west longitude are negative); the map zooms to fit them all; places stay hidden until a places, routes or events op shows them',
      from: "first year of the timeline, a whole number; BC is negative, so 220 BC is -220",
      to: "last year of the timeline, later than from",
      reading: "optional boolean, default true; false draws no names, years or labels, only dots, routes, spans and markers",
    },
    example: [
      '{"step":1,"say":"Hannibal set out from New Carthage in 218 BC and marched over the Alps to Cannae.","scene":{"m":{"lab":"map","from":-220,"to":-200,"places":[{"name":"New Carthage","lat":37.6,"lon":-0.99},{"name":"Alps pass","lat":44.93,"lon":6.73},{"name":"Cannae","lat":41.3,"lon":16.13},{"name":"Rome","lat":41.9,"lon":12.5}]}},"do":[{"cue":"New Carthage","op":"places","on":["m"],"show":["New Carthage","Rome"]},{"cue":"218 BC","op":"eras","on":["m"],"name":"Second Punic War","from":-218,"to":-201},{"cue":"marched","op":"routes","on":["m"],"through":["New Carthage","Alps pass","Cannae"]},{"cue":"Cannae","op":"events","on":["m"],"name":"Cannae","year":-216,"place":"Cannae"}]}',
    ],
  },

  init(spec, objectId) {
    const declared = readPlaces(spec.places, objectId);
    return {
      objectId,
      reading: readReading(spec, objectId),
      places: declared,
      shown: [],
      routes: [],
      eras: [],
      events: [],
      axis: timeAxis(readYear(spec, "from", objectId), readYear(spec, "to", objectId), objectId),
      trail: [],
    };
  },

  ops: {
    places: {
      doc: '{"show": ["Rome", "Carthage"]}; those places from the spec appear as dots on the map, each with its name',
      seconds: 0.8,
      apply: (state, op) => played(withShown(state, placeList(state, op, "show", '["Rome", "Carthage"]'))),
    },
    routes: {
      doc: `{"through": ["New Carthage", "Alps pass", "Cannae"]}; a route is drawn over time from place to place in that order, ending in an arrow; each route gets its own color, up to ${MAX_ROUTES}; its places appear if they were hidden`,
      seconds: routeSeconds,
      apply(state, op) {
        if (state.routes.length >= MAX_ROUTES) fail(`op "routes": ${state.objectId} already has ${MAX_ROUTES} routes, the most that keep their own colors`);
        const through = checkedRoute(laidOut(state), placeList(state, op, "through", '["New Carthage", "Alps pass", "Cannae"]'));
        return played({ ...withShown(state, through), routes: [...state.routes, { through, color: SERIES[state.routes.length]! }] });
      },
      during: (before, after, _op, progress) => [...settle(laidOut(before), laidOut(after), settleShare(progress)), ...growingRoute(laidOut(after), after.routes.length - 1, actShare(progress))],
    },
    eras: {
      doc: '{"name": "Second Punic War", "from": -218, "to": -201}; a named span grows along the timeline from "from" to "to" (BC is negative); eras that overlap in time stack in two rows',
      seconds: 1.0,
      apply(state, op) {
        const name = stringArg(op.args, "name", "eras");
        const from = yearArg(state, op, "from");
        const to = yearArg(state, op, "to");
        if (to <= from) fail(`op "eras": "to" (${to}) must be a later year than "from" (${from})`);
        const next = { ...state, eras: [...state.eras, { name, from, to, color: SERIES[state.eras.length % SERIES.length]! }] };
        eraSlots(next, 0);
        return played(next);
      },
      during(before, after, _op, progress) {
        const { axisY, eras } = timelineLayout(after);
        const slot = eras.find((candidate) => candidate.era === after.eras.length - 1)!;
        const era = after.eras[slot.era]!;
        const grown = actShare(progress);
        const span = eraSpan(after, era, slot.row, axisY, lerp(era.from, era.to, grown));
        return [...settle(laidOut(before), laidOut(after), settleShare(progress)), ...eraDrawables(after, slot, span, clamp01((grown - 1 + ERA_LABEL_FADE) / ERA_LABEL_FADE))];
      },
    },
    events: {
      doc: '{"name": "Cannae", "year": -216, "place": "Cannae"}; a dated marker appears on the timeline with its name and year; optional "place" shows that place and rings it in the accent color on the map',
      seconds: 1.2,
      apply(state, op) {
        const name = stringArg(op.args, "name", "events");
        const year = yearArg(state, op, "year");
        const place = op.args.place === undefined ? null : placeIndex(state, op.args.place, "events");
        const shown = place === null ? state : withShown(state, [place]);
        const next = { ...shown, events: [...state.events, { name, year, place }] };
        eventRows(next);
        return played(next);
      },
      during(before, after, _op, progress) {
        const fresh = `event-${after.events.length - 1}-`;
        const appearing = eventDrawables(after, timelineLayout(after))
          .filter((item) => item.id.startsWith(fresh))
          .map((item) => ({ ...item, opacity: actShare(progress) }));
        return [...settle(laidOut(before), laidOut(after), settleShare(progress)), ...appearing];
      },
    },
  },

  size() {
    return { w: WIDTH, h: HEIGHT };
  },

  draw(state) {
    const laid = laidOut(state);
    return [...mapFrame(), ...landDrawables(laid), ...changingDrawables(laid)];
  },
};
