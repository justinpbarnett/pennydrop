import { fail, type Rect, type Size, STAGE, STAGE_MARGIN } from "./lab";
import { NO_REACH, type Reach, reachOf } from "./ink";
import { EDGE_SPAN } from "./primitives/edge";
import { groupOf, type GroupKind, type Region, type Relation, RELATION_GAP, regionOf, sideClear, sideOf, sideSpot } from "./relation";
import { captionDrawable, definitionOf, type SceneObject, type SceneState } from "./scene";
import type { Theme } from "./theme";

export { STAGE };
const MARGIN = STAGE_MARGIN;
const CHILD_SCALE_CAP = 2.5;
const FLOW_GAP = 44;
const GROUP_GAP = 44;
const MIN_FIT_SCALE = 0.6;
const MAX_PACKED_FLOW = 6;

export interface Box extends Rect {
  scale: number;
}

export type Layout = ReadonlyMap<string, Box>;

interface Measured extends Size {
  axis: number;
}

interface Member extends Rect, Measured {
  id: string;
}

interface Node {
  key: string;
  w: number;
  h: number;
  axis: number;
  members: Member[];
  relation: Relation | undefined;
}

interface Cluster {
  root: Node;
  nodes: { node: Node; x: number; y: number }[];
  w: number;
  h: number;
  axis: number;
}

type Joined = (a: string, b: string) => boolean;

function joinedBy(scene: SceneState): Joined {
  const pairs = new Set<string>();
  for (const object of scene.objects) {
    if (definitionOf(object).id !== "edge") continue;
    const { from, to } = object.state as { from: string; to: string };
    pairs.add(`${from}\n${to}`);
    pairs.add(`${to}\n${from}`);
  }
  return (a, b) => pairs.has(`${a}\n${b}`);
}

function arrange(kind: GroupKind, at: Relation, sizes: Measured[], ids: string[], joined: Joined): Rect[] {
  const linked = ids.some((id) => ids.some((other) => joined(id, other)));
  const gap = Math.max(kind === "timeline" ? GROUP_GAP * 2 : GROUP_GAP, linked ? EDGE_SPAN : 0);
  if (kind === "row" || kind === "timeline") {
    let x = 0;
    const axis = Math.max(...sizes.map((size) => size.axis));
    return sizes.map((size) => {
      const rect = { x, y: axis - size.axis, w: size.w, h: size.h };
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
  const cellH = Math.max(...sizes.map((size) => size.h)) + Math.max(GROUP_GAP * 1.6, linked ? EDGE_SPAN : 0);
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

function buildNodes(scene: SceneState, reaches: ReadonlyMap<string, Reach>, joined: Joined): Node[] {
  const sizes = new Map<string, Measured>();
  for (const object of scene.objects) {
    const def = definitionOf(object);
    if (def.overlay) continue;
    const size = def.size(object.state);
    const reach = reaches.get(object.id) ?? NO_REACH;
    sizes.set(object.id, { w: size.w + reach.left + reach.right, h: size.h + reach.top + reach.bottom, axis: reach.top + (def.axis?.(object.state) ?? size.h / 2) });
  }
  const claimed = new Set<string>();
  const nodes: Node[] = [];
  for (const object of scene.objects) {
    const group = groupOf(object.at);
    if (!group || !sizes.has(object.id)) continue;
    const ids = (group.ids.includes(object.id) ? group.ids : [object.id, ...group.ids]).filter((id) => sizes.has(id) && !claimed.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => claimed.add(id));
    const rects = arrange(group.kind, object.at!, ids.map((id) => sizes.get(id)!), ids, joined);
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const members = rects.map((rect, index) => ({ ...rect, id: ids[index]!, x: rect.x - minX, y: rect.y - minY, axis: sizes.get(ids[index]!)!.axis }));
    const h = Math.max(...members.map((member) => member.y + member.h));
    nodes.push({
      key: object.id,
      w: Math.max(...members.map((member) => member.x + member.w)),
      h,
      axis: group.kind === "row" || group.kind === "timeline" ? members[0]!.y + members[0]!.axis : h / 2,
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

function buildClusters(nodes: Node[], joined: Joined): Cluster[] {
  const nodeOf = new Map<string, Node>();
  nodes.forEach((node) => node.members.forEach((member) => nodeOf.set(member.id, node)));
  const placements = new Map<string, { x: number; y: number }>();
  const rootOf = new Map<string, Node>();
  const blockerFor = (node: Node, root: Node, spot: { x: number; y: number }): Rect | undefined => {
    for (const other of nodes) {
      const at = placements.get(other.key);
      if (other === node || !at || rootOf.get(other.key) !== root) continue;
      const clear = spot.x + node.w + RELATION_GAP <= at.x + 1 || at.x + other.w + RELATION_GAP <= spot.x + 1 || spot.y + node.h + RELATION_GAP <= at.y + 1 || at.y + other.h + RELATION_GAP <= spot.y + 1;
      if (!clear) return { x: at.x, y: at.y, w: other.w, h: other.h };
    }
    return undefined;
  };
  const resolve = (node: Node, trail: string[]): Node => {
    const cached = rootOf.get(node.key);
    if (cached) return cached;
    if (trail.includes(node.key)) fail(`placement loop between ${[...trail, node.key].join(" -> ")}: break the cycle in "at"`);
    const relative = sideOf(node.relation);
    let root = node;
    if (relative) {
      const target = nodeOf.get(relative.target);
      if (!target) fail(`${node.key} is placed relative to "${relative.target}", which is not an object in the Scene; "at" names a whole object, never a node, part or value inside one; objects: ${[...nodeOf.keys()].join(", ")}`);
      root = resolve(target, [...trail, node.key]);
      const anchor = placements.get(target.key) ?? { x: 0, y: 0 };
      const member = target.members.find((candidate) => candidate.id === relative.target)!;
      const gap = node.members.some((placed) => joined(placed.id, relative.target)) ? EDGE_SPAN : RELATION_GAP;
      let spot = sideSpot(relative.side, { x: anchor.x + member.x, y: anchor.y + member.y, w: member.w, h: member.h }, node, gap);
      for (let blocker = blockerFor(node, root, spot); blocker; blocker = blockerFor(node, root, spot)) spot = sideClear(relative.side, spot, blocker, node, gap);
      placements.set(node.key, spot);
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
      axis: placed.find((entry) => entry.node === root)!.y + root.axis,
    };
  });
}

const flowOf = (clusters: Cluster[]) => clusters.filter((cluster) => regionOf(cluster.root.relation) === "flow");
const rowWidth = (row: Cluster[]) => row.reduce((sum, cluster) => sum + cluster.w, 0) + FLOW_GAP * (row.length - 1);
const rowAxis = (row: Cluster[]) => Math.max(...row.map((cluster) => cluster.axis));
const rowHeight = (row: Cluster[]) => rowAxis(row) + Math.max(...row.map((cluster) => cluster.h - cluster.axis));

function rowsOf(flow: Cluster[], breaks: number): Cluster[][] {
  const rows: Cluster[][] = [];
  flow.forEach((cluster, index) => {
    if (index === 0 || breaks & (1 << (index - 1))) rows.push([]);
    rows.at(-1)!.push(cluster);
  });
  return rows;
}

function placeClusters(clusters: Cluster[], breaks: number): Map<string, Rect> {
  const origins = new Map<Cluster, { x: number; y: number }>();
  const inRegion = (region: Region) => clusters.filter((cluster) => regionOf(cluster.root.relation) === region);
  const tops = inRegion("top");
  const bottoms = inRegion("bottom");
  const centers = inRegion("center");
  const rows = rowsOf(flowOf(clusters), breaks);
  const lefts = inRegion("left");
  const rights = inRegion("right");
  const edgeHeight = (edge: Cluster[]) => edge.reduce((sum, cluster) => sum + cluster.h + FLOW_GAP, 0);
  const flowHeight = rows.reduce((sum, row) => sum + rowHeight(row), 0) + FLOW_GAP * Math.max(0, rows.length - 1);
  const flow = { h: flowHeight, axis: rows.length === 1 ? rowAxis(rows[0]!) : flowHeight / 2 };
  const lined = [...lefts, ...centers, ...rights, ...(rows.length > 0 ? [flow] : [])];
  const banded = lined.length > 0;
  const bandAxis = Math.max(0, ...lined.map((item) => item.axis));
  const bandHeight = banded ? bandAxis + Math.max(...lined.map((item) => item.h - item.axis)) : 0;
  const stackHeight = edgeHeight(tops) + bandHeight + edgeHeight(bottoms) - (banded ? 0 : FLOW_GAP);
  const centered = !banded || stackHeight > STAGE.h - 2 * MARGIN;
  const stackTop = centered ? (STAGE.h - stackHeight) / 2 : MARGIN;

  let topEdge = stackTop;
  for (const cluster of tops) {
    origins.set(cluster, { x: (STAGE.w - cluster.w) / 2, y: topEdge });
    topEdge += cluster.h + FLOW_GAP;
  }
  let bottomEdge = centered ? stackTop + stackHeight : STAGE.h - MARGIN;
  for (const cluster of bottoms) {
    bottomEdge -= cluster.h;
    origins.set(cluster, { x: (STAGE.w - cluster.w) / 2, y: bottomEdge });
    bottomEdge -= FLOW_GAP;
  }
  const bandTop = topEdge + (bottomEdge - topEdge - bandHeight) / 2;
  const linedY = (item: { axis: number }) => bandTop + bandAxis - item.axis;

  const flowWidth = rows.length > 0 ? Math.max(...rows.map(rowWidth)) : 0;
  const bandParts = [...lefts.map((cluster) => cluster.w), ...centers.map((cluster) => cluster.w), ...(rows.length > 0 ? [flowWidth] : []), ...rights.map((cluster) => cluster.w)];
  const bandWidth = bandParts.reduce((sum, width) => sum + width, 0) + FLOW_GAP * (bandParts.length - 1);
  let x = (STAGE.w - bandWidth) / 2;
  for (const cluster of [...lefts, ...centers]) {
    origins.set(cluster, { x, y: linedY(cluster) });
    x += cluster.w + FLOW_GAP;
  }
  if (rows.length > 0) {
    let y = linedY(flow);
    for (const row of rows) {
      const axis = rowAxis(row);
      let rowX = x + (flowWidth - rowWidth(row)) / 2;
      for (const cluster of row) {
        origins.set(cluster, { x: rowX, y: y + axis - cluster.axis });
        rowX += cluster.w + FLOW_GAP;
      }
      y += rowHeight(row) + FLOW_GAP;
    }
    x += flowWidth + FLOW_GAP;
  }
  for (const cluster of rights) {
    origins.set(cluster, { x, y: linedY(cluster) });
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

const scaleOf = (layout: Layout) => Math.min(...[...layout.values()].map((box) => box.scale));

function packedToStage(clusters: Cluster[], maxScale: number): Layout {
  const flowCount = flowOf(clusters).length;
  const column = 2 ** Math.max(0, flowCount - 1) - 1;
  let best = fitToStage(placeClusters(clusters, column), maxScale);
  if (scaleOf(best) >= maxScale || flowCount > MAX_PACKED_FLOW) return best;
  for (let breaks = 0; breaks < column; breaks++) {
    const packed = fitToStage(placeClusters(clusters, breaks), maxScale);
    if (scaleOf(packed) > scaleOf(best)) best = packed;
  }
  return best;
}

function fitToStage(rects: Map<string, Rect>, maxScale: number): Layout {
  const all = [...rects.values()];
  if (all.length === 0) return new Map();
  const minX = Math.min(...all.map((rect) => rect.x));
  const maxX = Math.max(...all.map((rect) => rect.x + rect.w));
  const minY = Math.min(...all.map((rect) => rect.y));
  const maxY = Math.max(...all.map((rect) => rect.y + rect.h));
  const scale = Math.min(maxScale, (STAGE.w - 2 * MARGIN) / (maxX - minX), (STAGE.h - 2 * MARGIN) / (maxY - minY));
  const scaledAboutCenter = (at: number, center: number) => center + (at - center) * scale;
  const intoStage = (low: number, high: number, size: number) => Math.max(MARGIN - low, Math.min(0, size - MARGIN - high));
  const shiftX = intoStage(scaledAboutCenter(minX, STAGE.w / 2), scaledAboutCenter(maxX, STAGE.w / 2), STAGE.w);
  const shiftY = intoStage(scaledAboutCenter(minY, STAGE.h / 2), scaledAboutCenter(maxY, STAGE.h / 2), STAGE.h);
  return new Map(
    [...rects].map(([id, rect]) => [
      id,
      { x: scaledAboutCenter(rect.x, STAGE.w / 2) + shiftX, y: scaledAboutCenter(rect.y, STAGE.h / 2) + shiftY, w: rect.w * scale, h: rect.h * scale, scale },
    ]),
  );
}

const reaches = new WeakMap<object, WeakMap<Theme, Reach>>();

function reachFor(object: SceneObject, theme: Theme): Reach {
  let perTheme = reaches.get(object);
  if (!perTheme) reaches.set(object, (perTheme = new WeakMap()));
  let reach = perTheme.get(theme);
  if (!reach) {
    const def = definitionOf(object);
    const size = def.size(object.state);
    const ink = def.overlay ? NO_REACH : reachOf(def.draw(object.state, { objectId: object.id, links: {}, theme }), size, theme);
    const caption = def.overlay ? null : captionDrawable(object, size.w, ink.top);
    reach = def.framed ? outward(ink) : ink;
    if (caption) reach = widest(reach, reachOf([caption], size, theme));
    perTheme.set(theme, reach);
  }
  return reach;
}

function widest(a: Reach, b: Reach): Reach {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

function outward(reach: Reach): Reach {
  return { left: Math.max(0, reach.left), top: Math.max(0, reach.top), right: Math.max(0, reach.right), bottom: Math.max(0, reach.bottom) };
}

export function layoutScene(scene: SceneState, theme?: Theme): Layout {
  const reachOfId = new Map<string, Reach>(scene.objects.map((object) => [object.id, theme ? reachFor(object, theme) : NO_REACH]));
  const joined = joinedBy(scene);
  const clusters = buildClusters(buildNodes(scene, reachOfId, joined), joined);
  const fitted = packedToStage(clusters, scene.reading === false ? CHILD_SCALE_CAP : 1);
  return new Map(
    [...fitted].map(([id, box]) => {
      const reach = reachOfId.get(id) ?? NO_REACH;
      const s = box.scale;
      return [id, { x: box.x + reach.left * s, y: box.y + reach.top * s, w: box.w - (reach.left + reach.right) * s, h: box.h - (reach.top + reach.bottom) * s, scale: s }];
    }),
  );
}

export function crowdedSceneError(scene: SceneState, theme: Theme): string | null {
  const layout = layoutScene(scene, theme);
  const scale = scaleOf(layout);
  if (scale >= MIN_FIT_SCALE) return null;
  return `the Scene has too much on stage: ${[...layout.keys()].join(", ")} fit only at ${Math.round(scale * 100)}% size and would be too small to read; remove an object (op "remove") or use fewer, smaller ones`;
}
