import type { CameraView } from "./format";

export const SCREEN = { w: 1920, h: 1080 } as const;
export const PERSPECTIVE = 2000;
export const FILL: Record<CameraView, number> = { wide: 0.5, fit: 0.88, close: 0.9 };

export function frameAround(size: { w: number; h: number }, view: CameraView): { w: number; h: number } {
  const scale = Math.min((FILL[view] * SCREEN.w) / size.w, (FILL[view] * SCREEN.h) / size.h);
  return { w: SCREEN.w / scale, h: SCREEN.h / scale };
}
