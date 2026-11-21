export class Sounds {
  private context: AudioContext | null = null;

  unlock(): void {
    this.context ??= new AudioContext();
    void this.context.resume();
  }

  right(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => this.tone(frequency, index * 0.09, 0.28, "triangle"));
  }

  wrong(): void {
    this.tone(220, 0, 0.22, "sine");
    this.tone(174.61, 0.16, 0.34, "sine");
  }

  pop(): void {
    this.tone(660, 0, 0.1, "sine");
  }

  private tone(frequency: number, delay: number, length: number, type: OscillatorType): void {
    const context = this.context;
    if (!context) return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + length + 0.05);
  }
}
