export class Recorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private chunks: Blob[] = [];
  private frame = 0;

  constructor(private readonly onLevel: (level: number) => void) {}

  get recording(): boolean {
    return this.recorder !== null;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot record audio here. Open the page over https or localhost.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
      throw new Error("The microphone is blocked. Allow it for this page, or type the question.");
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.addEventListener("dataavailable", (event) => this.chunks.push(event.data));
    this.recorder.start();
    this.meter(this.stream);
  }

  stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error("Not recording."));
    return new Promise((resolve) => {
      recorder.addEventListener("stop", () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType });
        this.release();
        resolve(blob);
      });
      recorder.stop();
    });
  }

  cancel(): void {
    const recorder = this.recorder;
    if (!recorder) return;
    this.release();
    if (recorder.state !== "inactive") recorder.stop();
  }

  private meter(stream: MediaStream): void {
    this.context = new AudioContext();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      const power = samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length;
      this.onLevel(Math.min(1, Math.sqrt(power) * 3));
      this.frame = requestAnimationFrame(measure);
    };
    measure();
  }

  private release(): void {
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.recorder = null;
    this.stream = null;
    this.context = null;
    this.onLevel(0);
  }
}
