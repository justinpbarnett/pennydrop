import { borderPoint } from "../primitives/edge";
import { nodeDrawables, type NodeLook } from "../primitives/node";
import { type Drawable, fail, type LabDef, type LabOp, labelDrawable, lerp, type Paint, type Point, type Role, segmentDrawable, type Size } from "../lab";
import { layoutGraph, type LayoutKind, type Side } from "../graph-layout";
import { textWidth } from "../text-metrics";

type FrontierKind = "queue" | "stack" | "heap";
type Visit = "current" | "visited";
type EdgeMood = "idle" | "relaxed" | "path";

interface GraphNode {
  id: string;
  label: string;
}

interface GraphEdge {
  from: string;
  to: string;
  weight: number | null;
  side: Side | null;
}

interface Entry {
  seq: number;
  node: string;
  key: number | null;
}

interface GraphState {
  objectId: string;
  layout: LayoutKind;
  directed: boolean;
  frontierKind: FrontierKind | null;
  showDistances: boolean;
  radius: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  root: string | null;
  visits: Record<string, Visit>;
  distances: Record<string, number | null>;
  frontier: Entry[];
  nextSeq: number;
  relaxed: Record<string, string>;
  path: string[];
}

interface GraphSpec {
  nodes?: unknown;
  edges?: unknown;
  directed?: unknown;
  layout?: unknown;
  root?: unknown;
  frontier?: unknown;
  distances?: unknown;
}

interface Strip {
  top: number;
  captionX: number;
  trackLeft: number;
  trackWidth: number;
}

interface Geometry {
  positions: Map<string, Point>;
  strip: Strip | null;
  size: Size;
}

const SPEC_KEYS = ["lab", "nodes", "edges", "directed", "layout", "root", "frontier", "distances"];
const LAYOUTS: LayoutKind[] = ["tree", "layers", "ring"];
const FRONTIERS: FrontierKind[] = ["queue", "stack", "heap"];
const SIDES: Side[] = ["left", "right"];
const OUT_END_TAG: Record<FrontierKind, string> = { queue: "front", stack: "top", heap: "min" };

const TREE_RADIUS = 42;
const CURRENT_SCALE = 1.12;
const SIDE_MARGIN = 64;
const VERTICAL_MARGIN = 62;
const DISTANCE_GAP = 22;
const DISTANCE_DIRECTIONS = [90, 270, 45, 135, 315, 225, 0, 180, 67.5, 112.5, 247.5, 292.5, 22.5, 157.5, 337.5, 202.5];
const DISTANCE_REACHES = [0, 10, 20];
const DISTANCE_MARGIN = 7;
const SAMPLE_STEP = 4;
const DISTANCE_SIZE = 26;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 200;

const EDGE_Z = 0;
const CHIP_Z = 1;
const NODE_Z = 3;
const DISTANCE_Z = 6;
const STRIP_Z = 1;

const CHIP_HEIGHT = 32;
const CHIP_PADDING = 20;
const CHIP_SIZE = 24;
const CHIP_SPOTS = [0.5, 0.36, 0.64, 0.26, 0.74, 0.18, 0.82];

const SLOT_WIDTH = 76;
const SLOT_HEIGHT = 68;
const SLOT_GAP = 10;
const TRACK_PADDING = 12;
const MIN_TRACK_SLOTS = 8;
const STRIP_GAP = 34;
const TAG_ROOM = 30;
const CAPTION_SIZE = 24;
const CAPTION_GAP = 22;

const EDGE_LOOKS: Record<EdgeMood, { role: Role; width: number; weightFill: Paint }> = {
  idle: { role: "edge", width: 2.4, weightFill: "muted" },
  relaxed: { role: "compare", width: 4.2, weightFill: "compare" },
  path: { role: "ok", width: 6.5, weightFill: "ok" },
};

const DURATIONS: Record<string, number> = { visit: 0.6, push: 0.55, pop: 0.55, relax: 0.9, dist: 0.5, path: 1.0, insert: 1.0, remove: 0.8, rotate: 1.3, swap: 1.1 };

function idText(value: unknown, what: string, objectId: string): string {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fail(`${objectId}: ${what} must be a node id as text or a number`);
}

function opposite(side: Side): Side {
  return side === "left" ? "right" : "left";
}

function keyOf(state: Pick<GraphState, "layout">, edge: GraphEdge): string {
  return state.layout === "tree" ? edge.to : `${edge.from}>${edge.to}`;
}

function nodeList(state: GraphState): string {
  return state.nodes.map((node) => node.id).join(", ") || "none";
}

function requireNode(state: GraphState, id: string, opName: string): string {
  if (!state.nodes.some((node) => node.id === id)) fail(`op "${opName}" on ${state.objectId}: no node "${id}"; nodes: ${nodeList(state)}`);
  return id;
}

function nodeArg(state: GraphState, args: Record<string, unknown>, key: string, opName: string): string {
  const value = args[key];
  if (typeof value !== "string" && typeof value !== "number") fail(`op "${opName}" needs "${key}" as a node id, one of: ${nodeList(state)}`);
  return requireNode(state, String(value), opName);
}

function requireTree(state: GraphState, opName: string): void {
  if (state.layout !== "tree") fail(`op "${opName}" works on a tree; ${state.objectId} uses layout "${state.layout}"; set "layout": "tree" in the spec`);
}

function requireFrontier(state: GraphState, opName: string): FrontierKind {
  if (!state.frontierKind) fail(`op "${opName}" needs a frontier; add "frontier": "queue", "stack" or "heap" to the spec of ${state.objectId}`);
  return state.frontierKind;
}

function findEdge(state: GraphState, a: string, b: string): { edge: GraphEdge; key: string } {
  const edge = state.edges.find((candidate) => (candidate.from === a && candidate.to === b) || (!state.directed && candidate.from === b && candidate.to === a));
  if (edge) return { edge, key: keyOf(state, edge) };
  const known = state.edges.map((candidate) => `${candidate.from}-${candidate.to}`).join(", ") || "none";
  return fail(`${state.objectId} has no edge ${a}${state.directed ? "->" : "-"}${b}; edges: ${known}`);
}

function withSides(edges: GraphEdge[], objectId: string): GraphEdge[] {
  const children = new Map<string, GraphEdge[]>();
  edges.forEach((edge) => children.set(edge.from, [...(children.get(edge.from) ?? []), edge]));
  const sideOf = new Map<GraphEdge, Side | null>();
  for (const [parent, group] of children) {
    if (group.length > 2) {
      if (group.some((edge) => edge.side)) fail(`${objectId}: "${parent}" has ${group.length} children, so none can use "left" or "right"`);
      group.forEach((edge) => sideOf.set(edge, null));
      continue;
    }
    const taken = group.flatMap((edge) => (edge.side ? [edge.side] : []));
    if (new Set(taken).size < taken.length) fail(`${objectId}: "${parent}" has two ${taken[0]} children`);
    const free = SIDES.filter((side) => !taken.includes(side));
    group.forEach((edge) => sideOf.set(edge, edge.side ?? free.shift()!));
  }
  return edges.map((edge) => ({ ...edge, side: sideOf.get(edge)! }));
}

function readNodes(value: unknown, layout: LayoutKind, objectId: string): GraphNode[] {
  const example = '["A","B"] or [{"id":"A","label":"Start"}]';
  if (!Array.isArray(value)) return fail(`${objectId}: "nodes" must be a list of node ids such as ${example}`);
  if (value.length === 0 && layout !== "tree") fail(`${objectId}: "nodes" needs at least one node, such as ${example}`);
  const nodes = value.map((entry, index): GraphNode => {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const { id, label } = entry as Record<string, unknown>;
      const nodeId = idText(id, `nodes[${index}].id`, objectId);
      return { id: nodeId, label: label === undefined ? nodeId : idText(label, `nodes[${index}].label`, objectId) };
    }
    const nodeId = idText(entry, `nodes[${index}]`, objectId);
    return { id: nodeId, label: nodeId };
  });
  const duplicate = nodes.find((node, index) => nodes.findIndex((other) => other.id === node.id) !== index);
  if (duplicate) fail(`${objectId}: node id "${duplicate.id}" appears twice; give each node its own id and use {"id","label"} for equal labels`);
  return nodes;
}

function readEdges(value: unknown, nodes: GraphNode[], layout: LayoutKind, directed: boolean, objectId: string): GraphEdge[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${objectId}: "edges" must be a list such as [["A","B",4]] with from, to and an optional weight`);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = value.map((entry, index): GraphEdge => {
    if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3) return fail(`${objectId}: edges[${index}] must be [from, to] or [from, to, weight]`);
    const [from, to, third] = entry.map((item, position) => (position < 2 ? idText(item, `edges[${index}][${position}]`, objectId) : item));
    for (const end of [from, to] as string[]) if (!ids.has(end)) fail(`${objectId}: edges[${index}] names "${end}", which is not a node; nodes: ${[...ids].join(", ")}`);
    if (from === to) fail(`${objectId}: edges[${index}] joins "${from}" to itself; self loops are not drawn`);
    if (third === undefined) return { from: from as string, to: to as string, weight: null, side: null };
    if (typeof third === "number" && Number.isFinite(third)) return { from: from as string, to: to as string, weight: third, side: null };
    if (layout === "tree" && (third === "left" || third === "right")) return { from: from as string, to: to as string, weight: null, side: third };
    return fail(`${objectId}: edges[${index}] third item must be a number weight${layout === "tree" ? ', or "left" or "right"' : ""}`);
  });
  edges.forEach((edge, index) => {
    const twin = edges.findIndex((other) => (other.from === edge.from && other.to === edge.to) || (!directed && other.from === edge.to && other.to === edge.from));
    if (twin !== index) fail(`${objectId}: edges[${index}] repeats edges[${twin}]`);
  });
  return edges;
}

function checkTree(nodes: GraphNode[], edges: GraphEdge[], root: string | null, objectId: string): void {
  const parents = new Map<string, string>();
  for (const edge of edges) {
    if (parents.has(edge.to)) fail(`${objectId}: node "${edge.to}" has two parents, "${parents.get(edge.to)}" and "${edge.from}"; a tree node has one parent, so use "layout": "layers" for a general graph`);
    parents.set(edge.to, edge.from);
  }
  if (root && parents.has(root)) fail(`${objectId}: root "${root}" has a parent "${parents.get(root)}"; the root of a tree has no incoming edge`);
  const reached = new Set<string>();
  const visit = (id: string) => {
    reached.add(id);
    edges.filter((edge) => edge.from === id).forEach((edge) => visit(edge.to));
  };
  nodes.filter((node) => !parents.has(node.id)).forEach((node) => visit(node.id));
  const stranded = nodes.find((node) => !reached.has(node.id));
  if (stranded) fail(`${objectId}: node "${stranded.id}" sits on a cycle; a tree has no cycles, so use "layout": "layers" for a general graph`);
}

function radiusFor(layout: LayoutKind, count: number): number {
  if (layout === "tree") return TREE_RADIUS;
  return count <= 8 ? 46 : count <= 12 ? 40 : 34;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string, objectId: string, fallback: T | null): T | null {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  return fail(`${objectId}: "${what}" must be one of ${allowed.map((option) => `"${option}"`).join(", ")}`);
}

function displayedFrontier(state: GraphState): Entry[] {
  if (state.frontierKind !== "heap") return state.frontier;
  return [...state.frontier].sort((a, b) => a.key! - b.key! || a.seq - b.seq);
}

function outEnd(state: GraphState): Entry | undefined {
  const shown = displayedFrontier(state);
  return state.frontierKind === "stack" ? shown.at(-1) : shown[0];
}

function visitNode(state: GraphState, node: string): GraphState {
  const visits: Record<string, Visit> = Object.fromEntries(Object.keys(state.visits).map((id) => [id, "visited"]));
  visits[node] = "current";
  return { ...state, visits };
}

function treeEdgesAfter(state: GraphState, edges: GraphEdge[], root: string | null): GraphState {
  return { ...state, edges: withSides(edges, state.objectId), root };
}

type OpHandler = (state: GraphState, args: Record<string, unknown>, opName: string) => GraphState;

const HANDLERS: Record<string, OpHandler> = {
  visit: (state, args, opName) => visitNode(state, nodeArg(state, args, "node", opName)),

  push(state, args, opName) {
    const kind = requireFrontier(state, opName);
    const node = nodeArg(state, args, "node", opName);
    const key = args.key;
    if (key !== undefined && (typeof key !== "number" || !Number.isFinite(key))) fail(`op "push" arg "key" must be a number`);
    if (kind === "heap" && key === undefined) fail(`op "push" on a heap frontier needs "key", the priority the heap orders by`);
    return { ...state, frontier: [...state.frontier, { seq: state.nextSeq, node, key: key ?? null }], nextSeq: state.nextSeq + 1 };
  },

  pop(state, args, opName) {
    const kind = requireFrontier(state, opName);
    const next = outEnd(state);
    if (!next) return fail(`op "pop": the ${kind} is empty; push a node first`);
    if (args.node !== undefined && String(args.node) !== next.node) {
      fail(`op "pop" named "${args.node}", but a ${kind} gives up "${next.node}" first (${OUT_END_TAG[kind]}); name "${next.node}" or leave "node" out`);
    }
    return visitNode({ ...state, frontier: state.frontier.filter((entry) => entry !== next) }, next.node);
  },

  relax(state, args, opName) {
    const from = nodeArg(state, args, "from", opName);
    const to = nodeArg(state, args, "to", opName);
    const { key } = findEdge(state, from, to);
    const dist = args.dist;
    if (typeof dist !== "number" || !Number.isFinite(dist)) fail(`op "relax" needs "dist" as the new distance number for "${to}"`);
    const relaxed = Object.fromEntries(Object.entries(state.relaxed).filter(([, target]) => target !== to));
    return { ...state, showDistances: true, distances: { ...state.distances, [to]: dist }, relaxed: { ...relaxed, [key]: to } };
  },

  dist(state, args, opName) {
    const node = nodeArg(state, args, "node", opName);
    const value = args.value;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) fail(`op "dist" needs "value" as a number, or null for infinity`);
    return { ...state, showDistances: true, distances: { ...state.distances, [node]: value } };
  },

  path(state, args) {
    const nodes = args.nodes;
    if (!Array.isArray(nodes) || nodes.some((node) => typeof node !== "string" && typeof node !== "number")) fail(`op "path" needs "nodes" as a list of node ids, or [] to clear the path`);
    const ids = nodes.map((node) => requireNode(state, String(node), "path"));
    return { ...state, path: ids.slice(1).map((id, index) => findEdge(state, ids[index]!, id).key) };
  },

  insert(state, args, opName) {
    requireTree(state, opName);
    const node = args.node === undefined ? fail(`op "insert" needs "node", the new node id`) : String(args.node);
    if (state.nodes.some((existing) => existing.id === node)) fail(`op "insert": node "${node}" already exists; nodes: ${nodeList(state)}`);
    const label = args.label === undefined ? node : idText(args.label, 'op "insert" arg "label"', state.objectId);
    const grown: GraphState = { ...state, nodes: [...state.nodes, { id: node, label }] };
    if (args.parent === undefined) {
      if (state.root) fail(`op "insert" needs "parent"; the tree already has root "${state.root}"`);
      return { ...grown, root: node };
    }
    const parent = nodeArg(state, args, "parent", opName);
    const side = oneOf(args.side, SIDES, "side", state.objectId, null);
    const occupant = side && state.edges.find((edge) => edge.from === parent && edge.side === side);
    if (occupant) fail(`op "insert": ${side} child of "${parent}" is already "${occupant.to}"; pick the other side or insert under "${occupant.to}"`);
    return treeEdgesAfter(grown, [...state.edges, { from: parent, to: node, weight: null, side }], state.root);
  },

  remove(state, args, opName) {
    requireTree(state, opName);
    const node = nodeArg(state, args, "node", opName);
    const below = state.edges.filter((edge) => edge.from === node);
    if (below.length > 1) fail(`op "remove": "${node}" has two children; swap it with a leaf first, then remove the leaf`);
    const above = state.edges.find((edge) => edge.to === node);
    const survivors = state.edges.filter((edge) => edge.from !== node && edge.to !== node);
    const adopted = below[0] && above ? [{ ...above, to: below[0].to }] : [];
    const root = state.root === node ? below[0]?.to ?? null : state.root;
    const gone = (id: string) => id === node;
    const keep = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => !gone(id)));
    return {
      ...treeEdgesAfter({ ...state, nodes: state.nodes.filter((existing) => !gone(existing.id)) }, [...survivors, ...adopted], root),
      visits: keep(state.visits),
      distances: keep(state.distances),
      frontier: state.frontier.filter((entry) => !gone(entry.node)),
      relaxed: {},
      path: [],
    };
  },

  rotate(state, args, opName) {
    requireTree(state, opName);
    const x = nodeArg(state, args, "node", opName);
    const direction = oneOf(args.direction, SIDES, "direction", state.objectId, null);
    if (!direction) fail(`op "rotate" needs "direction": "left" or "right"`);
    const liftedSide = opposite(direction);
    const liftedEdge = state.edges.find((edge) => edge.from === x && edge.side === liftedSide);
    if (!liftedEdge) fail(`op "rotate" ${direction} at "${x}" lifts its ${liftedSide} child, but "${x}" has none; rotate "${x}" ${liftedSide} instead or pick another node`);
    const lifted = liftedEdge.to;
    const inner = state.edges.find((edge) => edge.from === lifted && edge.side === direction);
    const above = state.edges.find((edge) => edge.to === x);
    const untouched = state.edges.filter((edge) => edge !== liftedEdge && edge !== inner && edge !== above);
    const rebuilt: GraphEdge[] = [
      { from: lifted, to: x, weight: null, side: direction },
      ...(inner ? [{ from: x, to: inner.to, weight: null, side: liftedSide }] : []),
      ...(above ? [{ ...above, to: lifted }] : []),
    ];
    return treeEdgesAfter(state, [...untouched, ...rebuilt], state.root === x ? lifted : state.root);
  },

  swap(state, args, opName) {
    requireTree(state, opName);
    const a = nodeArg(state, args, "a", opName);
    const b = nodeArg(state, args, "b", opName);
    if (a === b) fail(`op "swap" needs two different nodes, got "${a}" twice`);
    const exchange = (id: string) => (id === a ? b : id === b ? a : id);
    return { ...state, edges: state.edges.map((edge) => ({ ...edge, from: exchange(edge.from), to: exchange(edge.to) })), root: state.root && exchange(state.root) };
  },
};

const geometries = new WeakMap<GraphState, Geometry>();

function geometryOf(state: GraphState): Geometry {
  const cached = geometries.get(state);
  if (cached) return cached;
  const layout = layoutGraph({ kind: state.layout, ids: state.nodes.map((node) => node.id), edges: state.edges, directed: state.directed, root: state.root, radius: state.radius });
  const reach = state.radius * CURRENT_SCALE;
  const marginX = reach + SIDE_MARGIN;
  const graphWidth = layout.w + 2 * marginX;
  const graphHeight = layout.h + 2 * (reach + VERTICAL_MARGIN);

  let strip: Strip | null = null;
  let width = Math.max(graphWidth, MIN_WIDTH);
  let height = Math.max(graphHeight, MIN_HEIGHT);
  if (state.frontierKind) {
    const captionWidth = textWidth(state.frontierKind, CAPTION_SIZE, "read");
    const slots = Math.max(MIN_TRACK_SLOTS, state.frontier.length);
    const trackWidth = 2 * TRACK_PADDING + slots * (SLOT_WIDTH + SLOT_GAP) - SLOT_GAP;
    const stripWidth = captionWidth + CAPTION_GAP + trackWidth;
    width = Math.max(width, stripWidth + 2 * SIDE_MARGIN);
    const captionX = (width - stripWidth) / 2;
    strip = { top: height + STRIP_GAP + TAG_ROOM, captionX, trackLeft: captionX + captionWidth + CAPTION_GAP, trackWidth };
    height = strip.top + SLOT_HEIGHT + 2 * TRACK_PADDING;
  }
  const positions = new Map([...layout.positions].map(([id, point]): [string, Point] => [id, { x: (width - layout.w) / 2 + point.x, y: reach + VERTICAL_MARGIN + point.y }]));
  const geometry = { positions, strip, size: { w: width, h: height } };
  geometries.set(state, geometry);
  return geometry;
}

function nodeRadius(state: GraphState, id: string): number {
  return state.radius * (state.visits[id] === "current" ? CURRENT_SCALE : 1);
}

function nodeLook(state: GraphState, id: string): NodeLook {
  if (state.visits[id] === "current") return { stroke: "active", fill: "active", strokeWidth: 3, labelFill: "ground" };
  if (state.visits[id] === "visited") return { stroke: "done", fill: "fill", strokeWidth: 2.6, labelFill: "done" };
  if (state.frontier.some((entry) => entry.node === id)) return { stroke: "compare", fill: "fill2", strokeWidth: 3, labelFill: "ink" };
  return { stroke: "edge", fill: "fill", strokeWidth: 1.8, labelFill: "ink" };
}

function distanceText(value: number | null): string {
  return value === null ? "∞" : String(value);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function gapToBox(point: Point, box: Box): number {
  return Math.hypot(Math.max(0, Math.abs(point.x - box.x) - box.w / 2), Math.max(0, Math.abs(point.y - box.y) - box.h / 2));
}

function segmentGapToBox(from: Point, to: Point, box: Box): number {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / SAMPLE_STEP));
  let nearest = Infinity;
  for (let step = 0; step <= steps; step++) nearest = Math.min(nearest, gapToBox({ x: lerp(from.x, to.x, step / steps), y: lerp(from.y, to.y, step / steps) }, box));
  return nearest;
}

function boxGap(a: Box, b: Box): number {
  return Math.hypot(Math.max(0, Math.abs(a.x - b.x) - (a.w + b.w) / 2), Math.max(0, Math.abs(a.y - b.y) - (a.h + b.h) / 2));
}

function edgeSegments(state: GraphState, positions: Map<string, Point>): { key: string; from: Point; to: Point }[] {
  return state.edges.map((edge) => {
    const [from, to] = edgeEnds(state, positions, edge.from, edge.to);
    return { key: keyOf(state, edge), from, to };
  });
}

function chipBoxes(state: GraphState, spots: Map<string, Point>): Box[] {
  return state.edges.flatMap((edge) => {
    const spot = spots.get(keyOf(state, edge));
    return edge.weight === null || !spot ? [] : [{ x: spot.x, y: spot.y, w: textWidth(String(edge.weight), CHIP_SIZE, "read") + CHIP_PADDING, h: CHIP_HEIGHT }];
  });
}

function distanceSlots(state: GraphState, positions: Map<string, Point>, spots: Map<string, Point>): Map<string, Point> {
  const segments = edgeSegments(state, positions);
  const obstacles: Box[] = chipBoxes(state, spots);
  const slots = new Map<string, Point>();
  for (const node of state.nodes) {
    const center = positions.get(node.id)!;
    const text = distanceText(state.distances[node.id] ?? null);
    const w = textWidth(text, DISTANCE_SIZE, "read");
    const h = DISTANCE_SIZE * 1.2;
    const candidates = DISTANCE_REACHES.flatMap((extra) =>
      DISTANCE_DIRECTIONS.map((degrees) => {
        const direction = (degrees * Math.PI) / 180;
        const run = nodeRadius(state, node.id) + DISTANCE_GAP + extra;
        return { x: center.x + Math.cos(direction) * (run + Math.abs(Math.cos(direction)) * (w / 2)), y: center.y + Math.sin(direction) * run, w, h };
      }),
    );
    const trouble = (box: Box) =>
      state.nodes.filter((other) => gapToBox(positions.get(other.id)!, box) < nodeRadius(state, other.id) + DISTANCE_MARGIN).length +
      segments.filter((segment) => segmentGapToBox(segment.from, segment.to, box) < DISTANCE_MARGIN).length +
      obstacles.filter((other) => boxGap(box, other) < DISTANCE_MARGIN).length;
    const best = candidates.reduce((chosen, candidate) => (trouble(candidate) < trouble(chosen) ? candidate : chosen));
    obstacles.push(best);
    slots.set(node.id, { x: best.x, y: best.y });
  }
  return slots;
}

function distanceLabel(state: GraphState, node: GraphNode, slot: Point): Drawable {
  const value = state.distances[node.id] ?? null;
  return { ...labelDrawable(distanceText(value), slot, DISTANCE_SIZE, "read", value === null ? "muted" : "ink", DISTANCE_Z), id: `dist-${node.id}` };
}

function nodeParts(state: GraphState, node: GraphNode, positions: Map<string, Point>, slot: Point | undefined): Drawable[] {
  const radius = nodeRadius(state, node.id);
  const body = nodeDrawables(node.label, positions.get(node.id)!, radius, nodeLook(state, node.id)).map((part) => ({ ...part, id: `${part.id}-${node.id}`, z: NODE_Z + (part.z ?? 0), part: `${state.objectId}[${node.id}]` }));
  return slot ? [...body, distanceLabel(state, node, slot)] : body;
}

function moodOf(state: GraphState, key: string): EdgeMood {
  if (state.path.includes(key)) return "path";
  return key in state.relaxed ? "relaxed" : "idle";
}

function edgeEnds(state: GraphState, positions: Map<string, Point>, from: string, to: string): [Point, Point] {
  const link = (id: string) => {
    const center = positions.get(id)!;
    const radius = nodeRadius(state, id);
    return { x: center.x - radius, y: center.y - radius, w: 2 * radius, h: 2 * radius, round: true };
  };
  return [borderPoint(link(from), positions.get(to)!), borderPoint(link(to), positions.get(from)!)];
}

function weightSpots(state: GraphState, positions: Map<string, Point>): Map<string, Point> {
  const placed: { center: Point; w: number }[] = [];
  const spots = new Map<string, Point>();
  const overlapsNode = (center: Point, w: number) => state.nodes.some((node) => {
    const at = positions.get(node.id)!;
    const reachX = Math.max(0, Math.abs(at.x - center.x) - w / 2);
    const reachY = Math.max(0, Math.abs(at.y - center.y) - CHIP_HEIGHT / 2);
    return Math.hypot(reachX, reachY) < nodeRadius(state, node.id) + 8;
  });
  const segments = edgeSegments(state, positions);
  for (const edge of state.edges) {
    if (edge.weight === null) continue;
    const key = keyOf(state, edge);
    const w = textWidth(String(edge.weight), CHIP_SIZE, "read") + CHIP_PADDING;
    const from = positions.get(edge.from)!;
    const to = positions.get(edge.to)!;
    const candidates = CHIP_SPOTS.map((spot) => ({ x: lerp(from.x, to.x, spot), y: lerp(from.y, to.y, spot) }));
    const clear = candidates.find((center) => !overlapsNode(center, w) && segments.every((segment) => segment.key === key || segmentGapToBox(segment.from, segment.to, { x: center.x, y: center.y, w, h: CHIP_HEIGHT }) > 4) && placed.every((other) => Math.abs(other.center.x - center.x) > (other.w + w) / 2 + 4 || Math.abs(other.center.y - center.y) > CHIP_HEIGHT + 4));
    const center = clear ?? candidates[0]!;
    placed.push({ center, w });
    spots.set(keyOf(state, edge), center);
  }
  return spots;
}

function edgeParts(state: GraphState, edge: GraphEdge, positions: Map<string, Point>, spot: Point | undefined, mood: EdgeMood): Drawable[] {
  const look = EDGE_LOOKS[mood];
  const key = keyOf(state, edge);
  const [start, end] = edgeEnds(state, positions, edge.from, edge.to);
  const parts: Drawable[] = [{ ...segmentDrawable(state.directed ? "arrow" : "line", start, end, look.role, look.width, EDGE_Z + (mood === "idle" ? 0 : 0.5)), id: `edge-${key}` }];
  if (edge.weight !== null && spot) {
    const text = String(edge.weight);
    const w = textWidth(text, CHIP_SIZE, "read") + CHIP_PADDING;
    parts.push(
      { id: `chip-${key}`, kind: "rect", x: spot.x, y: spot.y, w, h: CHIP_HEIGHT, fill: "ground", stroke: "none", radius: 1, z: CHIP_Z },
      { ...labelDrawable(text, spot, CHIP_SIZE, "read", look.weightFill, CHIP_Z + 0.1), id: `weight-${key}` },
    );
  }
  return parts;
}

function stripParts(state: GraphState, strip: Strip): Drawable[] {
  const kind = state.frontierKind!;
  const shown = displayedFrontier(state);
  const centerY = strip.top + TRACK_PADDING + SLOT_HEIGHT / 2;
  const slotX = (index: number) => strip.trackLeft + TRACK_PADDING + index * (SLOT_WIDTH + SLOT_GAP) + SLOT_WIDTH / 2;
  const parts: Drawable[] = [
    { id: "strip-caption", kind: "text", x: strip.captionX, y: centerY, text: kind, size: CAPTION_SIZE, font: "read", anchor: "start", fill: "muted", z: STRIP_Z },
    { id: "strip-track", kind: "rect", x: strip.trackLeft + strip.trackWidth / 2, y: centerY, w: strip.trackWidth, h: SLOT_HEIGHT + 2 * TRACK_PADDING, fill: "none", stroke: "rule", strokeWidth: 1.6, radius: 1, z: STRIP_Z },
  ];
  shown.forEach((entry, index) => {
    const label = state.nodes.find((node) => node.id === entry.node)!.label;
    const keyed = entry.key !== null;
    parts.push({ id: `entry-${entry.seq}`, kind: "rect", x: slotX(index), y: centerY, w: SLOT_WIDTH, h: SLOT_HEIGHT, fill: "fill2", stroke: "compare", strokeWidth: 2, radius: 1, z: STRIP_Z + 1 });
    parts.push({ ...labelDrawable(label, { x: slotX(index), y: centerY + (keyed ? -11 : 0) }, 28, "mark", "ink", STRIP_Z + 2), id: `entry-${entry.seq}-label` });
    if (keyed) parts.push({ ...labelDrawable(String(entry.key), { x: slotX(index), y: centerY + 19 }, 20, "read", "muted", STRIP_Z + 2), id: `entry-${entry.seq}-key` });
  });
  const front = outEnd(state);
  if (front) {
    const index = shown.indexOf(front);
    parts.push({ id: "strip-tag", kind: "text", x: slotX(index), y: strip.top - TAG_ROOM / 2, text: OUT_END_TAG[kind], size: 20, font: "read", fill: "muted", z: STRIP_Z });
  }
  return parts;
}

function drawAt(state: GraphState, positions: Map<string, Point>, appearing?: { node: string; opacity: number }): Drawable[] {
  const fade = (drawables: Drawable[], node: string) => (appearing?.node === node ? drawables.map((drawable) => ({ ...drawable, opacity: appearing.opacity })) : drawables);
  const spots = weightSpots(state, positions);
  const edges = state.edges.flatMap((edge) => fade(edgeParts(state, edge, positions, spots.get(keyOf(state, edge)), moodOf(state, keyOf(state, edge))), edge.to));
  const slots = state.showDistances ? distanceSlots(state, positions, spots) : new Map<string, Point>();
  const nodes = state.nodes.flatMap((node) => fade(nodeParts(state, node, positions, slots.get(node.id)), node.id));
  const geometry = geometryOf(state);
  return [...edges, ...nodes, ...(geometry.strip ? stripParts(state, geometry.strip) : [])];
}

function perpendicularArc(from: Point, to: Point, reach: number, progress: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const bow = Math.sin(Math.PI * progress) * reach;
  return { x: (-(to.y - from.y) / length) * bow, y: ((to.x - from.x) / length) * bow };
}

function travelingPositions(before: GraphState, after: GraphState, op: LabOp, progress: number): Map<string, Point> {
  const from = geometryOf(before).positions;
  const to = geometryOf(after).positions;
  const swapped = op.name === "swap" ? [String(op.args.a), String(op.args.b)] : [];
  return new Map([...to].map(([id, target]): [string, Point] => {
    const parentId = after.edges.find((edge) => edge.to === id)?.from;
    const origin = from.get(id) ?? (parentId ? to.get(parentId) : undefined) ?? target;
    const arc = swapped.includes(id) ? perpendicularArc(origin, target, after.radius * 1.15 * (id === swapped[0] ? 1 : -1), progress) : { x: 0, y: 0 };
    return [id, { x: lerp(origin.x, target.x, progress) + arc.x, y: lerp(origin.y, target.y, progress) + arc.y }];
  }));
}

function relaxOverlay(after: GraphState, op: LabOp, progress: number): Drawable[] {
  const from = String(op.args.from);
  const to = String(op.args.to);
  const { edge, key } = findEdge(after, from, to);
  const positions = geometryOf(after).positions;
  const [start, end] = edgeEnds(after, positions, from, to);
  const spots = weightSpots(after, positions);
  const quiet = edgeParts(after, edge, positions, spots.get(key), "idle");
  const look = EDGE_LOOKS.relaxed;
  const sweep = { ...segmentDrawable("line", start, end, look.role, look.width, EDGE_Z + 0.6), id: `edge-${key}-sweep`, draw: progress };
  return [...quiet, sweep];
}

export const lab: LabDef<GraphSpec, GraphState> = {
  id: "graph",
  title: "Graph and tree",
  catalog: {
    summary: "Nodes and edges laid out by the Lab, with a frontier strip (queue, stack or heap), distance labels, and tree edits. For BFS, DFS, Dijkstra, BST, heaps and tries. Name nodes in args; no parts.",
    spec: {
      nodes: 'list of node ids as text or numbers, or {"id","label"}; [] is fine for a tree that grows by insert',
      edges: 'optional [from, to] or [from, to, weight]; in a tree the third item may be "left" or "right"; a tree edge goes parent to child',
      directed: "optional true for arrows, default false",
      layout: '"layers" (default: BFS columns from root), "tree" (top down), or "ring"',
      root: "optional start or tree root node, default the first node",
      frontier: 'optional "queue", "stack" or "heap" strip under the graph',
      distances: "optional true to show infinity under every node until dist or relax sets it",
    },
    ops: {
      visit: '{"node"}; it becomes current and the old current becomes visited',
      push: '{"node","key"?} adds to the frontier; a heap needs "key", the priority (smallest first)',
      pop: '{"node"?} takes the front of a queue, top of a stack or min of a heap, and makes it current; "node" must match it',
      relax: '{"from","to","dist"} sweeps the edge, sets the distance of "to", and marks the edge as its best way in',
      dist: '{"node","value"} sets a distance label; value null means infinity',
      path: '{"nodes":[...]} thick path along existing edges; [] clears it',
      insert: '{"node","parent","side"?:"left"|"right","label"?} adds a leaf to a tree and it slides out of its parent; no parent only for the first root',
      remove: '{"node"} deletes a tree node with at most one child; its child takes its place',
      rotate: '{"node","direction":"left"|"right"} binary tree rotation; the node moves down and its child rises',
      swap: '{"a","b"} two tree nodes trade places, as in heap sift',
    },
    example: [
      '{"step":1,"say":"Start at A. Visit it, then queue its neighbors B and C.","scene":{"g":{"lab":"graph","nodes":["A","B","C","D"],"edges":[["A","B"],["A","C"],["B","D"],["C","D"]],"root":"A","frontier":"queue"}},"do":[{"cue":"Visit","op":"visit","on":["g"],"node":"A"},{"cue":"queue","op":"push","on":["g"],"node":"B"},{"cue":"queue","op":"push","on":["g"],"node":"C"}]}',
    ],
  },

  init(spec, objectId) {
    const unknown = Object.keys(spec).find((key) => !SPEC_KEYS.includes(key));
    if (unknown) fail(`${objectId}: graph has no spec field "${unknown}"; fields: ${SPEC_KEYS.slice(1).join(", ")}`);
    const layout = oneOf(spec.layout, LAYOUTS, "layout", objectId, "layers")!;
    const nodes = readNodes(spec.nodes, layout, objectId);
    const directed = spec.directed === true;
    const rawEdges = readEdges(spec.edges, nodes, layout, directed, objectId);
    const root = spec.root === undefined ? nodes[0]?.id ?? null : idText(spec.root, '"root"', objectId);
    if (root !== null && !nodes.some((node) => node.id === root)) fail(`${objectId}: root "${root}" is not a node; nodes: ${nodes.map((node) => node.id).join(", ")}`);
    if (layout === "tree") checkTree(nodes, rawEdges, root, objectId);
    const frontierKind = oneOf(spec.frontier, FRONTIERS, "frontier", objectId, null);
    return {
      objectId,
      layout,
      directed,
      frontierKind,
      showDistances: spec.distances === true,
      radius: radiusFor(layout, nodes.length),
      nodes,
      edges: layout === "tree" ? withSides(rawEdges, objectId) : rawEdges,
      root,
      visits: {},
      distances: {},
      frontier: [],
      nextSeq: 0,
      relaxed: {},
      path: [],
    };
  },

  apply(state, op) {
    const handler = HANDLERS[op.name];
    if (!handler) return fail(`graph has no op "${op.name}"; ops: ${Object.keys(HANDLERS).join(", ")}`);
    return handler(state, op.args, op.name);
  },

  size: (state) => geometryOf(state).size,

  draw: (state) => drawAt(state, geometryOf(state).positions),

  duration: (op) => DURATIONS[op.name] ?? 0.7,

  during(before, after, op, progress) {
    if (op.name === "relax") return relaxOverlay(after, op, progress);
    if (!["insert", "remove", "rotate", "swap"].includes(op.name)) return [];
    const appearing = op.name === "insert" ? { node: String(op.args.node), opacity: progress } : undefined;
    return drawAt(after, travelingPositions(before, after, op, progress), appearing);
  },
};
