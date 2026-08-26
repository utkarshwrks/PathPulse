import type { SensorSample } from '@pathpulse/nav-core';
import type { SensorSource, SensorSourceCapabilities } from '../types.js';

/**
 * Replays a recorded JSONL log with its original timing.
 *
 * This is what makes the eval harness honest: record a real drive with good
 * GNSS, then delete GNSS from an outage window and measure the estimate
 * against the recording. Reproducible, and no tunnel required.
 */
export class ReplaySource implements SensorSource {
  readonly capabilities: SensorSourceCapabilities;

  private listeners: Array<(s: SensorSample) => void> = [];
  private index = 0;
  private running = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private playbackRate = 1;

  constructor(
    private readonly samples: SensorSample[],
    name = 'Replay',
  ) {
    const withGnss = samples.filter((s) => s.gnss).length;
    const withImu = samples.filter((s) => s.imu).length;
    const spanMs =
      samples.length > 1 ? samples[samples.length - 1]!.t - samples[0]!.t : 0;
    const spanS = spanMs / 1000 || 1;

    this.capabilities = {
      hasGnss: withGnss > 0,
      hasImu: withImu > 0,
      hasBaro: samples.some((s) => s.baro),
      imuRateHz: Math.round(withImu / spanS),
      gnssRateHz: Math.round(withGnss / spanS),
      name: `${name} (${samples.length} samples)`,
    };
  }

  /** Parse a JSONL log. Malformed lines are skipped, not fatal. */
  static fromJsonl(text: string, name = 'Replay'): ReplaySource {
    const samples: SensorSample[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as SensorSample;
        if (typeof parsed.t === 'number') samples.push(parsed);
      } catch {
        // A truncated final line is normal if a recording was cut short.
      }
    }
    samples.sort((a, b) => a.t - b.t);
    return new ReplaySource(samples, name);
  }

  onSample(cb: (s: SensorSample) => void): void {
    this.listeners.push(cb);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  reset(): void {
    this.stop();
    this.index = 0;
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.1, Math.min(10, rate));
  }

  get progressFraction(): number {
    return this.samples.length ? this.index / this.samples.length : 0;
  }

  /** Emit the next sample immediately. Pure entry point for tests. */
  stepOnce(): SensorSample | null {
    const sample = this.samples[this.index];
    if (!sample) return null;
    this.index++;
    for (const cb of this.listeners) cb(sample);
    return sample;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const current = this.samples[this.index];
    if (!current) {
      this.stop();
      return;
    }
    const next = this.samples[this.index + 1];
    this.stepOnce();
    if (!next) {
      this.stop();
      return;
    }
    const gapMs = Math.max(0, (next.t - current.t) / this.playbackRate);
    this.timerId = setTimeout(() => this.scheduleNext(), gapMs);
  }
}
