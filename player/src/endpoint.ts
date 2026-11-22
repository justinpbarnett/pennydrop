const SPEECH_LEVEL = 0.12;
const QUIET_LEVEL = 0.06;
const QUIET_SECONDS = 1.4;
const LONGEST_SECONDS = 20;
const MINIMUM_SPEECH_SECONDS = 0.4;

export class Endpoint {
  private heardSpeech = false;
  private speechSeconds = 0;
  private quietSeconds = 0;
  private lastLevelAt = 0;
  private since = 0;

  begin(now: number): void {
    this.heardSpeech = false;
    this.speechSeconds = 0;
    this.quietSeconds = 0;
    this.lastLevelAt = 0;
    this.since = now;
  }

  get spoke(): boolean {
    return this.speechSeconds >= MINIMUM_SPEECH_SECONDS;
  }

  finished(level: number, now: number): boolean {
    const elapsed = this.lastLevelAt ? (now - this.lastLevelAt) / 1000 : 0;
    this.lastLevelAt = now;
    if (level > SPEECH_LEVEL) {
      this.heardSpeech = true;
      this.speechSeconds += elapsed;
      this.quietSeconds = 0;
    } else if (this.heardSpeech && level < QUIET_LEVEL) {
      this.quietSeconds += elapsed;
    }
    return (this.heardSpeech && this.quietSeconds >= QUIET_SECONDS) || (now - this.since) / 1000 >= LONGEST_SECONDS;
  }
}
