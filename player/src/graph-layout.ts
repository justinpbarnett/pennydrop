import type { Point, Size } from "./lab";
import { EDGE_SPAN } from "./primitives/edge";

export type Side = "left" | "right";
export type LayoutKind = "tree" | "layers" | "ring";

export interface LayoutEdge {
  from: string;
  to: string;
  side: Side | null;
}

export interface LayoutRequest {
  kind: LayoutKind;
  ids: string[];
  edges: LayoutEdge[];
  directed: boolean;
  root: string | null;
  radius: number;
  room: Size;
}

export interface GraphLayout extends Size {
  positions: Map<string, Point>;
}

const TREE_PITCH_GAP = 30;
const TREE_STRETCH_X = 2;
const TREE_STRETCH_Y = 1.6;
const LAYER_COLUMN_MAX = 560;
const LAYER_ROW_MAX = 260;
const LAYER_ROW_GAP = 104;
const RING_MIN_RADIUS = 300;
const EDGE_CLEARANCE = 8;
const CROSSING_COST = 1;
const NODE_HIT_COST = 4;
const LENGTH_COST = 1e-5;
const MAX_SWAP_PASSES = 30;

interface Subtree {
  offsets: Map<string, Point>;
  lo: number;
  hi: number;
}

function placeSubtree(id: string, childrenOf: Map<string, LayoutEdge[]>, pitch: number, levelHeight: number): Subtree {
  const links = [...(childrenOf.get(id) ?? [])].sort((a, b) => Number(a.side === "right") - Number(b.side === "right"));
  if (links.length === 0) return { offsets: new Map([[id, { x: 0, y: 0 }]]), lo: -pitch / 2, hi: pitch / 2 };

  const subtrees = links.map((link) => placeSubtree(link.to, childrenOf, pitch, levelHeight));
  let cursor = 0;
  const centers = subtrees.map((subtree) => {
    const center = cursor - subtree.lo;
    cursor += subtree.hi - subtree.lo;
    return center;
  });
  const onlyChildSide = links.length === 1 ? links[0]!.side : null;
  const parentX = onlyChildSide ? centers[0]! + (onlyChildSide === "left" ? pitch / 2 : -pitch / 2) : (centers[0]! + centers.at(-1)!) / 2;

  const offsets = new Map<string, Point>([[id, { x: 0, y: 0 }]]);
  subtrees.forEach((subtree, index) => {
    subtree.offsets.forEach((offset, node) => offsets.set(node, { x: offset.x + centers[index]! - parentX, y: offset.y + levelHeight }));
  });
  const lo = Math.min(parentX - pitch / 2, ...subtrees.map((subtree, index) => subtree.lo + centers[index]!));
  const hi = Math.max(parentX + pitch / 2, ...subtrees.map((subtree, index) => subtree.hi + centers[index]!));
  return { offsets, lo: lo - parentX, hi: hi - parentX };
}

function treePositions(request: LayoutRequest): Map<string, Point> {
  const pitch = request.radius * 2 + TREE_PITCH_GAP;
  const levelHeight = request.radius * 2 + EDGE_SPAN;
  const childrenOf = new Map<string, LayoutEdge[]>();
  request.edges.forEach((edge) => childrenOf.set(edge.from, [...(childrenOf.get(edge.from) ?? []), edge]));
  const hasParent = new Set(request.edges.map((edge) => edge.to));
  const roots = [...(request.root ? [request.root] : []), ...request.ids.filter((id) => !hasParent.has(id) && id !== request.root)];

  const positions = new Map<string, Point>();
  let cursor = 0;
  for (const root of roots) {
    const subtree = placeSubtree(root, childrenOf, pitch, levelHeight);
    const center = cursor - subtree.lo;
    subtree.offsets.forEach((offset, node) => positions.set(node, { x: center + offset.x, y: offset.y }));
    cursor += subtree.hi - subtree.lo;
  }
  return stretched(positions, request.room, TREE_STRETCH_X, TREE_STRETCH_Y);
}

function stretched(positions: Map<string, Point>, room: Size, limitX: number, limitY: number): Map<string, Point> {
  const points = [...positions.values()];
  const spanX = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
  const spanY = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
  const scaleX = spanX === 0 ? 1 : Math.min(limitX, Math.max(1, room.w / spanX));
  const scaleY = spanY === 0 ? 1 : Math.min(limitY, Math.max(1, room.h / spanY));
  return new Map([...positions].map(([id, point]): [string, Point] => [id, { x: point.x * scaleX, y: point.y * scaleY }]));
}

function breadthFirstLayers(request: LayoutRequest): string[][] {
  const neighbors = new Map<string, string[]>(request.ids.map((id) => [id, []]));
  for (const edge of request.edges) {
    neighbors.get(edge.from)!.push(edge.to);
    if (!request.directed) neighbors.get(edge.to)!.push(edge.from);
  }
  const layers: string[][] = [];
  const seen = new Set<string>();
  const starts = [...(request.root ? [request.root] : []), ...request.ids];
  for (const start of starts) {
    if (seen.has(start)) continue;
    const base = layers.length;
    seen.add(start);
    let wave = [start];
    for (let depth = 0; wave.length > 0; depth++) {
      layers[base + depth] = wave;
      const next: string[] = [];
      for (const id of wave) {
        for (const neighbor of neighbors.get(id)!) {
          if (!seen.has(neighbor)) {
            seen.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      wave = next;
    }
  }
  return layers;
}

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const along = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy));
}

function drawingCost(positions: Map<string, Point>, edges: LayoutEdge[], radius: number): number {
  const segments = edges.map((edge) => ({ edge, from: positions.get(edge.from)!, to: positions.get(edge.to)! }));
  let cost = 0;
  segments.forEach((first, index) => {
    cost += Math.hypot(first.to.x - first.from.x, first.to.y - first.from.y) * LENGTH_COST;
    for (const second of segments.slice(index + 1)) {
      if (crosses(first.from, first.to, second.from, second.to)) cost += CROSSING_COST;
    }
    for (const [id, point] of positions) {
      if (id !== first.edge.from && id !== first.edge.to && distanceToSegment(point, first.from, first.to) < radius + EDGE_CLEARANCE) cost += NODE_HIT_COST;
    }
  });
  return cost;
}

function layerPositions(request: LayoutRequest, layers: string[][]): Map<string, Point> {
  const columnPitch = layers.length < 2 ? 0 : Math.min(LAYER_COLUMN_MAX, Math.max(request.radius * 2 + EDGE_SPAN, request.room.w / (layers.length - 1)));
  const tallest = Math.max(...layers.map((layer) => layer.length));
  const rowPitch = tallest < 2 ? 0 : Math.max(request.radius * 2 + LAYER_ROW_GAP, Math.min(LAYER_ROW_MAX, request.room.h / (tallest - 1)));
  const positionsOf = (order: string[][]) => new Map<string, Point>(order.flatMap((layer, column) => layer.map((id, row): [string, Point] => [id, { x: column * columnPitch, y: (row - (layer.length - 1) / 2) * rowPitch }])));

  let order = layers.map((layer) => [...layer]);
  let best = drawingCost(positionsOf(order), request.edges, request.radius);
  for (let pass = 0; pass < MAX_SWAP_PASSES; pass++) {
    let improved = false;
    order.forEach((layer, column) => {
      for (let row = 0; row < layer.length - 1; row++) {
        const swapped = order.map((candidate, index) => (index === column ? candidate.map((id, at) => (at === row ? candidate[row + 1]! : at === row + 1 ? candidate[row]! : id)) : candidate));
        const cost = drawingCost(positionsOf(swapped), request.edges, request.radius);
        if (cost < best - 1e-9) {
          best = cost;
          order = swapped;
          improved = true;
        }
      }
    });
    if (!improved) break;
  }
  return positionsOf(order);
}

function ringPositions(request: LayoutRequest): Map<string, Point> {
  const count = request.ids.length;
  const ringRadius = count < 2 ? 0 : Math.max(RING_MIN_RADIUS, Math.min(request.room.w, request.room.h) / 2, (count * (request.radius * 2 + EDGE_SPAN)) / (2 * Math.PI));
  return new Map(request.ids.map((id, index) => {
    const angle = -Math.PI / 2 + (index / count) * 2 * Math.PI;
    return [id, { x: ringRadius * Math.cos(angle), y: ringRadius * Math.sin(angle) }];
  }));
}

function placedBy(request: LayoutRequest): Map<string, Point> {
  if (request.kind === "tree") return treePositions(request);
  if (request.kind === "ring") return ringPositions(request);
  return layerPositions(request, breadthFirstLayers(request));
}

export function layoutGraph(request: LayoutRequest): GraphLayout {
  const placed = placedBy(request);
  const points = [...placed.values()];
  if (points.length === 0) return { positions: placed, w: 0, h: 0 };
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const positions = new Map([...placed].map(([id, point]): [string, Point] => [id, { x: point.x - minX, y: point.y - minY }]));
  return { positions, w: Math.max(...points.map((point) => point.x)) - minX, h: Math.max(...points.map((point) => point.y)) - minY };
}
