import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CnnSpeedPredictor,
  NavigationEngine,
  parseSpeedCnnWeights,
  type NavigationState,
  type RoadGraph,
  type SensorSample,
} from '@pathpulse/nav-core';
import { ROOT } from './paths.js';
import {
  computeMetrics,
  decomposeError,
  truthAt,
  truthHeadingAt,
  type EvalMetrics,
  type TruthPoint,
} from './metrics.js';

/**
 * The shipped weights, parsed once.
 *
 * The same file the APK serves, read straight off disk — so a benchmark and a
 * handset cannot disagree about which network they are scoring.
 */
let speedModel: { predictor: CnnSpeedPredictor; scaler: { mean: number[]; std: number[] } } | null =
  null;

export function loadSpeedModel(): [CnnSpeedPredictor, { mean: number[]; std: number[] }] {
  if (!speedModel) {
    const raw = JSON.parse(
      readFileSync(join(ROOT, 'apps/web/public/models/speed_model.json'), 'utf8'),
    ) as { scaler: { mean: number[]; std: number[] } };
    speedModel = { predictor: new CnnSpeedPredictor(parseSpeedCnnWeights(raw)), scaler: raw.scaler };
  }
  return [speedModel.predictor, speedModel.scaler];
}

export interface RunOptions {
  configName: string;
  logName: string;
  /** Engine flags. Anything omitted takes the engine default. */
  engineConfig: Record<string, unknown>;
  outageStartMs: number;
  outageDurationMs: number;
  roadGraph?: RoadGraph | null;
  /**
   * Run the shipped speed model, as the handset does.
   *
   * ★ DEFAULT OFF, AND THAT IS A STATEMENT ABOUT THE LOGS, NOT THE MODEL ★
   *
   * The network was trained on IO-VNBD: real accelerometer and gyroscope off a
   * real phone in a real car. Tier S logs are SIMULATED — their IMU is
   * synthesised by a physics model — so the windows handed to the network there
   * are out of its training domain in exactly the way a portrait mount was, and
   * it answers anyway. Measured: switching it on takes Tier S `full` from 6.1 %
   * mean drift to 71.2 %, and the drawn marker from 0.3 m off-road to 14.7 m.
   * That number describes the simulator, not the estimator.
   *
   * On Tier R, which is real vehicle sensors, it belongs and it pays: 38.3 % to
   * 30.9 % mean, p90 88.8 % to 70.5 %, worst 107.2 % to 73.0 %.
   *
   * So it is on where it is in domain and off where it is not, and the two are
   * never averaged — the same rule Tier S and Tier R already live under. What
   * this must never become is a switch flipped to whichever produces the better
   * headline, which is why the reason is written here next to the numbers.
   */
  speedModel?: boolean;
  /** Phase 13, Model 3: record a training row for every dead-reckoning sample. */
  collectDriftRows?: boolean;
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
  /**
   * Times the error-state filter re-seeded itself after three consecutive
   * fixes ran gated.
   *
   * Reported by the harness because `eskf` shipping on makes its reset rate a
   * thing that has to be watched: rare is the escape hatch working, frequent
   * is the GNSS gate mis-tuned for real fix noise, and the two are
   * indistinguishable without a count.
   */
  eskfResets: number;
  /**
   * Phase 13, Model 3: one row per dead-reckoning sample — the engine's own
   * feature vector, and the error it turned out to have.
   *
   * Collected here rather than reconstructed afterwards because the features
   * are only knowable AT the sample: covariance, bias estimates and counters
   * all move, and a row rebuilt from the emitted state would be a different
   * vector than the one the engine will read at inference. Only populated when
   * `collectDriftRows` is set, since it is a few thousand rows per run.
   */
  driftRows: DriftRow[];
}

export interface DriftRow {
  t: number;
  features: number[];
  /** The estimate's error along the direction of travel, m. Positive = ahead. */
  alongM: number;
  /** And across it, m. Positive = right of the truth. */
  crossM: number;
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
  // ★ THE BENCHMARK COULD NOT RUN WHAT THE PHONE RUNS ★
  //
  // `useMlSpeed` has been on in every config for phases and this harness never
  // supplied a predictor, so the engine fell back to NullSpeedPredictor and
  // every published figure — Tier S and Tier R alike — measured an estimator
  // with the speed model switched off. The phone was running a configuration
  // the numbers did not describe, and nothing could tell.
  //
  // The network is pure TypeScript in nav-core precisely so it can run here
  // (that is what the purity rule buys) and the weights are a JSON file Node
  // can read, so this was an omission rather than a limitation. See
  // `speedModel` for why it is nonetheless off on the simulated logs.
  if (opts.speedModel) engine.setSpeedPredictor(...loadSpeedModel());
  if (opts.roadGraph) engine.setRoadGraph(opts.roadGraph);

  const states: NavigationState[] = [];
  const outageStates: NavigationState[] = [];
  const driftRows: DriftRow[] = [];
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

    // ★ THE FEATURES ARE READ FROM THE ENGINE, NOT REBUILT FROM THE STATE ★
    // Covariance, bias estimates and the outage counters all move sample by
    // sample. A row reconstructed afterwards from the emitted NavigationState
    // would be a different vector than the one the engine reads at inference,
    // and the model would be trained on a world that does not exist at run
    // time. Same lesson as Model 2's class list, applied before it cost
    // anything this time.
    if (opts.collectDriftRows && inOutage && state.mode === 'DEAD_RECKONING') {
      const truthHere = truthAt(truth, state.t);
      if (truthHere) {
        const { alongM, crossM } = decomposeError(
          state.position,
          truthHere,
          truthHeadingAt(truth, state.t),
        );
        driftRows.push({
          t: state.t,
          features: Array.from(engine.driftFeatures),
          alongM,
          crossM,
        });
      }
    }
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
    driftRows,
    eskfResets: diagnostics.eskfResets,
  };
}
