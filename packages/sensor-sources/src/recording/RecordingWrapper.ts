import type { SensorSample } from '@pathpulse/nav-core';
import type { SensorSource, SensorSourceCapabilities } from '../types.js';

/**
 * Wraps any SensorSource and records every sample as JSONL.
 *
 * Recordings become CI fixtures and eval-harness input, so this deliberately
 * stores samples verbatim — no filtering, no rounding. The whole value of a
 * recording is that it is exactly what the engine saw.
 */
export class RecordingWrapper implements SensorSource {
  private recorded: SensorSample[] = [];
  private recording = true;
  private listeners: Array<(s: SensorSample) => void> = [];

  /**
   * ★ SUBSCRIBE TO THE INNER SOURCE EXACTLY ONCE ★
   *
   * The first version registered its recording callback inside `onSample`,
   * which had two consequences, both silent:
   *
   *  - Nothing was recorded at all unless somebody happened to subscribe. A
   *    recorder whose output depends on whether anyone is listening is not a
   *    recorder.
   *  - Two subscribers meant two callbacks, so every sample was pushed to the
   *    buffer twice. The log would replay at double the sample rate with each
   *    reading duplicated — and it would look plausible, because the
   *    timestamps would all still be there, just twice.
   */
  constructor(private readonly inner: SensorSource) {
    this.inner.onSample((s) => {
      if (this.recording) this.recorded.push(s);
      for (const cb of this.listeners) cb(s);
    });
  }

  get capabilities(): SensorSourceCapabilities {
    return this.inner.capabilities;
  }

  onSample(cb: (s: SensorSample) => void): void {
    this.listeners.push(cb);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  pauseRecording(): void {
    this.recording = false;
  }

  resumeRecording(): void {
    this.recording = true;
  }

  clear(): void {
    this.recorded = [];
  }

  get sampleCount(): number {
    return this.recorded.length;
  }

  get samples(): readonly SensorSample[] {
    return this.recorded;
  }

  /** One JSON object per line — streamable, and survives a truncated tail. */
  toJsonl(): string {
    if (this.recorded.length === 0) return '';
    return this.recorded.map((s) => JSON.stringify(s)).join('\n') + '\n';
  }
}
