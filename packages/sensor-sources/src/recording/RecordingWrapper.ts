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

  constructor(private readonly inner: SensorSource) {}

  get capabilities(): SensorSourceCapabilities {
    return this.inner.capabilities;
  }

  onSample(cb: (s: SensorSample) => void): void {
    this.inner.onSample((s) => {
      if (this.recording) this.recorded.push(s);
      cb(s);
    });
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
    return this.recorded.map((s) => JSON.stringify(s)).join('\n') + '\n';
  }
}
