import type { SensorSample } from '@pathpulse/nav-core';

/**
 * An external inertial stream, pulled rather than pushed.
 *
 * ★ WHY THIS IS NOT @pathpulse/sensor-sources' SensorSource ★
 * That interface is callback-driven — `onSample(cb)` — because in a browser
 * the sensors decide when they fire and the app can only react. Off the phone
 * the relationship inverts: the engine owns the clock, because the whole
 * requirement is to *sustain* a rate rather than to accept whatever arrives.
 * A pull interface lets the runner drive 200 Hz deterministically and lets a
 * replay run as fast as the CPU allows instead of in real time, which is what
 * makes the benchmark honest and the tests instant.
 *
 * Deliberately tiny: anything that can produce the next sample can be an edge
 * source, including hardware this project has never seen.
 */
export interface EdgeSource {
  /** Short name for logs and the report. */
  readonly name: string;
  /** Prepare the stream. Called once, before the first `next()`. */
  open?(): Promise<void> | void;
  /**
   * The next sample, or null when the stream is finished.
   *
   * `tMs` is the monotonic timestamp the runner wants this sample stamped
   * with. A generated source should honour it exactly; a recorded source
   * carries its own timestamps and ignores it.
   */
  next(tMs: number): Promise<SensorSample | null> | SensorSample | null;
  /** Release anything held. Always called, including on error. */
  close?(): Promise<void> | void;
}
