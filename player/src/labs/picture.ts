import { type Drawable, fail, type LabDef, type LabOp, lerp, type Point, type Rect, type Size } from "../lab";
import { textWidth } from "../text-metrics";

interface Part {
  name: string;
  box: Rect;
}

interface Credit {
  title: string;
  creator: string;
  license: string;
  source: string;
}

interface View {
  x: number;
  y: number;
  s: number;
}

interface PictureState {
  objectId: string;
  src: string;
  natural: Size;
  parts: Part[];
  credit: Credit;
  reading: boolean;
  frame: Size;
  creditText: CreditText;
  shown: boolean;
  view: View;
  pointing: string | null;
  labels: string[];
  history: Mention[];
}

interface CreditText {
  lines: string[];
  size: number;
}

interface Mention {
  kind: "pointer" | "label";
  part: string;
}

interface Placement {
  side: Side;
  reach: number;
}

type Shape = { rect: Rect } | { from: Point; to: Point };

interface Hazard {
  owner: string;
  kind: "outline" | "pointer" | "pill" | "leader";
  gap: number;
  shape: Shape;
}

interface Weighted {
  part: Part;
  weight: number;
}

interface Marks {
  shown: number;
  view: View;
  pointing: Weighted[];
  labels: Weighted[];
  pulse: Weighted | null;
}

type Side = "left" | "right" | "top" | "bottom";

interface Segment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const MAX_W = 1480;
const MAX_H = 780;
const CREDIT_BAND = 44;
const CREDIT_SIZES = [20, 18, 16];
const CREDIT_TOP = 26;
const CREDIT_PITCH = 22;

const FULL_VIEW: View = { x: 0, y: 0, s: 1 };
const ZOOM_MARGIN = 0.22;
const MAX_UPSCALE = 1.5;
const MIN_ZOOM = 0.04;
const LOG_ZOOM_FLOOR = 0.05;

const OUTLINE_LAYERS = [{ id: "line", paint: "accent", width: 5, opacity: 1, z: 3 }] as const;
const PULSE_GROWTH = 8;

const PRESENT_FROM = 0.5;
const PRESENT_TO = 0.9;

const POINTER_LENGTH = 130;
const POINTER_GAP = 16;
const POINTER_MIN = 40;
const EDGE_MARGIN = 12;

const LABEL_SIZE = 32;
const LABEL_PAD = 20;
const LABEL_HEIGHT = 56;
const LABEL_LEADER = 56;

const POINTER_REACHES = [POINTER_LENGTH, 80];
const LABEL_REACHES = [LABEL_LEADER, 2 * LABEL_LEADER];
const OUTLINE_GAP = 12;
const POINTER_CLEARANCE = 16;
const PILL_GAP = 8;
const LEADER_GAP = 14;
const SAMPLE_STEP = 4;
const JUDGED_STEPS = [0.25, 0.5, 0.75];
const JUDGED_PRESENCE = 0.5;

const SECONDS: Record<string, number> = { show: 0.9, point: 0.8, zoom: 1.7, unzoom: 1.4, label: 0.9, clear: 0.5 };
const PULSE_SECONDS = 1.4;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function describeParts(parts: Part[]): string {
  return parts.length === 0 ? "none" : parts.map((part) => part.name).join(", ");
}

function readText(value: unknown, what: string, objectId: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${objectId}: ${what} must be non-empty text`);
  return value;
}

function readSize(spec: Record<string, unknown>, objectId: string): Size {
  const { w, h } = spec;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!valid(w) || !valid(h)) fail(`${objectId}: "w" and "h" must be the image's natural width and height in pixels, such as "w": 1024, "h": 768`);
  return { w, h };
}

function readBox(raw: unknown, where: string, objectId: string): Rect {
  const box = raw as Record<string, unknown> | null;
  const example = '"box": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.2}';
  if (typeof box !== "object" || box === null) fail(`${objectId}: ${where} needs ${example}`);
  const [x, y, w, h] = ["x", "y", "w", "h"].map((key) => box[key]);
  const fractions = [x, y, w, h];
  if (!fractions.every((value) => typeof value === "number" && Number.isFinite(value))) fail(`${objectId}: ${where} box needs numbers x, y, w and h as fractions from 0 to 1, such as ${example}`);
  const [bx, by, bw, bh] = fractions as number[];
  if (bx! < 0 || by! < 0 || bw! <= 0 || bh! <= 0 || bx! + bw! > 1 + 1e-6 || by! + bh! > 1 + 1e-6) fail(`${objectId}: ${where} box must stay inside the picture: x and y at least 0, w and h above 0, x + w and y + h at most 1`);
  return { x: bx!, y: by!, w: bw!, h: bh! };
}

function readParts(raw: unknown, objectId: string): Part[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${objectId}: "parts" must be a list such as [{"name":"beak","box":{"x":0.4,"y":0.3,"w":0.1,"h":0.1}}]`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const where = `parts[${index}]`;
    const name = readText((entry as Record<string, unknown> | null)?.name, `${where} "name"`, objectId).trim();
    if (name.includes("]")) fail(`${objectId}: ${where} name "${name}" must not contain "]", because the writer selects it as ${objectId}[name]`);
    const key = name.toLowerCase();
    if (seen.has(key)) fail(`${objectId}: part name "${name}" appears twice; names must be unique`);
    seen.add(key);
    return { name, box: readBox((entry as Record<string, unknown>).box, `${where} "${name}"`, objectId) };
  });
}

function readCredit(raw: unknown, objectId: string): Credit {
  const credit = raw as Record<string, unknown> | null;
  if (typeof credit !== "object" || credit === null) fail(`${objectId}: "credit" needs {"title","creator","license","source"} exactly as the images result gave it`);
  return {
    title: readText(credit.title, 'credit "title"', objectId),
    creator: readText(credit.creator, 'credit "creator"', objectId),
    license: readText(credit.license, 'credit "license"', objectId),
    source: readText(credit.source, 'credit "source"', objectId),
  };
}

function creditBand(reading: boolean, lines: number): number {
  return reading ? CREDIT_BAND + CREDIT_PITCH * (lines - 1) : 0;
}

function frameFor(natural: Size, band: number): Size {
  const scale = Math.min(MAX_W / natural.w, (MAX_H - band) / natural.h);
  return { w: natural.w * scale, h: natural.h * scale };
}

function ellipsize(text: string, size: number, room: number): string {
  const fits = (candidate: string) => textWidth(candidate, size, "read") <= room;
  if (fits(text)) return text;
  const trimmed = (candidate: string) => `${candidate.replace(/[\s,;:.-]+$/, "")}…`;
  const words = text.split(" ");
  while (words.length > 1) {
    words.pop();
    if (fits(trimmed(words.join(" ")))) return trimmed(words.join(" "));
  }
  const letters = [...text];
  while (letters.length > 1 && !fits(trimmed(letters.join("")))) letters.pop();
  return trimmed(letters.join(""));
}

function creditText(credit: Credit, room: number, allowOneLine: boolean): CreditText {
  const whole = `${credit.title} by ${credit.creator}, ${credit.license}`;
  const single = allowOneLine ? CREDIT_SIZES.find((size) => textWidth(whole, size, "read") <= room) : undefined;
  if (single) return { lines: [whole], size: single };
  const lines = [credit.title, `by ${credit.creator}, ${credit.license}`];
  const size = CREDIT_SIZES.find((candidate) => lines.every((line) => textWidth(line, candidate, "read") <= room)) ?? CREDIT_SIZES[CREDIT_SIZES.length - 1]!;
  return { lines: lines.map((line) => ellipsize(line, size, room)), size };
}

function layoutPicture(natural: Size, credit: Credit, reading: boolean): { frame: Size; creditText: CreditText } {
  const oneLine = frameFor(natural, creditBand(reading, 1));
  const first = creditText(credit, oneLine.w, true);
  if (!reading || first.lines.length === 1) return { frame: oneLine, creditText: first };
  const frame = frameFor(natural, creditBand(reading, 2));
  return { frame, creditText: creditText(credit, frame.w, false) };
}

function findPart(state: PictureState, name: string): Part {
  const wanted = name.trim().toLowerCase();
  const part = state.parts.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!part) fail(`${state.objectId} has no part "${name}"; parts are ${describeParts(state.parts)}`);
  return part;
}

function partOf(state: PictureState, op: LabOp): Part {
  if (op.parts.length !== 1) {
    const example = `${state.objectId}[${state.parts[0]?.name ?? "part"}]`;
    fail(`op "${op.name}" needs exactly one part in "on", such as "on": ["${example}"]; parts of ${state.objectId} are ${describeParts(state.parts)}`);
  }
  return findPart(state, op.parts[0]!);
}

function requireShown(state: PictureState, op: LabOp): void {
  if (!state.shown) fail(`op "${op.name}": ${state.objectId} is not shown yet; use show first`);
}

function viewFor(state: PictureState, box: Rect): View {
  const sharpest = state.frame.w / (state.natural.w * MAX_UPSCALE);
  const wanted = Math.max(box.w, box.h) * (1 + 2 * ZOOM_MARGIN);
  const s = Math.min(1, Math.max(wanted, sharpest, MIN_ZOOM));
  return { s, x: clamp(box.x + box.w / 2 - s / 2, 0, 1 - s), y: clamp(box.y + box.h / 2 - s / 2, 0, 1 - s) };
}

function mixView(from: View, to: View, progress: number): View {
  const s = Math.exp(lerp(Math.log(from.s), Math.log(to.s), progress));
  if (Math.abs(Math.log(to.s / from.s)) < LOG_ZOOM_FLOOR) return { x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress), s };
  const settle = (start: number, end: number) => {
    const fixed = (end * from.s - start * to.s) / (from.s - to.s);
    return fixed + (start - fixed) * (s / from.s);
  };
  return { x: settle(from.x, to.x), y: settle(from.y, to.y), s };
}

function inFrame(state: PictureState, view: View, box: Rect): Rect {
  const { w, h } = state.frame;
  return { x: ((box.x - view.x) / view.s) * w, y: ((box.y - view.y) / view.s) * h, w: (box.w / view.s) * w, h: (box.h / view.s) * h };
}

function visiblePart(state: PictureState, rect: Rect): Rect | null {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(state.frame.w, rect.x + rect.w);
  const bottom = Math.min(state.frame.h, rect.y + rect.h);
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

function presence(rect: Rect, visible: Rect | null): number {
  if (!visible) return 0;
  const shown = clamp(((visible.w * visible.h) / (rect.w * rect.h) - PRESENT_FROM) / (PRESENT_TO - PRESENT_FROM), 0, 1);
  return shown * shown * (3 - 2 * shown);
}

function sidesByRoom(state: PictureState, box: Rect): Side[] {
  const rooms: [Side, number][] = [
    ["left", box.x * state.frame.w],
    ["right", (1 - box.x - box.w) * state.frame.w],
    ["top", box.y * state.frame.h],
    ["bottom", (1 - box.y - box.h) * state.frame.h],
  ];
  return rooms.sort((a, b) => b[1] - a[1]).map(([side]) => side);
}

function outlineSegments(rect: Rect): Segment[] {
  const { x, y, w, h } = rect;
  return [
    { id: "top", x1: x, y1: y, x2: x + w, y2: y },
    { id: "bottom", x1: x, y1: y + h, x2: x + w, y2: y + h },
    { id: "left", x1: x, y1: y, x2: x, y2: y + h },
    { id: "right", x1: x + w, y1: y, x2: x + w, y2: y + h },
  ];
}

function viewport(state: PictureState): Rect {
  return { x: 0, y: 0, w: state.frame.w, h: state.frame.h };
}

function outlineDrawables(prefix: string, state: PictureState, view: View, mark: Weighted, growth: number): Drawable[] {
  const segments = outlineSegments(inFrame(state, view, mark.part.box));
  return OUTLINE_LAYERS.flatMap((layer) =>
    segments.map((segment): Drawable => ({
      id: `${prefix}-${layer.id}-${segment.id}`,
      kind: "line",
      x: segment.x1,
      y: segment.y1,
      x2: segment.x2,
      y2: segment.y2,
      stroke: layer.paint,
      strokeWidth: layer.width + growth * PULSE_GROWTH,
      opacity: layer.opacity * mark.weight,
      clip: viewport(state),
      z: layer.z,
    })),
  );
}

function sample(from: Point, to: Point): Point[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / SAMPLE_STEP));
  return Array.from({ length: steps + 1 }, (_, index) => ({ x: lerp(from.x, to.x, index / steps), y: lerp(from.y, to.y, index / steps) }));
}

function pointToRect(point: Point, rect: Rect): number {
  return Math.hypot(Math.max(rect.x - point.x, 0, point.x - rect.x - rect.w), Math.max(rect.y - point.y, 0, point.y - rect.y - rect.h));
}

function pointToSegment(point: Point, from: Point, to: Point): number {
  const length = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
  const along = length === 0 ? 0 : clamp(((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / length, 0, 1);
  return Math.hypot(point.x - lerp(from.x, to.x, along), point.y - lerp(from.y, to.y, along));
}

function gapBetween(a: Shape, b: Shape): number {
  if ("rect" in a && "rect" in b) {
    return Math.hypot(Math.max(a.rect.x - b.rect.x - b.rect.w, 0, b.rect.x - a.rect.x - a.rect.w), Math.max(a.rect.y - b.rect.y - b.rect.h, 0, b.rect.y - a.rect.y - a.rect.h));
  }
  if ("rect" in a) return gapBetween(b, a);
  if ("rect" in b) return Math.min(...sample(a.from, a.to).map((point) => pointToRect(point, b.rect)));
  return Math.min(
    ...sample(a.from, a.to).map((point) => pointToSegment(point, b.from, b.to)),
    ...sample(b.from, b.to).map((point) => pointToSegment(point, a.from, a.to)),
  );
}

function conflicts(owner: string, candidate: Hazard[], taken: Hazard[]): number {
  let count = 0;
  for (const mine of candidate) {
    for (const other of taken) {
      const ownOutline = other.kind === "outline" && other.owner === owner && (mine.kind === "leader" || mine.kind === "pointer");
      if (!ownOutline && gapBetween(mine.shape, other.shape) < mine.gap + other.gap) count++;
    }
  }
  return count;
}

function clipToRect(from: Point, to: Point, rect: Rect): [Point, Point] | null {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  let [enter, leave] = [0, 1];
  const edges: [number, number][] = [[-dx, from.x - rect.x], [dx, rect.x + rect.w - from.x], [-dy, from.y - rect.y], [dy, rect.y + rect.h - from.y]];
  for (const [direction, room] of edges) {
    if (direction === 0) {
      if (room < 0) return null;
      continue;
    }
    const at = room / direction;
    if (direction < 0) enter = Math.max(enter, at);
    else leave = Math.min(leave, at);
  }
  return enter > leave ? null : [{ x: from.x + dx * enter, y: from.y + dy * enter }, { x: from.x + dx * leave, y: from.y + dy * leave }];
}

function outlineHazards(owner: string, rect: Rect, bounds: Rect): Hazard[] {
  return outlineSegments(rect).flatMap((segment) => {
    const run = clipToRect({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }, bounds);
    return run ? [{ owner, kind: "outline" as const, gap: OUTLINE_GAP, shape: { from: run[0], to: run[1] } }] : [];
  });
}

function unseenSpot(state: PictureState, rect: Rect): Rect {
  return { x: clamp(rect.x + rect.w / 2, 0, state.frame.w), y: clamp(rect.y + rect.h / 2, 0, state.frame.h), w: 0, h: 0 };
}

function pointerGeometry(state: PictureState, box: Rect, placement: Placement): { tail: Point; tip: Point; room: number } {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const { w, h } = state.frame;
  const tip = {
    left: { x: box.x - POINTER_GAP, y: center.y },
    right: { x: box.x + box.w + POINTER_GAP, y: center.y },
    top: { x: center.x, y: box.y - POINTER_GAP },
    bottom: { x: center.x, y: box.y + box.h + POINTER_GAP },
  }[placement.side];
  const room = { left: tip.x, right: w - tip.x, top: tip.y, bottom: h - tip.y }[placement.side] - EDGE_MARGIN;
  const length = clamp(room, 0, placement.reach);
  const tail = {
    left: { x: tip.x - length, y: tip.y },
    right: { x: tip.x + length, y: tip.y },
    top: { x: tip.x, y: tip.y - length },
    bottom: { x: tip.x, y: tip.y + length },
  }[placement.side];
  return { tail, tip, room };
}

function labelGeometry(state: PictureState, box: Rect, name: string, placement: Placement): { anchor: Point; spot: Point; pill: Size } {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const pill = { w: textWidth(name, LABEL_SIZE, "read") + 2 * LABEL_PAD, h: LABEL_HEIGHT };
  const { reach } = placement;
  const anchor = {
    left: { x: box.x, y: center.y },
    right: { x: box.x + box.w, y: center.y },
    top: { x: center.x, y: box.y },
    bottom: { x: center.x, y: box.y + box.h },
  }[placement.side];
  const spot = {
    left: { x: box.x - reach - pill.w / 2, y: center.y },
    right: { x: box.x + box.w + reach + pill.w / 2, y: center.y },
    top: { x: center.x, y: box.y - reach - pill.h / 2 },
    bottom: { x: center.x, y: box.y + box.h + reach + pill.h / 2 },
  }[placement.side];
  return {
    anchor,
    pill,
    spot: {
      x: pill.w + 2 * EDGE_MARGIN > state.frame.w ? state.frame.w / 2 : clamp(spot.x, EDGE_MARGIN + pill.w / 2, state.frame.w - EDGE_MARGIN - pill.w / 2),
      y: clamp(spot.y, EDGE_MARGIN + pill.h / 2, state.frame.h - EDGE_MARGIN - pill.h / 2),
    },
  };
}

function mentionHazards(state: PictureState, mention: Mention, box: Rect, placement: Placement): Hazard[] {
  if (mention.kind === "pointer") {
    const { tail, tip } = pointerGeometry(state, box, placement);
    return [{ owner: mention.part, kind: "pointer", gap: POINTER_CLEARANCE, shape: { from: tail, to: tip } }];
  }
  const { anchor, spot, pill } = labelGeometry(state, box, mention.part, placement);
  return [
    { owner: mention.part, kind: "pill", gap: PILL_GAP, shape: { rect: { x: spot.x - pill.w / 2, y: spot.y - pill.h / 2, w: pill.w, h: pill.h } } },
    { owner: mention.part, kind: "leader", gap: LEADER_GAP, shape: { from: anchor, to: spot } },
  ];
}

const settledPlacements = new WeakMap<Mention[], Map<string, Placement>>();

function placementKey(mention: Mention): string {
  return `${mention.kind}:${mention.part}`;
}

function judgedViews(state: PictureState): View[] {
  const parts = [...new Set(state.history.map((mention) => mention.part))].map((name) => findPart(state, name));
  const stops = [FULL_VIEW, ...parts.map((part) => viewFor(state, part.box))];
  const between = stops.flatMap((from, index) => stops.slice(index + 1).flatMap((to) => JUDGED_STEPS.map((progress) => mixView(from, to, progress))));
  return [...stops, ...between];
}

function placementsFor(state: PictureState): Map<string, Placement> {
  const known = settledPlacements.get(state.history);
  if (known) return known;
  const placements = new Map<string, Placement>();
  const views = judgedViews(state);
  const bounds = viewport(state);
  const taken: Hazard[][] = views.map(() => []);
  for (const mention of state.history) {
    const part = findPart(state, mention.part);
    const seen = views.map((view) => {
      const rect = inFrame(state, view, part.box);
      const visible = visiblePart(state, rect);
      return visible && presence(rect, visible) >= JUDGED_PRESENCE ? { rect, visible } : null;
    });
    const reaches = mention.kind === "pointer" ? POINTER_REACHES : LABEL_REACHES;
    const options = sidesByRoom(state, part.box).flatMap((side) => reaches.map((reach): Placement => ({ side, reach })));
    const scored = options.map((placement) => {
      const perView = seen.map((spot) => (spot ? mentionHazards(state, mention, spot.visible, placement) : []));
      const score = perView.reduce((total, hazards, index) => total + conflicts(mention.part, hazards, taken[index]!), 0);
      return { placement, perView, score };
    });
    const best = scored.find((option) => option.score === 0) ?? scored.reduce((least, option) => (option.score < least.score ? option : least));
    placements.set(placementKey(mention), best.placement);
    seen.forEach((spot, index) => {
      if (spot && mention.kind === "pointer") taken[index]!.push(...outlineHazards(mention.part, spot.rect, bounds));
      taken[index]!.push(...best.perView[index]!);
    });
  }
  settledPlacements.set(state.history, placements);
  return placements;
}

function placementOf(state: PictureState, kind: Mention["kind"], part: Part): Placement {
  return placementsFor(state).get(`${kind}:${part.name}`) ?? { side: sidesByRoom(state, part.box)[0]!, reach: kind === "pointer" ? POINTER_LENGTH : LABEL_LEADER };
}

function pointerDrawables(prefix: string, state: PictureState, view: View, mark: Weighted): Drawable[] {
  const rect = inFrame(state, view, mark.part.box);
  const visible = visiblePart(state, rect);
  const { tail, tip, room } = pointerGeometry(state, visible ?? unseenSpot(state, rect), placementOf(state, "pointer", mark.part));
  const opacity = mark.weight * presence(rect, visible) * clamp((room - POINTER_MIN) / POINTER_MIN, 0, 1);
  const clip = viewport(state);
  const arrow = (id: string, stroke: "ground" | "accent", strokeWidth: number, z: number): Drawable => ({ id: `${prefix}-${id}`, kind: "arrow", x: tail.x, y: tail.y, x2: tip.x, y2: tip.y, stroke, strokeWidth, opacity, clip, z });
  return [arrow("casing", "ground", 13, 4.5), arrow("arrow", "accent", 6, 4.6)];
}

function leaderEnd(anchor: Point, spot: Point, pill: Size): Point {
  const [dx, dy] = [spot.x - anchor.x, spot.y - anchor.y];
  const inside = Math.min(dx === 0 ? Infinity : pill.w / 2 / Math.abs(dx), dy === 0 ? Infinity : pill.h / 2 / Math.abs(dy), 1);
  return { x: spot.x - dx * inside, y: spot.y - dy * inside };
}

function labelDrawables(prefix: string, state: PictureState, view: View, mark: Weighted): Drawable[] {
  const rect = inFrame(state, view, mark.part.box);
  const visible = visiblePart(state, rect);
  const { anchor, spot, pill } = labelGeometry(state, visible ?? unseenSpot(state, rect), mark.part.name, placementOf(state, "label", mark.part));
  const shown = mark.weight * presence(rect, visible);
  const backing = shown * shown;
  const end = leaderEnd(anchor, spot, pill);
  return [
    { id: `${prefix}-line`, kind: "line", x: anchor.x, y: anchor.y, x2: end.x, y2: end.y, stroke: "accent", strokeWidth: 3, opacity: backing, z: 5 },
    { id: `${prefix}-dot`, kind: "circle", x: anchor.x, y: anchor.y, r: 7, fill: "accent", stroke: "ground", strokeWidth: 2.5, opacity: backing, z: 5.1 },
    { id: `${prefix}-pill`, kind: "rect", x: spot.x, y: spot.y, w: pill.w, h: pill.h, fill: "ground", stroke: "accent", strokeWidth: 3, radius: 1, opacity: backing, z: 6 },
    { id: `${prefix}-text`, kind: "text", x: spot.x, y: spot.y, text: mark.part.name, size: LABEL_SIZE, font: "read", fill: "ink", opacity: shown, z: 6.1 },
  ];
}

function compose(state: PictureState, marks: Marks): Drawable[] {
  const { w, h } = state.frame;
  const { view, shown } = marks;
  const out: Drawable[] = [
    { id: "picture", kind: "image", x: w / 2, y: h / 2, w, h, href: state.src, crop: { x: view.x, y: view.y, w: view.s, h: view.s }, opacity: shown, z: 0 },
    { id: "rim", kind: "rect", x: w / 2, y: h / 2, w, h, fill: "none", stroke: "rule", strokeWidth: 2, opacity: shown, z: 2 },
  ];
  if (state.reading) {
    state.creditText.lines.forEach((text, index) => {
      out.push({ id: `credit-${index}`, kind: "text", x: 0, y: h + CREDIT_TOP + index * CREDIT_PITCH, text, size: state.creditText.size, font: "read", anchor: "start", fill: "muted", opacity: shown, z: 1 });
    });
  }
  const outlines = new Map<Part, { weight: number; growth: number }>();
  for (const mark of marks.pointing) outlines.set(mark.part, { weight: mark.weight, growth: 0 });
  if (marks.pulse) outlines.set(marks.pulse.part, { weight: 1, growth: marks.pulse.weight });
  for (const [part, { weight, growth }] of outlines) out.push(...outlineDrawables(`outline-${state.parts.indexOf(part)}`, state, view, { part, weight }, growth));
  for (const mark of marks.pointing) out.push(...pointerDrawables(`point-${state.parts.indexOf(mark.part)}`, state, view, mark));
  for (const mark of marks.labels) out.push(...labelDrawables(`label-${state.parts.indexOf(mark.part)}`, state, view, mark));
  return out;
}

function weigh(state: PictureState, names: string[]): Weighted[] {
  return names.map((name) => ({ part: findPart(state, name), weight: 1 }));
}

function crossfade(before: Weighted[], after: Weighted[], progress: number): Weighted[] {
  const parts = new Map<string, Part>();
  for (const mark of [...before, ...after]) parts.set(mark.part.name, mark.part);
  return [...parts.values()].map((part) => {
    const was = before.some((mark) => mark.part === part) ? 1 : 0;
    const will = after.some((mark) => mark.part === part) ? 1 : 0;
    return { part, weight: lerp(was, will, progress) };
  });
}

function remember(state: PictureState, kind: Mention["kind"], part: Part): Mention[] {
  return state.history.some((mention) => mention.kind === kind && mention.part === part.name) ? state.history : [...state.history, { kind, part: part.name }];
}

const OPS: Record<string, (state: PictureState, op: LabOp) => PictureState> = {
  show: (state) => ({ ...state, shown: true }),
  point(state, op) {
    requireShown(state, op);
    const part = partOf(state, op);
    return { ...state, pointing: part.name, history: remember(state, "pointer", part) };
  },
  zoom(state, op) {
    requireShown(state, op);
    const part = partOf(state, op);
    return { ...state, view: viewFor(state, part.box), pointing: state.pointing === part.name ? state.pointing : null };
  },
  unzoom(state, op) {
    requireShown(state, op);
    return { ...state, view: FULL_VIEW };
  },
  label(state, op) {
    requireShown(state, op);
    const part = partOf(state, op);
    return state.reading && !state.labels.includes(part.name) ? { ...state, labels: [...state.labels, part.name], history: remember(state, "label", part) } : state;
  },
  clear: (state) => ({ ...state, pointing: null, labels: [], history: [] }),
};

export const lab: LabDef<Record<string, unknown>, PictureState> = {
  id: "picture",
  title: "Picture",
  catalog: {
    summary: "A real picture (photo, painting or drawing) that the Lesson shows, points at, zooms into like a camera and labels. Say what you want about named parts; the Lab places the pointer, outline and zoom. The picture starts hidden, so begin with show. For a child who cannot read yet, set reading to false: then nothing on screen needs reading, and label pulses the part's outline instead of writing its name.",
    spec: {
      src: 'the picture\'s address, a "/media/..." URL exactly as the images result gave it',
      w: "the picture's natural width in pixels (only its shape and sharpness matter here)",
      h: "the picture's natural height in pixels",
      parts: 'list of {"name": "beak", "box": {"x": 0.42, "y": 0.3, "w": 0.1, "h": 0.2}}; box is the part\'s rectangle as fractions from 0 to 1 of the picture (x, y is its top left corner); name is what you select it by, so use plain words the narration also uses',
      credit: 'copy {"title","creator","license","source"} from the images result; it is shown small under the picture only when reading is on',
      reading: "true (default) shows the credit and lets label write names; false shows no text at all",
      at: "optional place on the stage; two pictures with at {\"row\": [\"a\", \"b\"]} sit side by side to compare",
    },
    ops: {
      show: "no args; the picture fades in. The first op of every picture.",
      point: '{"on": ["pic[beak]"]}; a pointer arrow and a glowing outline appear on that part, replacing an earlier point',
      zoom: '{"on": ["pic[beak]"]}; the camera glides in until that part fills the frame; a pointer on another part is dropped, the pointer and labels on this part stay on it. Very small parts stop zooming once the picture would turn blurry',
      unzoom: "no args; the camera glides back out to the whole picture",
      label: '{"on": ["pic[beak]"]}; writes the part\'s name on a tag with a line to the part and keeps it. With reading false it pulses the part\'s outline twice instead and keeps nothing',
      clear: "no args; removes the pointer, outline and labels",
    },
    example: [
      '{"step":1,"say":"This is a great grey owl. Look at those big yellow eyes.","scene":{"owl":{"lab":"picture","src":"/media/owl.webp","w":1024,"h":768,"parts":[{"name":"eyes","box":{"x":0.28,"y":0.24,"w":0.5,"h":0.24}},{"name":"beak","box":{"x":0.5,"y":0.4,"w":0.1,"h":0.2}}],"credit":{"title":"Great grey owl close up","creator":"Unknown","license":"CC0","source":"https://www.rawpixel.com/image/6036892"},"reading":false}},"do":[{"cue":"great grey owl","op":"show","on":["owl"]},{"cue":"yellow eyes","op":"point","on":["owl[eyes]"]}]}',
      '{"step":2,"say":"Now let us get close to the beak. It is hooked, so it can tear its food.","do":[{"cue":"get close","op":"zoom","on":["owl[beak]"]},{"cue":"hooked","op":"label","on":["owl[beak]"]}]}',
      '{"step":3,"say":"Now back out to see the whole owl again.","do":[{"cue":"back out","op":"unzoom","on":["owl"]},{"cue":"back out","op":"clear","on":["owl"]}]}',
      '{"step":4,"say":"Compare the two. Both have a beak, but they are not the same shape.","scene":{"a":{"lab":"picture","src":"/media/owl.webp","w":1024,"h":768,"parts":[{"name":"beak","box":{"x":0.5,"y":0.4,"w":0.1,"h":0.2}}],"credit":{"title":"Owl","creator":"Unknown","license":"CC0","source":"https://example.org/owl"},"at":{"row":["a","b"]}},"b":{"lab":"picture","src":"/media/eagle.webp","w":1024,"h":768,"parts":[{"name":"beak","box":{"x":0.3,"y":0.3,"w":0.2,"h":0.2}}],"credit":{"title":"Eagle","creator":"Unknown","license":"CC0","source":"https://example.org/eagle"}}},"do":[{"cue":"Compare","op":"show","on":["a","b"]},{"cue":"beak","op":"zoom","on":["a[beak]","b[beak]"]}]}',
    ],
  },

  init(spec, objectId) {
    const src = readText(spec.src, '"src"', objectId);
    if (!src.startsWith("/media/")) fail(`${objectId}: "src" must be a "/media/..." address exactly as the images result gave it, got "${src}"`);
    if (spec.reading !== undefined && typeof spec.reading !== "boolean") fail(`${objectId}: "reading" must be true or false`);
    const natural = readSize(spec, objectId);
    const reading = spec.reading !== false;
    const credit = readCredit(spec.credit, objectId);
    const { frame, creditText } = layoutPicture(natural, credit, reading);
    return {
      objectId,
      src,
      natural,
      parts: readParts(spec.parts, objectId),
      credit,
      reading,
      frame,
      creditText,
      shown: false,
      view: FULL_VIEW,
      pointing: null,
      labels: [],
      history: [],
    };
  },

  apply(state, op) {
    const handler = OPS[op.name];
    if (!handler) return fail(`picture has no op "${op.name}"; ops: ${Object.keys(OPS).join(", ")}`);
    return handler(state, op);
  },

  size: (state) => ({ w: state.frame.w, h: state.frame.h + creditBand(state.reading, state.creditText.lines.length) }),

  draw: (state) =>
    compose(state, {
      shown: state.shown ? 1 : 0,
      view: state.view,
      pointing: weigh(state, state.pointing === null ? [] : [state.pointing]),
      labels: weigh(state, state.labels),
      pulse: null,
    }),

  duration: (op, state) => (op.name === "label" && !state.reading ? PULSE_SECONDS : SECONDS[op.name] ?? 0.9),

  during(before, after, op, progress) {
    const pulsing = op.name === "label" && !after.reading;
    const placing = after.history.length < before.history.length ? before.history : after.history;
    return compose({ ...after, history: placing }, {
      shown: lerp(before.shown ? 1 : 0, after.shown ? 1 : 0, progress),
      view: mixView(before.view, after.view, progress),
      pointing: crossfade(weigh(before, before.pointing === null ? [] : [before.pointing]), weigh(after, after.pointing === null ? [] : [after.pointing]), progress),
      labels: crossfade(weigh(before, before.labels), weigh(after, after.labels), progress),
      pulse: pulsing ? { part: partOf(after, op), weight: Math.abs(Math.sin(2 * Math.PI * progress)) } : null,
    });
  },
};
