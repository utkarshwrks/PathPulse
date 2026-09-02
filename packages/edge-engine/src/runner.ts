import { NavigationEngine, type NavigationState } from '@pathpulse/nav-core';
import type { EdgeSource } from './sources/types.js';
import { GRADES, type ImuGrade } from './grades.js';

export interface RunnerOptions {
  source: EdgeSource;
  grade: ImuGrade;
  /** Target output rate, Hz. The PS asks for ~200 on the edge engine. */
  rateHz: number;
  /** Stop after this many samples. 0 means "until the source is exhausted". */
  maxSamples?: number;
  /** Called for every emitted state. Keep it cheap — it is inside the loop. */
  onState?: (s: NavigationState) => void;
}

export interface RunnerReport {
  sourceName: string;
  grade: ImuGrade;
  gradeLabel: string;
  targetRateHz: number;
  samples: number;
  /** Simulated duration covered, seconds — sample count / target rate. */
  streamSeconds: number;
  /** Actual wall-clock time the run took, seconds. */
  wallSeconds: number;
  /**
   * Sustained throughput, Hz: how fast this machine can actually run the
   * estimator. Above the target means the rate is achievable with headroom.
   */
  achievedRateHz: number;
  /** Mean time spent inside engine.update(), milliseconds. */
  meanLatencyMs: number;
  /** Worst single update, milliseconds. The number that decides a rate. */
  maxLatencyMs: number;
  /** 99th percentile update, milliseconds. */
  p99LatencyMs: number;
  /** Headroom: how many times faster than real time the engine ran. */
  realTimeFactor: number;
  finalState: NavigationState | null;
}

/**
 * Drives nav-core from an external stream and measures whether the rate is
 * actually met.
 *
 * ★ THE ENGINE OWNS THE CLOCK HERE, AND THAT IS THE WHOLE DIFFERENCE ★
 * In the phone build the sensors decide when they fire and the app reacts. Off
 * the phone the requirement is to *sustain* a rate, so the loop is driven and
 * the source is pulled. That also means a benchmark can run ten minutes of
 * 200 Hz data in a fraction of a second, which is what makes this measurable
 * in CI rather than only on a bench.
 *
 * ★ WHAT IS MEASURED, AND WHAT IS NOT ★
 * `meanLatencyMs` times `engine.update()` alone — the navigation mathematics.
 * It does not include reading a serial port or a socket, because those are
 * properties of somebody's hardware and would make the figure unreproducible.
 * The claim this supports is therefore "the estimator is not the bottleneck",
 * which is the honest and checkable one. Whether a given IMU can be *read* at
 * 200 Hz is a question about that IMU.
 */
export async function runEdge(opts: RunnerOptions): Promise<RunnerReport> {
  const { source, grade, rateHz } = opts;
  if (!(rateHz > 0)) throw new Error(`rateHz must be positive, got ${rateHz}`);
  const periodMs = 1000 / rateHz;
  const engine = new NavigationEngine();

  await source.open?.();

  const latencies: number[] = [];
  let samples = 0;
  let finalState: NavigationState | null = null;
  const limit = opts.maxSamples ?? 0;
  const wallStart = performance.now();

  try {
    for (;;) {
      if (limit > 0 && samples >= limit) break;
      const tMs = samples * periodMs;
      const sample = await source.next(tMs);
      if (!sample) break;

      const t0 = performance.now();
      const state = engine.update(sample);
      latencies.push(performance.now() - t0);

      finalState = state;
      samples++;
      opts.onState?.(state);
    }
  } finally {
    await source.close?.();
  }

  const wallSeconds = (performance.now() - wallStart) / 1000;
  const streamSeconds = samples / rateHz;
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    sourceName: source.name,
    grade,
    gradeLabel: GRADES[grade].label,
    targetRateHz: rateHz,
    samples,
    streamSeconds,
    wallSeconds,
    // Guard the degenerate case: a run too fast to time must not report
    // Infinity, which would look like a spectacular result rather than a
    // measurement that did not happen.
    achievedRateHz: wallSeconds > 0 ? samples / wallSeconds : Number.NaN,
    meanLatencyMs: latencies.length ? sum / latencies.length : Number.NaN,
    maxLatencyMs: sorted.length ? sorted[sorted.length - 1]! : Number.NaN,
    p99LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.99)]! : Number.NaN,
    realTimeFactor: wallSeconds > 0 ? streamSeconds / wallSeconds : Number.NaN,
    finalState,
  };
}
