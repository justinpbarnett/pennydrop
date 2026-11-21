import { fail, type LabDef, stringField } from "../lab";

interface AudioState {
  url: string;
  label: string;
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
  size: (state) => ({ w: 120 + state.label.length * 20, h: 90 }),
  draw(state) {
    const { w, h } = this.size(state);
    return [
      { id: "chip", kind: "rect", x: w / 2, y: h / 2, w, h, fill: "fill", stroke: "rule", strokeWidth: 1, radius: 1 },
      { id: "play", kind: "path", x: 44, y: h / 2, points: [32, h / 2 - 16, 32, h / 2 + 16, 58, h / 2], closed: true, fill: "accent", stroke: "none", z: 1 },
      { id: "label", kind: "text", x: 80, y: h / 2, text: state.label, size: 30, font: "read", anchor: "start", fill: "ink", z: 1 },
    ];
  },
};
