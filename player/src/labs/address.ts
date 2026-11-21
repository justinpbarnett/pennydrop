import { type Drawable, fail, type LabDef, type LabOp, type Role, textDrawable } from "../lab";
import { textWidth } from "../text-metrics";

interface Field {
  name: string;
  bits: number;
}

interface Table {
  name: string;
  base: number;
  level: number;
  entries: Record<number, string | number>;
}

interface Hop {
  table: string;
  index: number;
  address: number;
  target: string | number | null;
  faulted: boolean;
}

interface Access {
  address: number;
  parts: number[];
  offset: number;
  page: number;
  lookup: "none" | "hit" | "miss";
  tlbSlot: number | null;
  frame: number | null;
  hops: Hop[];
  physical: number | null;
  filledSlot: number | null;
  focus: number[];
}

interface TlbEntry {
  page: number;
  frame: number;
}

interface AddressState {
  objectId: string;
  bits: number;
  fields: Field[];
  offsetBits: number;
  entryBytes: number;
  root: string;
  tables: Record<string, Table>;
  slots: number | null;
  tlb: TlbEntry[];
  free: number[];
  capacity: number;
  initialAddress: number | null;
  access: Access | null;
}

interface AddressSpec {
  bits?: unknown;
  fields?: unknown;
  offsetBits?: unknown;
  entryBytes?: unknown;
  address?: unknown;
  root?: unknown;
  tables?: unknown;
  tlb?: unknown;
  freeFrames?: unknown;
}

interface Band {
  groups: { from: number; to: number; left: number; right: number; center: number }[];
  bitX: number[];
  pitch: number;
}

interface Connector {
  id: string;
  points: [number, number][];
  role: Role;
}

const BASE_WIDTH = 1480;
const COLUMN_WIDTH = 316;
const COLUMN_GAP = 84;
const LANE_GAP = 24;
const DIGIT_PITCH = 52;
const GROUP_GAP = 44;
const LABEL_GAP = 44;
const PANEL_BOTTOM_MARGIN = 13;
const VIRTUAL_Y = 60;
const FIELD_ARROW_Y = 182;
const PANEL_TOP = 232;
const HEADER_HEIGHT = 84;
const BADGE_SIZE = 24;
const MAX_ENTRIES_PER_TABLE = 6;
const MAX_TLB_SLOTS = 8;
const MAX_BITS = 48;
const ARROW_GAP = 12;
const HEAD_LENGTH = 18;
const HEAD_ANGLE = 0.5;

function wholeNumber(value: unknown, what: string, objectId: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(value.trim())) return Number(value.trim());
  return fail(`${objectId}: ${what} must be a whole number of at least 0, or hex text such as "0x3A5C"`);
}

function hex(value: number, digits: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(digits, "0")}`;
}

function binary(value: number, width: number): string {
  return value.toString(2).padStart(width, "0");
}

function readFields(fields: unknown, objectId: string): Field[] {
  const example = '"fields": {"L1": 4, "L2": 4}';
  if (typeof fields !== "object" || fields === null || Array.isArray(fields) || Object.keys(fields).length === 0) {
    fail(`${objectId}: "fields" must name the page table index fields from the top level down, with bits for each, such as ${example}; the offset goes in "offsetBits"`);
  }
  return Object.entries(fields).map(([name, bits]) => {
    if (typeof bits !== "number" || !Number.isInteger(bits) || bits < 1 || bits > 16) fail(`${objectId}: field "${name}" needs a bit count from 1 to 16, such as ${example}`);
    if (name === "offset") fail(`${objectId}: "offset" is the last field and is set by "offsetBits"; remove it from "fields"`);
    return { name, bits };
  });
}

function readTables(spec: AddressSpec, fields: Field[], frameLimit: number, bits: number, objectId: string): { root: string; tables: Record<string, Table> } {
  const raw = spec.tables;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    fail(`${objectId}: "tables" must map each page table name to {"base": physical address, "entries": {...}}, for example "tables": {"T0": {"base": "0x1000", "entries": {"3": "T1"}}, "T1": {"base": "0x2000", "entries": {"10": 43}}}`);
  }
  const names = Object.keys(raw);
  const root = typeof spec.root === "string" ? spec.root : names[0]!;
  if (!names.includes(root)) fail(`${objectId}: root table "${root}" is not in "tables"; tables are ${names.join(", ")}`);
  const tables: Record<string, Table> = {};
  for (const [name, value] of Object.entries(raw as Record<string, { base?: unknown; entries?: unknown }>)) {
    const base = wholeNumber(value?.base, `table "${name}" "base"`, objectId);
    if (base >= 2 ** bits) fail(`${objectId}: table "${name}" base ${base} does not fit in ${bits} bits`);
    const entries: Record<number, string | number> = {};
    const given = value?.entries ?? {};
    if (typeof given !== "object" || given === null || Array.isArray(given)) fail(`${objectId}: table "${name}" "entries" must map an index to a table name or a frame number, such as {"3": "T1"}`);
    for (const [key, target] of Object.entries(given)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) fail(`${objectId}: table "${name}" entry "${key}" is not an index; use whole numbers such as "3"`);
      entries[index] = typeof target === "string" && !/^0x[0-9a-f]+$/i.test(target.trim()) ? target : wholeNumber(target, `table "${name}" entry ${index}`, objectId);
    }
    if (Object.keys(entries).length > MAX_ENTRIES_PER_TABLE) fail(`${objectId}: table "${name}" lists ${Object.keys(entries).length} entries; list at most ${MAX_ENTRIES_PER_TABLE}, only the ones the Lesson needs, and the rest read as invalid`);
    tables[name] = { name, base, level: -1, entries };
  }
  assignLevels(tables, tables[root]!, 0, fields, frameLimit, objectId);
  const orphan = names.find((name) => tables[name]!.level < 0);
  if (orphan) fail(`${objectId}: table "${orphan}" is not reachable from root "${root}"; point an entry at it or remove it`);
  return { root, tables };
}

function assignLevels(tables: Record<string, Table>, table: Table, level: number, fields: Field[], frameLimit: number, objectId: string): void {
  if (table.level >= 0 && table.level !== level) fail(`${objectId}: table "${table.name}" is reached at two different levels (${fields[table.level]!.name} and ${fields[level]!.name}); each table belongs to one level`);
  table.level = level;
  const field = fields[level]!;
  const last = level === fields.length - 1;
  for (const [key, target] of Object.entries(table.entries)) {
    const index = Number(key);
    if (index >= 2 ** field.bits) fail(`${objectId}: table "${table.name}" has entry ${index}, but field ${field.name} has ${field.bits} bits, so indexes run 0 to ${2 ** field.bits - 1}`);
    if (last) {
      if (typeof target !== "number") fail(`${objectId}: entry ${index} of last level table "${table.name}" must be a frame number, not "${target}"`);
      if (target >= frameLimit) fail(`${objectId}: frame ${target} in table "${table.name}" does not fit; frames run 0 to ${frameLimit - 1}`);
    } else {
      if (typeof target !== "string") fail(`${objectId}: entry ${index} of table "${table.name}" (level ${field.name}) must name a table of the next level, such as "T1", not the number ${target}`);
      const child = tables[target];
      if (!child) fail(`${objectId}: entry ${index} of table "${table.name}" names table "${target}", which is not in "tables"; tables are ${Object.keys(tables).join(", ")}`);
      assignLevels(tables, child, level + 1, fields, frameLimit, objectId);
    }
  }
}

function readTlb(tlb: unknown, pageLimit: number, objectId: string): { slots: number | null; entries: TlbEntry[] } {
  if (tlb === undefined || tlb === null) return { slots: null, entries: [] };
  const example = '"tlb": {"slots": 4, "entries": [{"page": "0x80", "frame": "0x11"}]}';
  if (typeof tlb !== "object" || Array.isArray(tlb)) return fail(`${objectId}: "tlb" must be an object such as ${example}`);
  const { slots: rawSlots, entries: rawEntries } = tlb as { slots?: unknown; entries?: unknown };
  const list = rawEntries ?? [];
  if (!Array.isArray(list)) return fail(`${objectId}: tlb "entries" must be a list such as ${example}`);
  const entries = list.map((entry, index) => {
    const page = wholeNumber(entry?.page, `tlb entries[${index}] "page"`, objectId);
    const frame = wholeNumber(entry?.frame, `tlb entries[${index}] "frame"`, objectId);
    if (page >= pageLimit || frame >= pageLimit) fail(`${objectId}: tlb entries[${index}] page ${page} or frame ${frame} does not fit; both run 0 to ${pageLimit - 1}`);
    return { page, frame };
  });
  const slots = rawSlots === undefined ? Math.max(4, entries.length) : wholeNumber(rawSlots, 'tlb "slots"', objectId);
  if (slots < 1 || slots > MAX_TLB_SLOTS) fail(`${objectId}: tlb "slots" must be 1 to ${MAX_TLB_SLOTS}`);
  if (entries.length > slots) fail(`${objectId}: tlb lists ${entries.length} entries but has ${slots} slots; raise "slots" or list fewer entries`);
  return { slots, entries };
}

function labelRoom(state: AddressState): number {
  return Math.ceil(textWidth(hex(2 ** state.bits - 1, hexWidth(state.bits)), 40, "read")) + LABEL_GAP;
}

function digitPitch(state: AddressState): number {
  const groups = state.fields.length + 1;
  const bits = state.fields.reduce((sum, field) => sum + field.bits, state.offsetBits);
  return Math.max(20, Math.min(DIGIT_PITCH, Math.floor((BASE_WIDTH - labelRoom(state) - (groups - 1) * GROUP_GAP) / bits)));
}

function digitsRight(state: AddressState): number {
  const groups = state.fields.length + 1;
  const bits = state.fields.reduce((sum, field) => sum + field.bits, state.offsetBits);
  return labelRoom(state) + bits * digitPitch(state) + (groups - 1) * GROUP_GAP;
}

function columnsWidth(state: AddressState): number {
  const columns = state.fields.length + (state.slots === null ? 0 : 1);
  return columns * COLUMN_WIDTH + (columns - 1) * COLUMN_GAP;
}

function columnsCenter(state: AddressState): number {
  return Math.max((labelRoom(state) + digitsRight(state)) / 2, columnsWidth(state) / 2);
}

function canvasWidth(state: AddressState): number {
  return Math.max(digitsRight(state), columnsCenter(state) + columnsWidth(state) / 2 + LANE_GAP);
}

function rowHeight(state: AddressState): number {
  return state.capacity <= 5 ? 50 : 42;
}

function panelHeight(state: AddressState): number {
  return HEADER_HEIGHT + state.capacity * rowHeight(state) + 10;
}

function captionY(state: AddressState): number {
  return PANEL_TOP + panelHeight(state) + 12;
}

function laneY(state: AddressState): number {
  return captionY(state) + 78;
}

function physicalY(state: AddressState): number {
  return laneY(state) + 92;
}

function captionShown(state: AddressState): boolean {
  const access = state.access;
  return access !== null && (access.lookup !== "none" || access.hops.length > 0);
}

function totalHeight(state: AddressState): number {
  if (state.access?.physical == null) return captionShown(state) ? captionY(state) + 72 : PANEL_TOP + panelHeight(state) + PANEL_BOTTOM_MARGIN;
  return physicalY(state) + 130;
}

function columnX(state: AddressState, column: number): number {
  return columnsCenter(state) - columnsWidth(state) / 2 + column * (COLUMN_WIDTH + COLUMN_GAP);
}

function levelColumn(state: AddressState, level: number): number {
  return level + (state.slots === null ? 0 : 1);
}

function rowY(state: AddressState, row: number): number {
  return PANEL_TOP + HEADER_HEIGHT + (row + 0.5) * rowHeight(state);
}

function band(state: AddressState, widths: number[], split: boolean, alignedTo: Band | null = null): Band {
  const bits = widths.reduce((sum, width) => sum + width, 0);
  const gaps = split ? widths.length - 1 : 0;
  const pitch = alignedTo?.pitch ?? digitPitch(state);
  const left = alignedTo ? alignedTo.groups.at(-1)!.right - (bits * pitch + gaps * GROUP_GAP) : labelRoom(state);
  const bitX: number[] = [];
  const groups: Band["groups"] = [];
  let bit = 0;
  widths.forEach((width, group) => {
    const shift = split ? group * GROUP_GAP : 0;
    const from = bit;
    for (let index = 0; index < width; index++, bit++) bitX.push(left + bit * pitch + shift + pitch / 2);
    const start = bitX[from]! - pitch / 2;
    const end = bitX[bit - 1]! + pitch / 2;
    groups.push({ from, to: bit - 1, left: start, right: end, center: (start + end) / 2 });
  });
  return { groups, bitX, pitch };
}

function pageBits(state: AddressState): number {
  return state.bits - state.offsetBits;
}

function hexWidth(bits: number): number {
  return Math.ceil(bits / 4);
}

function virtualBand(state: AddressState): Band {
  return band(state, [...state.fields.map((field) => field.bits), state.offsetBits], state.access !== null);
}

function physicalBand(state: AddressState): Band {
  return band(state, [pageBits(state), state.offsetBits], true, virtualBand(state));
}

interface GroupLabel {
  text: string;
  textRole: Role;
  bracketRole: Role;
}

function bandDrawables(state: AddressState, prefix: string, label: string, value: number, valueRole: Role, y: number, layout: Band, labels: GroupLabel[] | null, digitRole: (group: number) => Role): Drawable[] {
  const out: Drawable[] = [
    textDrawable(`${prefix}-label`, label, { x: 0, y: y - 35 }, { size: 24, anchor: "start", fill: "muted" }),
    textDrawable(`${prefix}-hex`, hex(value, hexWidth(state.bits)), { x: 0, y: y + 10 }, { size: 40, anchor: "start", fill: valueRole }),
  ];
  const text = binary(value, state.bits);
  const groupOf = (bit: number) => layout.groups.findIndex((group) => bit >= group.from && bit <= group.to);
  layout.bitX.forEach((x, bit) => {
    out.push(textDrawable(`${prefix}-bit-${bit}`, text[bit]!, { x, y }, { size: Math.round(layout.pitch * 0.95), fill: digitRole(groupOf(bit)), z: 1 }));
  });
  labels?.forEach((entry, index) => {
    const group = layout.groups[index]!;
    const left = group.left + 4;
    const right = group.right - 4;
    out.push(
      { id: `${prefix}-bracket-${index}`, kind: "path", x: left, y: y + 50, points: [left, y + 50, left, y + 62, right, y + 62, right, y + 50], fill: "none", stroke: entry.bracketRole, strokeWidth: 2, z: 1 },
      textDrawable(`${prefix}-name-${index}`, entry.text, { x: group.center, y: y + 92 }, { size: 32, fill: entry.textRole, z: 1 }),
    );
  });
  return out;
}

function fieldFocused(state: AddressState, group: number): boolean {
  return state.access?.focus.includes(group) ?? false;
}

function resultShown(state: AddressState): boolean {
  return state.access?.physical != null;
}

function virtualDrawables(state: AddressState): Drawable[] {
  const access = state.access;
  const settled = resultShown(state);
  const value = access?.address ?? state.initialAddress;
  if (value === null) return [];
  const labels = access
    ? [...state.fields.map((field, index) => `${field.name} = ${access.parts[index]}`), `offset = ${hex(access.offset, hexWidth(state.offsetBits))}`]
        .map((text, group): GroupLabel => (fieldFocused(state, group) && !settled ? { text, textRole: "active", bracketRole: "active" } : { text, textRole: "ink", bracketRole: "muted" }))
    : null;
  return bandDrawables(state, "v", "virtual", value, "ink", VIRTUAL_Y, virtualBand(state), labels, (group) => (fieldFocused(state, group) && !settled ? "active" : "ink"));
}

function physicalDrawables(state: AddressState): Drawable[] {
  const access = state.access;
  if (!access || access.physical === null) return [];
  const labels: GroupLabel[] = [
    { text: `frame = ${hex(access.frame!, hexWidth(pageBits(state)))}`, textRole: "ok", bracketRole: "ok" },
    { text: `offset = ${hex(access.offset, hexWidth(state.offsetBits))}`, textRole: "ink", bracketRole: "muted" },
  ];
  return bandDrawables(state, "p", "physical", access.physical, "ok", physicalY(state), physicalBand(state), labels, (group) => (group === 0 ? "ok" : "ink"));
}

function panelRect(state: AddressState, id: string, column: number, fill: "fill" | "none", stroke: Role): Drawable {
  return { id, kind: "rect", x: columnX(state, column) + COLUMN_WIDTH / 2, y: PANEL_TOP + panelHeight(state) / 2, w: COLUMN_WIDTH, h: panelHeight(state), fill, stroke, strokeWidth: 1.4, radius: 1 };
}

function header(state: AddressState, id: string, column: number, title: string, sub: string, badge: { text: string; role: Role } | null, titleRole: Role): Drawable[] {
  const x = columnX(state, column);
  const out: Drawable[] = [
    textDrawable(`${id}-title`, title, { x: x + 18, y: PANEL_TOP + 24 }, { size: 28, anchor: "start", fill: titleRole, z: 1 }),
    textDrawable(`${id}-sub`, sub, { x: x + 18, y: PANEL_TOP + 62 }, { size: 22, anchor: "start", fill: "muted", z: 1 }),
  ];
  if (badge) out.push(textDrawable(`${id}-badge`, badge.text, { x: x + COLUMN_WIDTH - 18, y: PANEL_TOP + 24 }, { size: BADGE_SIZE, font: "mark", anchor: "end", fill: badge.role, z: 1 }));
  return out;
}

interface RowCell {
  id: string;
  column: number;
  row: number;
  role: Role | null;
  left: string;
  right: string;
  rightRole: Role;
}

function rowCell(state: AddressState, { id, column, row, role, left, right, rightRole }: RowCell): Drawable[] {
  const x = columnX(state, column);
  const y = rowY(state, row);
  const height = rowHeight(state) - 6;
  return [
    { id: `${id}-row-${row}`, kind: "rect", x: x + COLUMN_WIDTH / 2, y, w: COLUMN_WIDTH - 24, h: height, fill: role ? "fill2" : "fill", stroke: role ?? "rule", strokeWidth: role ? 1.8 : 1, radius: 1, z: 1 },
    textDrawable(`${id}-left-${row}`, left, { x: x + 28, y }, { size: 28, anchor: "start", fill: role ? "ink" : "muted", z: 2 }),
    textDrawable(`${id}-right-${row}`, right, { x: x + COLUMN_WIDTH - 28, y }, { size: 28, anchor: "end", fill: rightRole, z: 2 }),
  ];
}

function caption(state: AddressState, id: string, column: number, first: string, second: string, firstRole: Role): Drawable[] {
  const center = columnX(state, column) + COLUMN_WIDTH / 2;
  return [
    textDrawable(`${id}-caption-1`, first, { x: center, y: captionY(state) + 14 }, { size: 26, fill: firstRole }),
    textDrawable(`${id}-caption-2`, second, { x: center, y: captionY(state) + 50 }, { size: 22, fill: "muted" }),
  ];
}

function tlbDrawables(state: AddressState): Drawable[] {
  if (state.slots === null) return [];
  const access = state.access;
  const lookedUp = access !== null && access.lookup !== "none";
  const stroke: Role = lookedUp ? (access.lookup === "hit" ? "ok" : "fault") : "rule";
  const badge = lookedUp ? { text: access.lookup, role: (access.lookup === "hit" ? "ok" : "fault") as Role } : null;
  const width = hexWidth(pageBits(state));
  const out = [panelRect(state, "tlb-panel", 0, "fill", stroke), ...header(state, "tlb", 0, "TLB", "page / frame", badge, "ink")];
  for (let slot = 0; slot < state.slots; slot++) {
    const entry = state.tlb[slot];
    const role: Role | null = access && (access.tlbSlot === slot || access.filledSlot === slot) ? "ok" : null;
    out.push(...rowCell(state, { id: "tlb", column: 0, row: slot, role, left: entry ? hex(entry.page, width) : "", right: entry ? hex(entry.frame, width) : "", rightRole: "ink" }));
  }
  if (lookedUp) out.push(...caption(state, "tlb", 0, `page ${hex(access.page, width)}`, "index bits joined", "ink"));
  return out;
}

function rowsOf(table: Table, hop: Hop): number[] {
  return [...new Set([...Object.keys(table.entries).map(Number), hop.index])].sort((first, second) => first - second);
}

function levelDrawables(state: AddressState, level: number): Drawable[] {
  const column = levelColumn(state, level);
  const id = `level-${level}`;
  const field = state.fields[level]!;
  const hop = state.access?.hops[level];
  if (!hop) {
    const out = [panelRect(state, `${id}-panel`, column, "none", "rule"), ...header(state, id, column, `${field.name} table`, "", null, "muted")];
    if (level === 0) {
      const center = columnX(state, column) + COLUMN_WIDTH / 2;
      const middle = PANEL_TOP + panelHeight(state) / 2;
      out.push(
        textDrawable(`${id}-ptbr`, "PTBR", { x: center, y: middle - 28 }, { size: 26, fill: "muted" }),
        textDrawable(`${id}-ptbr-value`, hex(state.tables[state.root]!.base, hexWidth(state.bits)), { x: center, y: middle + 18 }, { size: 40 }),
      );
    }
    return out;
  }
  const table = state.tables[hop.table]!;
  const frameWidth = hexWidth(pageBits(state));
  const filled = hop.faulted && hop.target !== null;
  const badge = hop.faulted ? { text: filled ? "filled" : "fault", role: (filled ? "ok" : "fault") as Role } : null;
  const addressWidth = hexWidth(state.bits);
  const sub = level === 0 ? `PTBR = ${hex(table.base, addressWidth)}` : `${table.name} at ${hex(table.base, addressWidth)}`;
  const out = [panelRect(state, `${id}-panel`, column, "fill", hop.faulted && !filled ? "fault" : "rule"), ...header(state, id, column, `${field.name} table`, sub, badge, "ink")];
  rowsOf(table, hop).forEach((index, row) => {
    const target = table.entries[index];
    const selected = index === hop.index;
    const role: Role | null = selected ? (hop.faulted ? (filled ? "ok" : "fault") : "compare") : null;
    const text = target === undefined ? "invalid" : typeof target === "string" ? `table ${target}` : `frame ${hex(target, frameWidth)}`;
    out.push(...rowCell(state, { id, column, row, role, left: String(index), right: text, rightRole: target === undefined ? "fault" : "ink" }));
  });
  out.push(...caption(state, id, column, `entry ${hex(hop.address, addressWidth)}`, `${hex(table.base, addressWidth)} + ${hop.index} × ${state.entryBytes}`, "ink"));
  return out;
}

function selectedRowCenter(state: AddressState, level: number): { x: number; y: number; right: number } {
  const access = state.access!;
  const hop = access.hops[level]!;
  const rows = rowsOf(state.tables[hop.table]!, hop);
  const column = levelColumn(state, level);
  return { x: columnX(state, column), y: rowY(state, rows.indexOf(hop.index)), right: columnX(state, column) + COLUMN_WIDTH - 12 };
}

function connectors(state: AddressState): Connector[] {
  const access = state.access;
  if (!access) return [];
  const out: Connector[] = [];
  const hopRole: Role = resultShown(state) ? "muted" : "active";
  const fields = virtualBand(state).groups;
  if (access.lookup !== "none" && state.slots !== null && access.hops.length === 0) {
    const index = fields.slice(0, state.fields.length);
    const from = (index[0]!.left + index.at(-1)!.right) / 2;
    out.push({ id: "c-tlb", role: hopRole, points: [[from, FIELD_ARROW_Y], [columnX(state, 0) + COLUMN_WIDTH / 2, PANEL_TOP - ARROW_GAP]] });
  }
  access.hops.forEach((_, level) => {
    const column = levelColumn(state, level);
    if (level === access.hops.length - 1) out.push({ id: `c-field-${level}`, role: hopRole, points: [[fields[level]!.center, FIELD_ARROW_Y], [columnX(state, column) + COLUMN_WIDTH / 2, PANEL_TOP - ARROW_GAP]] });
    if (level > 0) {
      const from = selectedRowCenter(state, level - 1);
      out.push({ id: `c-next-${level}`, role: hopRole, points: [[from.right, from.y], [columnX(state, column) - ARROW_GAP, PANEL_TOP + HEADER_HEIGHT / 2]] });
    }
  });
  if (access.physical !== null) {
    const frameGroup = physicalBand(state).groups[0]!;
    const hit = access.lookup === "hit";
    const source = hit
      ? { right: columnX(state, 0) + COLUMN_WIDTH - 12, y: rowY(state, access.tlbSlot!) }
      : selectedRowCenter(state, state.fields.length - 1);
    const lane = (hit ? columnX(state, 0) : columnX(state, levelColumn(state, state.fields.length - 1))) + COLUMN_WIDTH + LANE_GAP;
    out.push({ id: "c-physical", role: "ok", points: [[source.right, source.y], [lane, source.y], [lane, laneY(state)], [frameGroup.center, laneY(state)], [frameGroup.center, physicalY(state) - 44]] });
  }
  return out;
}

function connectorDrawable(connector: Connector): Drawable {
  const { points } = connector;
  const [tipX, tipY] = points.at(-1)!;
  const [fromX, fromY] = points.at(-2)!;
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const wing = (offset: number): [number, number] => [tipX - HEAD_LENGTH * Math.cos(angle + offset), tipY - HEAD_LENGTH * Math.sin(angle + offset)];
  const [wingA, wingB] = [wing(HEAD_ANGLE), wing(-HEAD_ANGLE)];
  const flat = [...points, wingA, [tipX, tipY], wingB].flat();
  return { id: connector.id, kind: "path", x: points[0]![0], y: points[0]![1], points: flat, fill: "none", stroke: connector.role, strokeWidth: 2.4, z: 3 };
}

function requireAccess(state: AddressState, op: LabOp): Access {
  if (!state.access) fail(`${state.objectId}: op "${op.name}" needs an access first; run op "split" before it, for example {"op":"split","on":["${state.objectId}"]}`);
  return state.access;
}

function indexFocus(state: AddressState): number[] {
  return state.fields.map((_, index) => index);
}

function startAccess(state: AddressState, op: LabOp): AddressState {
  const raw = op.args.address ?? state.initialAddress;
  if (raw === undefined || raw === null) fail(`${state.objectId}: op "split" needs an address; pass {"address": "0x3A5C"} or set "address" in the object spec`);
  const address = wholeNumber(raw, 'op "split" "address"', state.objectId);
  if (address >= 2 ** state.bits) fail(`${state.objectId}: address ${hex(address, hexWidth(state.bits))} does not fit in ${state.bits} bits; addresses run 0 to ${hex(2 ** state.bits - 1, hexWidth(state.bits))}`);
  const offsetSize = 2 ** state.offsetBits;
  let rest = Math.floor(address / offsetSize);
  const parts: number[] = [];
  for (let index = state.fields.length - 1; index >= 0; index--) {
    const size = 2 ** state.fields[index]!.bits;
    parts[index] = rest % size;
    rest = Math.floor(rest / size);
  }
  const access: Access = {
    address, parts, offset: address % offsetSize, page: Math.floor(address / offsetSize),
    lookup: "none", tlbSlot: null, frame: null, hops: [], physical: null, filledSlot: null, focus: [],
  };
  return { ...state, access };
}

function lookUpTlb(state: AddressState, op: LabOp): AddressState {
  const access = requireAccess(state, op);
  if (state.slots === null) fail(`${state.objectId} has no TLB; add "tlb": {"slots": 4, "entries": []} to the object spec, or skip op "tlb"`);
  if (access.lookup !== "none") fail(`${state.objectId}: the TLB was already looked up for ${hex(access.address, hexWidth(state.bits))}; go on with "walk" after a miss or "physical" after a hit`);
  const slot = state.tlb.findIndex((entry) => entry.page === access.page);
  const found = slot >= 0 ? state.tlb[slot]!.frame : null;
  return { ...state, access: { ...access, lookup: found === null ? "miss" : "hit", tlbSlot: slot >= 0 ? slot : null, frame: found, focus: indexFocus(state) } };
}

function walkLevel(state: AddressState, op: LabOp): AddressState {
  const access = requireAccess(state, op);
  if (access.lookup === "hit") fail(`${state.objectId}: the TLB hit, so there is nothing to walk; run "physical" to join frame ${hex(access.frame!, hexWidth(pageBits(state)))} and the offset`);
  if (state.slots !== null && access.lookup === "none") fail(`${state.objectId}: look up the TLB before walking, with op "tlb"; the walk only runs after a miss`);
  const previous = access.hops.at(-1);
  if (previous && previous.target === null) fail(`${state.objectId}: the ${state.fields[access.hops.length - 1]!.name} entry at ${hex(previous.address, hexWidth(state.bits))} is invalid; run op "fault" so the OS fills it before the walk goes on`);
  if (access.hops.length === state.fields.length) fail(`${state.objectId}: all ${state.fields.length} levels are walked; run "physical" to join the frame and the offset`);
  const level = access.hops.length;
  const table = state.tables[level === 0 ? state.root : (previous!.target as string)]!;
  const index = access.parts[level]!;
  const target = table.entries[index] ?? null;
  const hop: Hop = { table: table.name, index, address: table.base + index * state.entryBytes, target, faulted: false };
  const last = level === state.fields.length - 1;
  return { ...state, access: { ...access, hops: [...access.hops, hop], frame: last && typeof target === "number" ? target : null, focus: [level] } };
}

function faultIn(state: AddressState, op: LabOp): AddressState {
  const access = requireAccess(state, op);
  const level = access.hops.length - 1;
  const hop = access.hops[level];
  if (!hop || hop.target !== null) fail(`${state.objectId}: nothing faults yet; "fault" follows a "walk" that reached an invalid entry, such as an index missing from the table's "entries"`);
  if (level < state.fields.length - 1) fail(`${state.objectId}: the invalid entry is at level ${state.fields[level]!.name}, but "fault" fills last level entries only; point the address at an index that exists at ${state.fields[level]!.name} in table ${hop.table}`);
  const [frame, ...rest] = state.free;
  if (frame === undefined) fail(`${state.objectId}: the OS has no free frame to bring the page into; add "freeFrames": ["0x30"] to the object spec`);
  const table = state.tables[hop.table]!;
  const tables = { ...state.tables, [table.name]: { ...table, entries: { ...table.entries, [hop.index]: frame } } };
  const hops = access.hops.map((entry, position) => (position === level ? { ...entry, target: frame, faulted: true } : entry));
  return { ...state, tables, free: rest, access: { ...access, hops, frame, focus: [level] } };
}

function formPhysical(state: AddressState, op: LabOp): AddressState {
  const access = requireAccess(state, op);
  if (access.physical !== null) fail(`${state.objectId}: the physical address ${hex(access.physical, hexWidth(state.bits))} is already formed; run "split" with a new "address" to start another access`);
  if (access.frame === null) {
    const next = access.hops.length === 0 ? (state.slots === null ? 'walk the levels with op "walk"' : 'look up the TLB with op "tlb", then walk the levels with op "walk"') : `walk ${state.fields.length - access.hops.length} more level(s) with op "walk"`;
    fail(`${state.objectId}: there is no frame number yet, so no physical address; ${next}`);
  }
  return { ...state, access: { ...access, physical: access.frame * 2 ** state.offsetBits + access.offset, focus: [state.fields.length] } };
}

function fillTlb(state: AddressState, op: LabOp): AddressState {
  const access = requireAccess(state, op);
  if (state.slots === null) fail(`${state.objectId} has no TLB to fill; add "tlb": {"slots": 4, "entries": []} to the object spec`);
  if (access.lookup === "none") fail(`${state.objectId}: look up the TLB with "tlb" before filling it`);
  if (access.lookup === "hit") fail(`${state.objectId}: the TLB already holds page ${hex(access.page, hexWidth(pageBits(state)))}; fill it after a miss, once the walk has found the frame`);
  if (access.frame === null) fail(`${state.objectId}: no frame to cache yet; finish the walk with "walk" (and "fault" if an entry is invalid) before "fill"`);
  if (access.filledSlot !== null) fail(`${state.objectId}: the TLB already holds page ${hex(access.page, hexWidth(pageBits(state)))} from this access`);
  const kept = state.tlb.length < state.slots ? state.tlb : state.tlb.slice(1);
  const tlb = [...kept, { page: access.page, frame: access.frame }];
  return { ...state, tlb, access: { ...access, filledSlot: tlb.length - 1, focus: indexFocus(state) } };
}

function revealConnectors(before: AddressState, after: AddressState, _op: LabOp, progress: number): Drawable[] {
  const known = new Set(connectors(before).map((connector) => connector.id));
  return connectors(after)
    .filter((connector) => !known.has(connector.id))
    .map((connector) => ({ ...connectorDrawable(connector), draw: progress }));
}

export const lab: LabDef<AddressSpec, AddressState> = {
  id: "address",
  title: "Address translation",
  reading: "required",
  catalog: {
    summary: "Turns a virtual address into a physical one with a multi level page table and an optional TLB. The Lab computes every field value, entry address and the physical address; Steps only say which stage to show. Object parts are not used: put the object alone in \"on\".",
    spec: {
      bits: "address width in bits, such as 16",
      fields: 'page table index fields from the top level down, as {"name": bits}, such as {"L1": 4, "L2": 4}; the field names are the level names shown',
      offsetBits: "bits of the offset field below the index fields; fields plus offsetBits must add up to bits",
      entryBytes: "bytes in one page table entry, default 4; an entry sits at table base plus index times entryBytes",
      address: 'optional first virtual address, a number or hex text such as "0x3A5C"; op split can pass another',
      root: "optional name of the top level table, default the first table; its base is the value in the PTBR register",
      tables: 'every table by name as {"T0": {"base": "0x1000", "entries": {"3": "T1"}}}; entries of upper levels name a table, entries of the last level are frame numbers; an index not listed is invalid; at most 6 entries per table',
      tlb: 'optional {"slots": 4, "entries": [{"page": "0x80", "frame": "0x11"}]}; page is the index fields joined; omit for no TLB',
      freeFrames: 'frame numbers the OS hands out on a page fault, in order, such as ["0x30"]',
    },
    example: [
      '{"step":1,"say":"Split the address, miss the TLB, walk both levels, and form the physical address.","scene":{"mmu":{"lab":"address","bits":16,"fields":{"L1":4,"L2":4},"offsetBits":8,"entryBytes":2,"address":"0x3A5C","tables":{"T0":{"base":"0x1000","entries":{"3":"T1"}},"T1":{"base":"0x2000","entries":{"10":"0x2B"}}},"tlb":{"slots":4,"entries":[]}}},"do":[{"cue":"Split","op":"split","on":["mmu"]},{"cue":"miss","op":"tlb","on":["mmu"]},{"cue":"walk","op":"walk","on":["mmu"]},{"cue":"both levels","op":"walk","on":["mmu"]},{"cue":"physical address","op":"physical","on":["mmu"]}]}',
    ],
  },

  init(spec, objectId) {
    const bits = wholeNumber(spec.bits, '"bits"', objectId);
    if (bits < 8 || bits > MAX_BITS) fail(`${objectId}: "bits" must be 8 to ${MAX_BITS}, such as 16`);
    const fields = readFields(spec.fields, objectId);
    const offsetBits = wholeNumber(spec.offsetBits, '"offsetBits"', objectId);
    const total = fields.reduce((sum, field) => sum + field.bits, 0) + offsetBits;
    if (offsetBits < 1 || total !== bits) {
      fail(`${objectId}: the field split must add up to the address width: ${[...fields.map((field) => `${field.name} ${field.bits}`), `offset ${offsetBits}`].join(" + ")} = ${total}, but "bits" is ${bits}; change "offsetBits" to ${bits - (total - offsetBits)} or adjust a field so the sum is ${bits}`);
    }
    const pageLimit = 2 ** (bits - offsetBits);
    const { root, tables } = readTables(spec, fields, pageLimit, bits, objectId);
    const { slots, entries } = readTlb(spec.tlb, pageLimit, objectId);
    const free = (Array.isArray(spec.freeFrames) ? spec.freeFrames : []).map((frame, index) => {
      const value = wholeNumber(frame, `freeFrames[${index}]`, objectId);
      if (value >= pageLimit) fail(`${objectId}: freeFrames[${index}] ${value} does not fit; frames run 0 to ${pageLimit - 1}`);
      return value;
    });
    const declared = Math.max(...Object.values(tables).map((table) => Object.keys(table.entries).length));
    const initialAddress = spec.address === undefined ? null : wholeNumber(spec.address, '"address"', objectId);
    if (initialAddress !== null && initialAddress >= 2 ** bits) fail(`${objectId}: "address" ${initialAddress} does not fit in ${bits} bits`);
    const entryBytes = spec.entryBytes === undefined ? 4 : wholeNumber(spec.entryBytes, '"entryBytes"', objectId);
    if (entryBytes < 1) fail(`${objectId}: "entryBytes" must be at least 1`);
    return {
      objectId, bits, fields, offsetBits, entryBytes, root, tables, slots, tlb: entries, free,
      capacity: Math.max(3, slots ?? 0, declared + 2), initialAddress, access: null,
    };
  },

  ops: {
    split: {
      doc: 'optional {"address": "0x3A5C"}; starts an access: writes the address in binary, groups the digits and brackets each field with its value; a new address starts a new access and clears the walk',
      seconds: 1.2,
      apply: startAccess,
      during: revealConnectors,
    },
    tlb: {
      doc: "looks the page up in the TLB and shows a hit (with its frame) or a miss; needed before walk when the TLB exists",
      seconds: 0.9,
      apply: lookUpTlb,
      during: revealConnectors,
    },
    walk: {
      doc: "walks the next level: the PTBR or the previous entry points at a table, the field's index selects an entry, and the entry address (base + index x entryBytes) is shown; an entry that is not listed shows as invalid",
      seconds: 1.1,
      apply: walkLevel,
      during: revealConnectors,
    },
    fault: {
      doc: "after a walk reached an invalid last level entry: the OS brings the page into the next free frame and fills the entry",
      seconds: 1.2,
      apply: faultIn,
      during: revealConnectors,
    },
    physical: {
      doc: "joins the frame number and the offset into the physical address; works after a TLB hit or a finished walk",
      seconds: 1.4,
      apply: formPhysical,
      during: revealConnectors,
    },
    fill: {
      doc: "after a miss and a finished walk: stores page to frame in the TLB, evicting the oldest entry when it is full",
      seconds: 1.0,
      apply: fillTlb,
      during: revealConnectors,
    },
  },

  size(state) {
    return { w: canvasWidth(state), h: totalHeight(state) };
  },

  draw(state) {
    return [
      ...virtualDrawables(state),
      ...tlbDrawables(state),
      ...state.fields.flatMap((_, level) => levelDrawables(state, level)),
      ...physicalDrawables(state),
      ...connectors(state).map(connectorDrawable),
    ];
  },
};
