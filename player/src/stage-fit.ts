const ASPECT_WIDTH = 16;
const ASPECT_HEIGHT = 9;

export function fitStage(frame: HTMLElement): void {
  const area = frame.parentElement!;
  new ResizeObserver(() => {
    const room = Math.min(area.clientWidth, (area.clientHeight * ASPECT_WIDTH) / ASPECT_HEIGHT);
    document.documentElement.style.setProperty("--stage-width", `${Math.floor(room / ASPECT_WIDTH) * ASPECT_WIDTH}px`);
    frame.style.translate = "";
    const { x, y } = frame.getBoundingClientRect();
    frame.style.translate = `${offPixelGrid(x)}px ${offPixelGrid(y)}px`;
  }).observe(area);
}

function offPixelGrid(position: number): number {
  const scale = devicePixelRatio;
  return (Math.round(position * scale) - position * scale) / scale;
}
