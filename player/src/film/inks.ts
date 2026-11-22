export interface InkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InkSample {
  time: number;
  boxes: Map<string, InkBox>;
}

function union(a: InkBox, b: InkBox): InkBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export class InkRecord {
  private readonly samples: InkSample[];

  constructor(samples: InkSample[] = []) {
    this.samples = [...samples].sort((a, b) => a.time - b.time);
  }

  at(id: string, time: number): InkBox | undefined {
    return (this.samples.find((sample) => sample.time >= time) ?? this.samples.at(-1))?.boxes.get(id);
  }

  between(id: string, from: number, to: number): InkBox | undefined {
    const inside = this.samples.filter((sample) => sample.time >= from && sample.time <= to);
    const boxes = (inside.length > 0 ? inside : this.samples.filter((sample) => sample.time >= from).slice(0, 1)).flatMap((sample) => sample.boxes.get(id) ?? []);
    return boxes.length > 0 ? boxes.reduce(union) : undefined;
  }
}
