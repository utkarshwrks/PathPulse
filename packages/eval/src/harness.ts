import {
  NavigationEngine,
  type NavigationState,
  type RoadGraph,
  type SensorSample,
} from '@pathpulse/nav-core';
import { computeMetrics, type EvalMetrics, type TruthPoint } from './metrics.js';

export interface RunOptions {
  configName: string;
  logName: string;
  /** Engine flags. Anything omitted takes the engine default. */
  engineConfig: Record<string, unknown>;
  outageStartMs: number;
  outageDurationMs: number;
  roadGraph?: RoadGraph | null;
}

export interface RunResult {
  metrics: EvalMetrics;
  states: NavigationState[];
  truth: TruthPoint[];
  /**
   * What the alignment engine concluded about the mount by the end of the run,
   * degrees, or null if it never had enough evidence. Phase 12's evaluation
   * needs to report how close it got, not only what it cost.
   */
  alignmentDeg: number | null;
}

/** Parse a JSONL log. Malformed lines are skipped, not fatal. */
export function parseJsonl(text: string): SensorSample[] {
  const out: SensorSample[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SensorSample;
      if (typeof parsed.t === 'number' && Number.isFinite(parsed.t)) out.push(parsed);
    } catch {
      // A truncated final line is the normal way a recording ends.
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Every GNSS position in the log, in order. This is the ground truth. */
export function extractTruth(samples: readonly SensorSample[]): TruthPoint[] {
  const truth: TruthPoint[] = [];
  for (const s of samples) {
    if (s.gnss && Number.isFinite(s.gnss.lat) && Number.isFinite(s.gnss.lon)) {
      truth.push({ t: s.t, lat: s.gnss.lat, lon: s.gnss.lon });
    }
  }
  return truth;
}

/**
 * Replay a log with an artificial GNSS outage and score the result.
 *
 * ★ THE GROUND-TRUTH TRICK, AND WHY IT IS HONEST ★
 *
 * You cannot measure drift in a tunnel, because in a tunnel there is nothing to
 * measure against. So drive somewhere with good GNSS, record everything, and
 * then delete GNSS from a window of the recording in software. The estimator
 * sees exactly what it would see in a tunnel; we still hold the positions it
 * cannot see. Reproducible, no tunnel required, and — crucially — the truth was
 * never available to the estimator, so it cannot have been fitted to.
 *
 * The outage removes the `gnss` field entirely rather than zeroing or faking
 * it. That is the shape a real outage has, and it is what the state machine
 * distinguishes: an absent fix and a zeroed one are different signals.
 */
export function runEval(samples: readonly SensorSample[], opts: RunOptions): RunResult {
  const truth = extractTruth(samples);
  const outageEndMs = opts.outageStartMs + opts.outageDurationMs;

  const engine = new NavigationEngine(opts.engineConfig as never);
  if (opts.roadGraph) engine.setRoadGraph(opts.roadGraph);

  const states: NavigationState[] = [];
  const outageStates: NavigationState[] = [];
  let recoveredAtMs: number | null = null;

  for (const sample of samples) {
    const inOutage = sample.t >= opts.outageStartMs && sample.t < outageEndMs;

    let fed: SensorSample = sample;
    if (inOutage && sample.gnss) {
      // Strip GNSS. Note the rest of the sample — including the IMU — passes
      // through untouched: dead reckoning must still have something to run on.
      const { gnss: _dropped, ...rest } = sample;
      fed = rest;
    }

    const state = engine.update(fed);
    states.push(state);

    if (inOutage) outageStates.push(state);
    // Recovery is complete when the machine settles back on GNSS, not when the
    // first fix arrives — the slew is still running in between.
    if (!inOutage && sample.t >= outageEndMs && recoveredAtMs === null && state.mode === 'GNSS') {
      recoveredAtMs = state.t;
    }
  }

  const events = engine.events.all;
  const diagnostics = engine.diagnostics;

  const metrics = computeMetrics({
    configName: opts.configName,
    log: opts.logName,
    outageStartMs: opts.outageStartMs,
    outageDurationMs: opts.outageDurationMs,
    outageStates,
    truth,
    recoveredAtMs,
    zuptTriggers: diagnostics.zuptTriggers,
    zaruTriggers: diagnostics.zaruTriggers,
    roadSnapAppliedFraction: diagnostics.roadSnapAppliedFraction,
    positionResets: events.filter((e) => e.type === 'POSITION_RESET').length,
  });

  const align = diagnostics.alignment;
  return {
    metrics,
    states,
    truth,
    alignmentDeg: align.isCalibrated ? (align.yawOffsetRad * 180) / Math.PI : null,
  };
}
