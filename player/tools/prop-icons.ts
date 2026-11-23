import { resolve } from "node:path";
import { svgPathBbox } from "svg-path-bbox";
import { intersection } from "polygon-clipping";
import svgpath from "svgpath";
import { PROP_TABLE, type PropSpec } from "../src/film/acting/prop-table";

const ROOT = resolve(import.meta.dir, "..");
const SET = resolve(ROOT, "node_modules/@iconify-json/game-icons");
const OUTPUT = resolve(ROOT, "src/film/acting/prop-icons.json");

type Segment = (string | number)[];

const icons = (await Bun.file(resolve(SET, "icons.json")).json()) as { icons: Record<string, { body: string }> };
const info = (await Bun.file(resolve(SET, "info.json")).json()) as { license: { title: string; url: string } };
const { version } = (await Bun.file(resolve(SET, "package.json")).json()) as { version: string };

const tidy = (segments: Segment[]) => {
  const path = svgpath("");
  (path as unknown as { segments: Segment[] }).segments = segments;
  return path.round(1).toString();
};

function subpaths(d: string): Segment[][] {
  const segments = (svgpath(d).abs().unarc().unshort() as unknown as { segments: Segment[] }).segments;
  return segments.reduce<Segment[][]>((runs, segment) => {
    if (segment[0] === "M" || !runs.length) runs.push([]);
    runs.at(-1)!.push(segment);
    return runs;
  }, []);
}

type Point = [number, number];

const CURVE_STEPS = 12;

function outlineOf(run: Segment[]): Point[] {
  const points: Point[] = [];
  let at: Point = [0, 0];
  for (const [command, ...n] of run as [string, ...number[]][]) {
    if (command === "M" || command === "L") at = [n[0]!, n[1]!];
    else if (command === "H") at = [n[0]!, at[1]];
    else if (command === "V") at = [at[0], n[0]!];
    else if (command === "Q" || command === "C") {
      const controls: Point[] = [at];
      for (let i = 0; i + 1 < n.length; i += 2) controls.push([n[i]!, n[i + 1]!]);
      for (let step = 1; step <= CURVE_STEPS; step++) points.push(bezier(controls, step / CURVE_STEPS));
      at = controls.at(-1)!;
      continue;
    } else continue;
    points.push(at);
  }
  return points;
}

function bezier(controls: Point[], t: number): Point {
  let level = controls;
  while (level.length > 1) level = level.slice(1).map(([x, y], i) => [level[i]![0] + (x - level[i]![0]) * t, level[i]![1] + (y - level[i]![1]) * t]);
  return level[0]!;
}

const OPEN_GAP = 30;

function measure(run: Segment[]): { area: number; gap: number } {
  const points = outlineOf(run);
  let [twice, perimeter] = [0, 0];
  points.forEach(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length]!;
    twice += x * ny - nx * y;
    perimeter += Math.hypot(nx - x, ny - y);
  });
  return { area: twice / 2, gap: perimeter ? Math.abs(twice) / perimeter : 0 };
}

function backingRuns(d: string, open: boolean): number[] {
  const runs = subpaths(d).map(measure);
  const outer = Math.sign(runs.reduce((widest, run) => (Math.abs(run.area) > Math.abs(widest) ? run.area : widest), 0));
  return runs.flatMap((run, i) => (Math.sign(run.area) === outer || open || run.gap >= OPEN_GAP ? [i] : []));
}

const ROW = 2;
const NOTCH_ROWS = 10;
const TOLERANCE = 0.5;

function closed(edges: number[], outward: (...xs: number[]) => number, inward: (...xs: number[]) => number, empty: number): number[] {
  const padded = [...Array<number>(NOTCH_ROWS).fill(empty), ...edges, ...Array<number>(NOTCH_ROWS).fill(empty)];
  const near = (list: number[], i: number) => list.slice(Math.max(0, i - NOTCH_ROWS), i + NOTCH_ROWS + 1);
  const spread = padded.map((_, i) => outward(...near(padded, i)));
  return edges.map((_, i) => inward(...near(spread, i + NOTCH_ROWS)));
}

function simplified(points: Point[]): Point[] {
  const [a, b] = [points[0]!, points.at(-1)!];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const offsets = points.map(([x, y]) => Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / length);
  const far = offsets.indexOf(Math.max(...offsets));
  if (points.length < 3 || offsets[far]! <= TOLERANCE) return [a, b];
  return [...simplified(points.slice(0, far + 1)).slice(0, -1), ...simplified(points.slice(far))];
}

function spans(outlines: Point[][]): { at: number[]; low: number[]; high: number[] } {
  const ys = outlines.flat().map(([, y]) => y);
  const rows: { y: number; low: number; high: number }[] = [];
  for (let y = Math.min(...ys) + ROW / 2; y < Math.max(...ys); y += ROW) {
    const xs = outlines.flatMap((outline) => outline.flatMap(([ax, ay], i) => {
      const [bx, by] = outline[(i + 1) % outline.length]!;
      return (ay <= y) !== (by <= y) ? [ax + ((y - ay) / (by - ay)) * (bx - ax)] : [];
    }));
    if (xs.length) rows.push({ y, low: Math.min(...xs), high: Math.max(...xs) });
  }
  return {
    at: rows.map((row) => row.y),
    low: closed(rows.map((row) => row.low), Math.min, Math.max, Infinity),
    high: closed(rows.map((row) => row.high), Math.max, Math.min, -Infinity),
  };
}

const flipped = (points: Point[]): Point[] => points.map(([x, y]) => [y, x]);
const ring = (points: Point[]): Point[] => [...points, points[0]!];
const rounded = (value: number) => Math.round(value * 10) / 10;

function solidFill(d: string): string {
  const outlines = subpaths(d).map(outlineOf);
  const rows = spans(outlines);
  const columns = spans(outlines.map(flipped));
  const ground = Math.max(...outlines.flat().map(([, y]) => y));
  const between = [...simplified(rows.at.map((y, i): Point => [rows.low[i]!, y])), ...simplified(rows.at.map((y, i): Point => [rows.high[i]!, y]).reverse())];
  const under = [...simplified(columns.at.map((x, i): Point => [x, columns.low[i]!])), [columns.at.at(-1)!, ground], [columns.at[0]!, ground]] satisfies Point[];
  const solid = intersection([ring(between)], [ring(under)]);
  return solid.flatMap((rings) => rings.map((points) => `M${points.slice(0, -1).map(([x, y]) => `${rounded(x)} ${rounded(y)}`).join("L")}Z`)).join("");
}

const specs: PropSpec[] = Object.values(PROP_TABLE);
const entries = [...new Set(specs.map((spec) => spec.icon))].sort().map((name) => {
  const holes = specs.find((spec) => spec.icon === name && spec.holes)?.holes;
  const body = icons.icons[name]?.body;
  if (!body) throw new Error(`game-icons has no icon "${name}"`);
  const paths = [...body.matchAll(/<path[^>]* d="([^"]+)"/g)].map((match) => match[1]!);
  if (paths.length !== 1) throw new Error(`game-icons "${name}" should be one path, found ${paths.length}`);
  const d = paths[0]!;
  const [left, top, right, bottom] = svgPathBbox(d).map((value) => Number(value.toFixed(1)));
  const absolute = tidy((svgpath(d).abs() as unknown as { segments: Segment[] }).segments);
  if (absolute.split(/(?=M)/).length !== subpaths(d).length) throw new Error(`game-icons "${name}" has a subpath that does not start with a move`);
  return [name, { d: absolute, backing: backingRuns(d, holes === "open"), ...(holes === "solid" && { fill: solidFill(d) }), box: [left, top, Number((right! - left!).toFixed(1)), Number((bottom! - top!).toFixed(1))] }] as const;
});

const lines = entries.map(([name, icon]) => `    ${JSON.stringify(name)}: ${JSON.stringify(icon)}`);
const source = { set: `@iconify-json/game-icons ${version}`, license: info.license.title, url: info.license.url };
await Bun.write(OUTPUT, `{\n  "source": ${JSON.stringify(source)},\n  "icons": {\n${lines.join(",\n")}\n  }\n}\n`);
console.log(`wrote ${entries.length} prop icons to ${OUTPUT}`);
