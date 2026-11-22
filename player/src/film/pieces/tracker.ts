import { type Drawable, type LabDef, numberArg, type Role } from "../../lab";

interface TrackerState {
  steps: string[];
  active: number;
}

const CELL = 520;
const MAX_NAME = 20;
const HEIGHT = 360;
const RADIUS = 58;
const CIRCLE_Y = 120;

function roleOf(state: TrackerState, index: number): Role {
  if (index < state.active) return "done";
  return index === state.active ? "active" : "edge";
}

export const primitive: LabDef<Record<string, unknown>, TrackerState> = {
  id: "tracker",
  title: "Step tracker",
  reading: "required",
  catalog: {
    summary: "A row of numbered stages joined by a line, with the current stage lit and finished stages marked done.",
    spec: { steps: "the stage names, in order, each at most 20 characters", active: "index of the current stage from 0, default none yet" },
    example: ['{"scene":{"plan":{"kind":"tracker","steps":["Ask the TLB","Walk the table","Join the offset"]}},"do":[{"cue":"Ask","op":"step","on":["plan"],"to":0}]}'],
  },
  init(spec, objectId) {
    const steps = spec.steps;
    if (!Array.isArray(steps) || steps.length < 2 || steps.some((step) => typeof step !== "string")) throw new Error(`${objectId}: "steps" must list at least two stage names as text`);
    const crowded = (steps as string[]).find((step) => step.length > MAX_NAME);
    if (crowded) throw new Error(`${objectId}: stage name "${crowded}" is over ${MAX_NAME} characters and would run into its neighbor; shorten it`);
    return { steps: steps as string[], active: typeof spec.active === "number" ? spec.active : -1 };
  },
  ops: {
    step: {
      doc: 'moves to a stage: {"to": 1}; "to" counts from 0 and past the last stage marks them all done',
      seconds: 0.6,
      apply: (state, op) => ({ ...state, active: Math.min(state.steps.length, numberArg(op.args, "to", "step")) }),
    },
  },
  size: (state) => ({ w: CELL * state.steps.length, h: HEIGHT }),
  draw(state) {
    const out: Drawable[] = [];
    state.steps.forEach((name, index) => {
      const x = (index + 0.5) * CELL;
      const role = roleOf(state, index);
      if (index > 0) out.push({ id: `link-${index}`, kind: "line", x: x - CELL + RADIUS + 14, y: CIRCLE_Y, x2: x - RADIUS - 14, y2: CIRCLE_Y, stroke: index <= state.active ? "done" : "rule", strokeWidth: 3, z: 1 });
      out.push(
        { id: `ring-${index}`, kind: "circle", x, y: CIRCLE_Y, r: RADIUS, fill: index < state.active ? "done" : "fill", stroke: role, strokeWidth: index === state.active ? 5 : 3, z: 2 },
        { id: `number-${index}`, kind: "text", x, y: CIRCLE_Y, text: String(index + 1), size: 64, font: "mark", fill: index < state.active ? "ground" : role === "edge" ? "muted" : role, z: 3 },
        { id: `name-${index}`, kind: "text", x, y: CIRCLE_Y + 150, text: name, size: 56, font: "read", fill: index <= state.active ? "ink" : "muted", z: 2 },
      );
    });
    return out;
  },
};
