import { type Drawable, fail, type LabDef, positiveField, readsWords, type Role, roleField, stringArg } from "../lab";
import { textWidth } from "../text-metrics";

interface GridCell {
  value: string;
  role: Role | null;
}

interface GridState {
  objectId: string;
  cells: GridCell[][];
  cell: number;
  reading: boolean;
}

function cellAt(state: GridState, part: string): [number, number] {
  const match = /^(\d+),(\d+)$/.exec(part);
  if (!match) fail(`${state.objectId}[${part}] is not a grid cell: use ${state.objectId}[row,col] such as ${state.objectId}[0,1]`);
  const [row, column] = [Number(match![1]), Number(match![2])];
  if (row >= state.cells.length || column >= state.cells[0]!.length) {
    fail(`${state.objectId}[${part}] is out of range: ${state.objectId} has ${state.cells.length} rows and ${state.cells[0]!.length} columns`);
  }
  return [row, column];
}

function updateCells(state: GridState, parts: string[], change: (cell: GridCell) => GridCell): GridState {
  const targets = parts.map((part) => cellAt(state, part));
  if (targets.length === 0) fail(`op needs cells in "on", such as ["${state.objectId}[0,1]"]`);
  return { ...state, cells: state.cells.map((row, r) => row.map((cell, c) => (targets.some(([tr, tc]) => tr === r && tc === c) ? change(cell) : cell))) };
}

const textSize = (state: GridState) => state.cell * 0.4;

function columnWidths(state: GridState): number[] {
  const size = textSize(state);
  return state.cells[0]!.map((_, column) => Math.max(state.cell, ...(state.reading ? state.cells.map((row) => textWidth(row[column]!.value, size, "read") + size) : [])));
}

export const primitive: LabDef<Record<string, unknown>, GridState> = {
  id: "grid",
  title: "Grid",
  reading: "optional",
  catalog: {
    summary: "A table of cells. Parts are row,col: grid[1,2].",
    spec: { cells: "list of rows, each a list of numbers or text", cell: "optional cell size px, default 96" },
    example: ['{"scene":{"g":{"kind":"grid","cells":[[1,2],[3,4]]}}}'],
  },
  ops: {
    set: {
      doc: '{"value": 7} on cells',
      seconds: 0.6,
      apply(state, op) {
        const value = String(op.args.value ?? stringArg(op.args, "value", "set"));
        return updateCells(state, op.parts, (cell) => ({ ...cell, value }));
      },
    },
    mark: {
      doc: '{"role": "active"} on cells; role "none" clears',
      seconds: 0.6,
      apply(state, op) {
        const role = op.args.role === "none" ? null : roleField(op.args, "role", "active", state.objectId);
        return updateCells(state, op.parts, (cell) => ({ ...cell, role }));
      },
    },
  },
  init(spec, objectId) {
    const rows = spec.cells;
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every((row) => Array.isArray(row) && row.length === rows[0].length && row.length > 0)) {
      fail(`${objectId}: "cells" must be a non-empty list of equal length rows`);
    }
    return {
      objectId,
      cell: positiveField(spec, "cell", 96, objectId),
      cells: (rows as unknown[][]).map((row) => row.map((value) => ({ value: String(value), role: null }))),
      reading: readsWords(spec),
    };
  },
  size: (state) => ({ w: columnWidths(state).reduce((total, width) => total + width, 0), h: state.cells.length * state.cell }),
  draw(state) {
    const out: Drawable[] = [];
    const widths = columnWidths(state);
    const lefts = widths.map((_, column) => widths.slice(0, column).reduce((total, width) => total + width, 0));
    state.cells.forEach((row, r) => row.forEach((cell, c) => {
      const x = lefts[c]! + widths[c]! / 2;
      const y = (r + 0.5) * state.cell;
      out.push({ id: `cell-${r}-${c}`, kind: "rect", x, y, w: widths[c]!, h: state.cell, fill: cell.role ? "fill2" : "fill", stroke: cell.role ?? "rule", strokeWidth: cell.role ? 1.8 : 1, radius: 0.5, part: `${state.objectId}[${r},${c}]` });
      if (state.reading) out.push({ id: `value-${r}-${c}`, kind: "text", x, y, text: cell.value, size: textSize(state), font: "read", fill: "ink", z: 1 });
    }));
    return out;
  },
};
