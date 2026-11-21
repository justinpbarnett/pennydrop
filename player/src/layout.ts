import { fail, type Rect, type Size } from "./lab";
import type { Relation } from "./format";
import { definitionOf, type SceneState } from "./scene";

export const STAGE: Size = { w: 1600, h: 900 };
const MARGIN = 60;
const FLOW_GAP = 44;
const RELATION_GAP = 36;
const GROUP_GAP = 44;

export interface Box extends Rect {
  scale: number;
}

export type Layout = ReadonlyMap<string, Box>;

interface Member extends Rect {
  id: string;
}

interface Node {
  key: string;
  w: number;
  h: number;
  members: Member[];
  relation: Relation | undefined;
}

interface Cluster {
  root: Node;
  nodes: { node: Node; x: number; y: number }[];
  w: number;
  h: number;
}

const GROUP_KINDS = ["row", "column", "grid", "ring", "timeline", "tree"] as const;

function groupOf(at: Relation | undefined): { kind: (typeof GROUP_KINDS)[number]; ids: string[] } | null {
  if (!at || typeof at === "string") return null;
  const kind = GROUP_KINDS.find((candidate) => candidate in at);
  if (!kind) return null;
  if (kind === "tree") {
    const tree = (at as { tree: Record<string, string[]> }).tree;
    return { kind, ids: [...new Set(Object.entries(tree).flatMap(([parent, children]) => [parent, ...children]))] };
  }
  return { kind, ids: (at as Record<string, string[]>)[kind]! };
}

function arrange(kind: (typeof GROUP_KINDS)[number], at: Relation, sizes: Size[], ids: string[]): Rect[] {
  const gap = kind === "timeline" ? GROUP_GAP * 2 : GROUP_GAP;
  if (kind === "row" || kind === "timeline") {
    let x = 0;
    const height = Math.max(...sizes.map((size) => size.h));
    return sizes.map((size) => {
      const rect = { x, y: (height - size.h) / 2, ...size };
      x += size.w + gap;
      return rect;
    });
  }
  if (kind === "column") {
    let y = 0;
    const width = Math.max(...sizes.map((size) => size.w));
    return sizes.map((size) => {
      const rect = { x: (width - size.w) / 2, y, ...size };
      y += size.h + gap;
      return rect;
    });
  }
  if (kind === "grid") {
    const columns = Math.ceil(Math.sqrt(sizes.length));
    const cellW = Math.max(...sizes.map((size) => size.w));
    const cellH = Math.max(...sizes.map((size) => size.h));
    return sizes.map((size, index) => ({
      x: (index % columns) * (cellW + gap) + (cellW - size.w) / 2,
      y: Math.floor(index / columns) * (cellH + gap) + (cellH - size.h) / 2,
      ...size,
    }));
  }
  if (kind === "ring") {
    const widest = Math.max(...sizes.map((size) => Math.max(size.w, size.h)));
    const radius = Math.max(widest, (sizes.length * (widest + gap)) / (2 * Math.PI));
    return sizes.map((size, index) => {
      const angle = -Math.PI / 2 + (index / sizes.length) * 2 * Math.PI;
      return { x: radius + radius * Math.cos(angle) - size.w / 2 + widest / 2, y: radius + radius * Math.sin(angle) - size.h / 2 + widest / 2, ...size };
    });
  }
  const tree = (at as { tree: Record<string, string[]> }).tree;
  const childIds = new Set(Object.values(tree).flat());
  const roots = ids.filter((id) => !childIds.has(id));
  const cellW = Math.max(...sizes.map((size) => size.w)) + gap;
  const cellH = Math.max(...sizes.map((size) => size.h)) + GROUP_GAP * 1.6;
  const centers = new Map<string, { x: number; y: number }>();
  let nextLeaf = 0;
  const place = (id: string, depth: number): number => {
    const children = tree[id] ?? [];
    const x = children.length === 0 ? nextLeaf++ * cellW : (Math.min(...children.map((child) => place(child, depth + 1))) + Math.max(...children.map((child) => centers.get(child)!.x))) / 2;
    centers.set(id, { x, y: depth * cellH });
    return x;
  };
  roots.forEach((root) => place(root, 0));
  return sizes.map((size, index) => {
    const center = centers.get(ids[index]!)!;
    return { x: center.x - size.w / 2, y: center.y, ...size };
  });
}

function buildNodes(scene: SceneState): Node[] {
  const sizes = new Map<string, Size>();
  for (const object of scene.objects) {
    const def = definitionOf(object);
    if (!def.overlay) sizes.set(object.id, def.size(object.state));
  }
  const claimed = new Set<string>();
  const nodes: Node[] = [];
  for (const object of scene.objects) {
    const group = groupOf(object.at);
    if (!group || !sizes.has(object.id)) continue;
    const ids = (group.ids.includes(object.id) ? group.ids : [object.id, ...group.ids]).filter((id) => sizes.has(id) && !claimed.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => claimed.add(id));
    const rects = arrange(group.kind, object.at!, ids.map((id) => sizes.get(id)!), ids);
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const members = rects.map((rect, index) => ({ ...rect, id: ids[index]!, x: rect.x - minX, y: rect.y - minY }));
    nodes.push({
      key: object.id,
      w: Math.max(...members.map((member) => member.x + member.w)),
      h: Math.max(...members.map((member) => member.y + member.h)),
      members,
      relation: undefined,
    });
  }
  for (const object of scene.objects) {
    const size = sizes.get(object.id);
    if (!size || claimed.has(object.id)) continue;
    nodes.push({ key: object.id, ...size, members: [{ id: object.id, x: 0, y: 0, ...size }], relation: object.at });
  }
  return nodes;
}

function relativeTarget(relation: Relation | undefined): { side: string; target: string } | null {
  if (!relation || typeof relation === "string") return null;
  const entry = Object.entries(relation).find(([key]) => ["below", "above", "left of", "right of", "next to"].includes(key));
  return entry ? { side: entry[0], target: entry[1] as string } : null;
}

function buildClusters(nodes: Node[]): Cluster[] {
  const nodeOf = new Map<string, Node>();
  nodes.forEach((node) => node.members.forEach((member) => nodeOf.set(member.id, node)));
  const placements = new Map<string, { x: number; y: number }>();
  const rootOf = new Map<string, Node>();
  const resolve = (node: Node, trail: string[]): Node => {
    const cached = rootOf.get(node.key);
    if (cached) return cached;
    if (trail.includes(node.key)) fail(`placement loop between ${[...trail, node.key].join(" -> ")}: break the cycle in "at"`);
    const relative = relativeTarget(node.relation);
    let root = node;
    if (relative) {
      const target = nodeOf.get(relative.target);
      if (!target) fail(`${node.key} is placed relative to "${relative.target}", which is not in the Scene`);
      root = resolve(target, [...trail, node.key]);
      const anchor = placements.get(target.key) ?? { x: 0, y: 0 };
      const member = target.members.find((candidate) => candidate.id === relative.target)!;
      const left = anchor.x + member.x;
      const top = anchor.y + member.y;
      const centerX = left + member.w / 2 - node.w / 2;
      const centerY = top + member.h / 2 - node.h / 2;
      const spot: Record<string, { x: number; y: number }> = {
        below: { x: centerX, y: top + member.h + RELATION_GAP },
        above: { x: centerX, y: top - node.h - RELATION_GAP },
        "left of": { x: left - node.w - RELATION_GAP, y: centerY },
        "right of": { x: left + member.w + RELATION_GAP, y: centerY },
        "next to": { x: left + member.w + RELATION_GAP, y: centerY },
      };
      placements.set(node.key, spot[relative.side]!);
    } else {
      placements.set(node.key, { x: 0, y: 0 });
    }
    rootOf.set(node.key, root);
    return root;
  };
  nodes.forEach((node) => resolve(node, []));
  return [...new Set(rootOf.values())].map((root) => {
    const members = nodes.filter((node) => rootOf.get(node.key) === root);
    const minX = Math.min(...members.map((node) => placements.get(node.key)!.x));
    const minY = Math.min(...members.map((node) => placements.get(node.key)!.y));
    const placed = members.map((node) => ({ node, x: placements.get(node.key)!.x - minX, y: placements.get(node.key)!.y - minY }));
    return {
      root,
      nodes: placed,
      w: Math.max(...placed.map((entry) => entry.x + entry.node.w)),
      h: Math.max(...placed.map((entry) => entry.y + entry.node.h)),
    };
  });
}

type Region = "top" | "bottom" | "left" | "right" | "center" | "flow";

function regionOf(relation: Relation | undefined): Region {
  return typeof relation === "string" ? relation : "flow";
}

function placeClusters(clusters: Cluster[]): Map<string, Rect> {
  const origins = new Map<Cluster, { x: number; y: number }>();
  const inRegion = (region: Region) => clusters.filter((cluster) => regionOf(cluster.root.relation) === region);
  let topEdge = MARGIN;
  for (const cluster of inRegion("top")) {
    origins.set(cluster, { x: (STAGE.w - cluster.w) / 2, y: topEdge });
    topEdge += cluster.h + FLOW_GAP / 2;
  }
  let bottomEdge = STAGE.h - MARGIN;
  for (const cluster of inRegion("bottom")) {
    bottomEdge -= cluster.h;
    origins.set(cluster, { x: (STAGE.w - cluster.w) / 2, y: bottomEdge });
    bottomEdge -= FLOW_GAP / 2;
  }
  for (const cluster of inRegion("center")) origins.set(cluster, { x: (STAGE.w - cluster.w) / 2, y: (STAGE.h - cluster.h) / 2 });

  const flow = inRegion("flow");
  const lefts = inRegion("left");
  const rights = inRegion("right");
  const flowWidth = flow.length > 0 ? Math.max(...flow.map((cluster) => cluster.w)) : 0;
  const rowParts = [...lefts.map((cluster) => cluster.w), ...(flow.length > 0 ? [flowWidth] : []), ...rights.map((cluster) => cluster.w)];
  const rowWidth = rowParts.reduce((sum, width) => sum + width, 0) + FLOW_GAP * (rowParts.length - 1);
  let x = (STAGE.w - rowWidth) / 2;
  for (const cluster of lefts) {
    origins.set(cluster, { x, y: (STAGE.h - cluster.h) / 2 });
    x += cluster.w + FLOW_GAP;
  }
  if (flow.length > 0) {
    const stackHeight = flow.reduce((sum, cluster) => sum + cluster.h, 0) + FLOW_GAP * (flow.length - 1);
    const areaTop = inRegion("top").length ? topEdge : MARGIN;
    const areaBottom = inRegion("bottom").length ? bottomEdge : STAGE.h - MARGIN;
    let y = areaTop + (areaBottom - areaTop - stackHeight) / 2;
    for (const cluster of flow) {
      origins.set(cluster, { x: x + (flowWidth - cluster.w) / 2, y });
      y += cluster.h + FLOW_GAP;
    }
    x += flowWidth + FLOW_GAP;
  }
  for (const cluster of rights) {
    origins.set(cluster, { x, y: (STAGE.h - cluster.h) / 2 });
    x += cluster.w + FLOW_GAP;
  }

  const rects = new Map<string, Rect>();
  for (const [cluster, origin] of origins) {
    for (const { node, x, y } of cluster.nodes) {
      for (const member of node.members) {
        rects.set(member.id, { x: origin.x + x + member.x, y: origin.y + y + member.y, w: member.w, h: member.h });
      }
    }
  }
  return rects;
}

function fitToStage(rects: Map<string, Rect>): Layout {
  const all = [...rects.values()];
  if (all.length === 0) return new Map();
  const minX = Math.min(...all.map((rect) => rect.x));
  const maxX = Math.max(...all.map((rect) => rect.x + rect.w));
  const minY = Math.min(...all.map((rect) => rect.y));
  const maxY = Math.max(...all.map((rect) => rect.y + rect.h));
  const scale = Math.min(1, (STAGE.w - 2 * MARGIN) / (maxX - minX), (STAGE.h - 2 * MARGIN) / (maxY - minY));
  const centerX = STAGE.w / 2;
  const centerY = STAGE.h / 2;
  return new Map(
    [...rects].map(([id, rect]) => [
      id,
      { x: centerX + (rect.x - centerX) * scale, y: centerY + (rect.y - centerY) * scale, w: rect.w * scale, h: rect.h * scale, scale },
    ]),
  );
}

export function layoutScene(scene: SceneState): Layout {
  const clusters = buildClusters(buildNodes(scene));
  return fitToStage(placeClusters(clusters));
}
