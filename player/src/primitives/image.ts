import { type Drawable, fail, type LabDef, positiveField, readsWords, stringField } from "../lab";

interface Box {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ImageState {
  url: string;
  w: number;
  h: number;
  boxes: Box[];
  reading: boolean;
}

export const primitive: LabDef<Record<string, unknown>, ImageState> = {
  id: "image",
  title: "Image",
  reading: "optional",
  catalog: {
    summary: "A picture from a URL with optional labeled boxes drawn over it.",
    spec: {
      url: "image address",
      w: "px, default 520",
      h: "px, default 340",
      boxes: 'optional list of {"label", "x", "y", "w", "h"} with x, y, w, h as fractions from 0 to 1 of the image',
    },
    example: ['{"scene":{"photo":{"kind":"image","url":"/media/diagram.png","boxes":[{"label":"wing","x":0.1,"y":0.2,"w":0.3,"h":0.2}]}}}'],
  },
  ops: {},
  init(spec, objectId) {
    const boxes = (spec.boxes ?? []) as Box[];
    if (!Array.isArray(boxes) || !boxes.every((box) => typeof box.label === "string" && [box.x, box.y, box.w, box.h].every((value) => typeof value === "number"))) {
      fail(`${objectId}: "boxes" must be a list of {label, x, y, w, h} with fractions from 0 to 1`);
    }
    return { url: stringField(spec, "url", objectId), w: positiveField(spec, "w", 520, objectId), h: positiveField(spec, "h", 340, objectId), boxes, reading: readsWords(spec) };
  },
  size: (state) => ({ w: state.w, h: state.h }),
  draw(state) {
    const out: Drawable[] = [{ id: "picture", kind: "image", x: state.w / 2, y: state.h / 2, w: state.w, h: state.h, href: state.url }];
    state.boxes.forEach((box, index) => {
      out.push({ id: `box-${index}`, kind: "rect", x: (box.x + box.w / 2) * state.w, y: (box.y + box.h / 2) * state.h, w: box.w * state.w, h: box.h * state.h, fill: "none", stroke: "accent", strokeWidth: 2, radius: 0.3, z: 1 });
      if (state.reading) out.push({ id: `box-${index}-label`, kind: "text", x: box.x * state.w, y: box.y * state.h - 18, text: box.label, size: 24, font: "mark", fill: "accent", anchor: "start", z: 2 });
    });
    return out;
  },
};
