import { type Drawable, type LabDef, readsWords, stringField } from "../lab";
import { textWidth } from "../text-metrics";

interface AudioState {
  url: string;
  label: string;
  reading: boolean;
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
  reading: "optional",
  catalog: {
    summary: "A labeled sound clip chip. The player shows the chip; the clip itself plays through the Film sound mix.",
    spec: { url: "audio address", label: "text on the chip" },
    example: ['{"scene":{"clip":{"kind":"audio","url":"/media/bell.mp3","label":"Bell"}}}'],
  },
  ops: {},
  init(spec, objectId) {
    return { url: stringField(spec, "url", objectId), label: stringField(spec, "label", objectId, "clip"), reading: readsWords(spec) };
  },
  size: sizeOf,
  draw(state) {
    const { w, h } = sizeOf(state);
    const out: Drawable[] = [
      { id: "chip", kind: "rect", x: w / 2, y: h / 2, w, h, fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1 },
      { id: "play", kind: "path", x: 44, y: h / 2, points: [32, h / 2 - 16, 32, h / 2 + 16, 58, h / 2], closed: true, fill: "accent", stroke: "none", z: 1 },
    ];
    if (state.reading) out.push({ id: "label", kind: "text", x: LABEL_X, y: h / 2, text: state.label, size: LABEL_SIZE, font: "read", anchor: "start", fill: "ink", z: 1 });
    return out;
  },
};
