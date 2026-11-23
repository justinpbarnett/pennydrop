import { resolve } from "node:path";
import { svgPathBbox } from "svg-path-bbox";
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

const OPEN_GAP = 30;

function pointsOf(run: Segment[]): [number, number][] {
  const points: [number, number][] = [];
  let [x, y] = [0, 0];
  for (const [command, ...numbers] of run as [string, ...number[]][]) {
    if (command === "Z") continue;
    if (command === "H") x = numbers[0]!;
    else if (command === "V") y = numbers[0]!;
    else {
      for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i]!, numbers[i + 1]!]);
      [x, y] = points.at(-1)!;
      continue;
    }
    points.push([x, y]);
  }
  return points;
}

function measure(run: Segment[]): { area: number; gap: number } {
  const points = pointsOf(run);
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

const specs: PropSpec[] = Object.values(PROP_TABLE);
const entries = [...new Set(specs.map((spec) => spec.icon))].sort().map((name) => {
  const open = specs.some((spec) => spec.icon === name && spec.open);
  const body = icons.icons[name]?.body;
  if (!body) throw new Error(`game-icons has no icon "${name}"`);
  const paths = [...body.matchAll(/<path[^>]* d="([^"]+)"/g)].map((match) => match[1]!);
  if (paths.length !== 1) throw new Error(`game-icons "${name}" should be one path, found ${paths.length}`);
  const d = paths[0]!;
  const [left, top, right, bottom] = svgPathBbox(d).map((value) => Number(value.toFixed(1)));
  const absolute = tidy((svgpath(d).abs() as unknown as { segments: Segment[] }).segments);
  if (absolute.split(/(?=M)/).length !== subpaths(d).length) throw new Error(`game-icons "${name}" has a subpath that does not start with a move`);
  return [name, { d: absolute, backing: backingRuns(d, open), box: [left, top, Number((right! - left!).toFixed(1)), Number((bottom! - top!).toFixed(1))] }] as const;
});

const lines = entries.map(([name, icon]) => `    ${JSON.stringify(name)}: ${JSON.stringify(icon)}`);
const source = { set: `@iconify-json/game-icons ${version}`, license: info.license.title, url: info.license.url };
await Bun.write(OUTPUT, `{\n  "source": ${JSON.stringify(source)},\n  "icons": {\n${lines.join(",\n")}\n  }\n}\n`);
console.log(`wrote ${entries.length} prop icons to ${OUTPUT}`);
