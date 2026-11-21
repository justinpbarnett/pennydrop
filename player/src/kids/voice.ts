const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export const LINES = ["hello", "listening", "thinking", "nothing-heard", "oops", "right", "wrong"] as const;
export type Line = (typeof LINES)[number];

export function unlockAudio(...elements: HTMLAudioElement[]): void {
  for (const element of elements) {
    element.src = SILENT_WAV;
    void element.play().then(() => element.pause(), () => undefined);
  }
}

export class SystemVoice {
  readonly audio = new Audio();
  private readonly urls = new Map<Line, string>();

  async preload(): Promise<void> {
    await Promise.all(LINES.map(async (line) => {
      try {
        const voice = (await (await fetch(`/api/system-lines/${line}`)).json()) as { url: string };
        const sound = await (await fetch(voice.url)).blob();
        this.urls.set(line, URL.createObjectURL(sound));
      } catch {
        return;
      }
    }));
  }

  say(line: Line): void {
    const url = this.urls.get(line);
    if (!url) return;
    this.audio.src = url;
    this.audio.currentTime = 0;
    void this.audio.play().catch(() => undefined);
  }
}
