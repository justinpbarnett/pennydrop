import { fail, type LabDef, stringField } from "../lab";
import { textWidth } from "../text-metrics";

interface AudioState {
  url: string;
  label: string;
}

const LABEL_SIZE = 30;
const LABEL_X = 80;
const SIDE_PADDING = 40;

function sizeOf(state: AudioState) {
  return { w: LABEL_X + textWidth(state.label, LABEL_SIZE, "read") + SIDE_PADDING, h: 90 };
}

export const primitive: LabDef<Record<string, unknown>, AudioState> = {
  id: "audio",
  title: "Audio clip",
  catalog: {
    summary: "A labeled sound clip chip. The player shows the chip; the clip itself plays through the Film sound mix.",
    spec: { url: "audio address", label: "text on the chip" },
    ops: {},
    example: ['{"scene":{"clip":{"kind":"audio","url":"/media/bell.mp3","label":"Bell"}}}'],
  },
  init(spec, objectId) {
    return { url: stringField(spec, "url", objectId), label: stringField(spec, "label", objectId, "clip") };
  },
  apply(_state, op) {
    return fail(`audio has no op "${op.name}"`);
  },
  size: sizeOf,
  draw(state) {
    const { w, h } = sizeOf(state);
    return [
      { id: "chip", kind: "rect", x: w / 2, y: h / 2, w, h, fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1 },
      { id: "play", kind: "path", x: 44, y: h / 2, points: [32, h / 2 - 16, 32, h / 2 + 16, 58, h / 2], closed: true, fill: "accent", stroke: "none", z: 1 },
      { id: "label", kind: "text", x: LABEL_X, y: h / 2, text: state.label, size: LABEL_SIZE, font: "read", anchor: "start", fill: "ink", z: 1 },
    ];
  },
};
