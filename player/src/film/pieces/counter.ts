import { type Drawable, type LabDef, numberArg, roleField, stringField } from "../../lab";
import { lerp } from "../../lab";
import type { Role } from "../../lab";
import { inkBelow } from "../../text-metrics";
import { groupDigits } from "../text-flow";

interface CounterState {
  value: number;
  label: string;
  decimals: number;
  role: Role;
  counted: boolean;
}

const NUMBER_SIZE = 300;
const NUMBER_Y = 240;
const RULE_Y = NUMBER_Y + inkBelow("0123456789", NUMBER_SIZE, "mark") + 50;
const LABEL_Y = RULE_Y + 70;
const SIZE = { w: 1300, h: LABEL_Y + 70 };
const COUNT_SECONDS = 2.6;

function numberDrawable(state: CounterState, value: number): Drawable {
  return { id: "number", kind: "text", x: SIZE.w / 2, y: NUMBER_Y, text: state.counted ? groupDigits(value, state.decimals) : "–", size: NUMBER_SIZE, font: "mark", fill: state.role, z: 2 };
}

export const primitive: LabDef<Record<string, unknown>, CounterState> = {
  id: "counter",
  title: "Counter",
  reading: "optional",
  catalog: {
    summary: "A big number with a label under it. It shows a dash until its first count, so its start value is never read as a claim.",
    spec: { value: "the number the first count starts from, default 0; never shown", label: "what the number counts", decimals: "optional digits after the point, default 0", role: "optional color role, default accent" },
    example: ['{"scene":{"addresses":{"kind":"counter","value":0,"label":"addresses"}},"do":[{"cue":"sixty five thousand","op":"count","on":["addresses"],"to":65536}]}'],
  },
  init(spec, objectId) {
    const value = spec.value ?? 0;
    if (typeof value !== "number") throw new Error(`${objectId}: "value" must be a number`);
    return { value, label: stringField(spec, "label", objectId, ""), decimals: Number(spec.decimals ?? 0), role: roleField(spec, "role", "accent", objectId), counted: false };
  },
  ops: {
    count: {
      doc: 'counts to a number: {"to": 65536, "seconds"?: 2.6}',
      seconds: (op) => (typeof op.args.seconds === "number" ? op.args.seconds : COUNT_SECONDS),
      apply: (state, op) => ({ ...state, counted: true, value: numberArg(op.args, "to", "count") }),
      during: (before, after, _op, progress) => [numberDrawable(after, lerp(before.value, after.value, progress))],
    },
  },
  size: () => SIZE,
  draw(state) {
    const out = [numberDrawable(state, state.value)];
    if (state.label) out.push({ id: "label", kind: "text", x: SIZE.w / 2, y: LABEL_Y, text: state.label.toUpperCase(), size: 44, font: "read", fill: "muted", z: 2 });
    out.push({ id: "rule", kind: "line", x: SIZE.w / 2 - 150, y: RULE_Y, x2: SIZE.w / 2 + 150, y2: RULE_Y, stroke: "edge", strokeWidth: 2, z: 1 });
    return out;
  },
};
