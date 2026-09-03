/**
 * Phase 13, Model 2 — the motion state classifier.
 *
 * ★ WHAT THE PROBLEM STATEMENT ACTUALLY ASKS FOR ★
 *
 *   "dynamically detect and filter out non-navigation motions such as engine
 *    idling vibrations, pothole shocks, bumps"
 *
 * That is a classification problem stated in prose. Phase 4 answers part of it
 * with thresholds — `StationarityDetector` compares accelerometer variance and
 * gyro magnitude against fixed numbers — and thresholds are exactly as good as
 * the vehicle they were tuned on. A diesel idling at 800 rpm shakes harder
 * than a petrol hatchback doing 30 km/h on a smooth road, and no single
 * variance cut separates those two. A pothole is a half-second impulse that
 * looks, to a variance test, like the vehicle suddenly started moving.
 *
 * So: eight classes, one second of IMU, a small 1D-CNN. The classes are chosen
 * for what the ENGINE can do differently, not for what is easy to label —
 * every one of them changes a decision:
 *
 *   STATIONARY     zero velocity is a fact. ZUPT, and harvest the bias.
 *   IDLING         engine running, vehicle not moving. Still a ZUPT — and the
 *                  case thresholds get wrong most often, because the engine's
 *                  vibration is the signal they mistake for motion.
 *   STRAIGHT       nothing special; the ordinary case.
 *   TURNING_LEFT   gyro is carrying real information; trust it, and do not let
 *   TURNING_RIGHT  the lateral acceleration of the corner be read as a mount
 *                  error by the alignment engine.
 *   ACCELERATING   longitudinal specific force is real, not tilt.
 *   BRAKING        likewise, and the case where a stop is about to happen.
 *   POTHOLE_EVENT  an impulse that is not vehicle motion. Reject the sample.
 *
 * ★ AND IT MUST BE ABLE TO SAY NOTHING ★
 * A classifier that is 40 % confident across three classes has told you
 * nothing, and acting on its argmax is worse than acting on the thresholds it
 * replaced — because the thresholds at least fail the same way every time.
 * `MotionGate` below holds a prediction to a confidence floor and to a
 * consecutive-agreement count before the engine is allowed to act on it.
 */
import { ML_CHANNELS, ML_SAMPLE_RATE_HZ } from './speedModel.js';
import { parseCnnWeights, runCnn, type SpeedCnnWeights } from './cnn.js';

/**
 * One second of IMU at 10 Hz.
 *
 * Long enough to contain a whole pothole impulse and most of a gear change,
 * short enough that a turn is not averaged together with the straight before
 * it. The speed regressor uses two seconds because speed changes slowly; a
 * motion STATE changes in a few hundred milliseconds and a two-second window
 * would report the state the vehicle was in a second ago.
 */
export const MOTION_WINDOW_SAMPLES = 10;
export const MOTION_SAMPLE_RATE_HZ = ML_SAMPLE_RATE_HZ;
export const MOTION_CHANNELS = ML_CHANNELS;

/**
 * The classes, in the order the model's output vector uses.
 *
 * ★ THIS ORDER IS A CONTRACT ★ It must match `MOTION_STATES` in
 * ml/config.py exactly. Reordering it silently relabels every prediction —
 * the model would still be 90 % accurate and every answer would be wrong.
 */
export const MOTION_STATES = [
  'STATIONARY',
  'IDLING',
  'STRAIGHT',
  'TURNING_LEFT',
  'TURNING_RIGHT',
  'ACCELERATING',
  'BRAKING',
  'POTHOLE_EVENT',
] as const;

export type MotionState = (typeof MOTION_STATES)[number];

export interface MotionPrediction {
  state: MotionState;
  /** Probability of the winning class, 0..1. */
  confidence: number;
  /** Full distribution, in `MOTION_STATES` order. */
  probabilities: number[];
}

export interface MotionClassifier {
  isReady(): boolean;
  /** @param samples scaler-normalised (channel, time) — from ImuWindowBuffer. */
  predict(samples: Float32Array): MotionPrediction | null;
  readonly scaler: { mean: number[]; std: number[] };
  readonly lastLatencyMs: number;
}

/** Numerically stable softmax. */
export function softmax(logits: ArrayLike<number>): number[] {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i]!;
    if (Number.isFinite(v) && v > max) max = v;
  }
  if (!Number.isFinite(max)) return new Array(logits.length).fill(1 / logits.length);

  let sum = 0;
  const out = new Array<number>(logits.length);
  for (let i = 0; i < logits.length; i++) {
    // Subtracting the max before exponentiating is not a nicety: raw logits of
    // 800 overflow to Infinity and the whole distribution becomes NaN.
    const e = Math.exp((logits[i]! || 0) - max);
    out[i] = e;
    sum += e;
  }
  if (!(sum > 0)) return new Array(logits.length).fill(1 / logits.length);
  for (let i = 0; i < out.length; i++) out[i]! /= sum;
  return out;
}

/** Parse an exported MotionCNN, checked against this file's contract. */
export function parseMotionCnnWeights(raw: unknown): SpeedCnnWeights {
  const w = parseCnnWeights(raw, {
    architecture: 'MotionCNN',
    windowSamples: MOTION_WINDOW_SAMPLES,
  });

  // The output layer has to have exactly one unit per class, or the argmax is
  // indexing into a different taxonomy than the one this file declares.
  const last = w.layers[w.layers.length - 1];
  if (!last || last.type !== 'linear') {
    throw new Error('MotionCNN must end in a linear layer');
  }
  if (last.outFeatures !== MOTION_STATES.length) {
    throw new Error(
      `class mismatch: model emits ${last.outFeatures}, engine knows ${MOTION_STATES.length}`,
    );
  }

  // And the names must match, in order — the one check that catches a model
  // trained against a reordered taxonomy, which is otherwise invisible.
  const classes = (raw as Record<string, unknown>)['classes'];
  if (Array.isArray(classes)) {
    if (classes.length !== MOTION_STATES.length) {
      throw new Error(`model lists ${classes.length} classes, engine knows ${MOTION_STATES.length}`);
    }
    for (let i = 0; i < classes.length; i++) {
      if (classes[i] !== MOTION_STATES[i]) {
        throw new Error(
          `class ${i} is "${String(classes[i])}" in the model and "${MOTION_STATES[i]}" in the engine`,
        );
      }
    }
  }
  return w;
}

/** A classifier backed by the pure-TypeScript network in cnn.ts. */
export class CnnMotionClassifier implements MotionClassifier {
  private latencyMs = Number.NaN;

  constructor(private readonly weights: SpeedCnnWeights) {}

  get scaler(): { mean: number[]; std: number[] } {
    return this.weights.scaler;
  }

  get lastLatencyMs(): number {
    return this.latencyMs;
  }

  isReady(): boolean {
    return this.weights.layers.length > 0;
  }

  predict(samples: Float32Array): MotionPrediction | null {
    const logits = runCnn(this.weights, samples);
    if (!logits || logits.length !== MOTION_STATES.length) return null;

    const probabilities = softmax(logits);
    let best = 0;
    for (let i = 1; i < probabilities.length; i++) {
      if (probabilities[i]! > probabilities[best]!) best = i;
    }
    const confidence = probabilities[best]!;
    if (!Number.isFinite(confidence)) return null;
    return { state: MOTION_STATES[best]!, confidence, probabilities };
  }
}

/** The engine's default: no model loaded, so no opinion. */
export class NullMotionClassifier implements MotionClassifier {
  readonly scaler = { mean: new Array(ML_CHANNELS).fill(0), std: new Array(ML_CHANNELS).fill(1) };
  readonly lastLatencyMs = Number.NaN;
  isReady(): boolean {
    return false;
  }
  predict(): MotionPrediction | null {
    return null;
  }
}

export interface MotionGateConfig {
  /**
   * Below this probability the prediction is discarded entirely.
   *
   * A classifier spreading 0.4/0.35/0.25 across three classes has not
   * identified anything, and its argmax is a coin flip dressed as a decision.
   */
  minConfidence: number;
  /**
   * Consecutive agreeing predictions before a state change is accepted.
   *
   * ★ WHY A STATE MACHINE AND NOT AN ARGMAX ★ At 10 Hz a single-frame
   * misclassification of STATIONARY zeroes a real velocity, teaches the bias
   * estimators from a moving vehicle, and does it ten times a second. The
   * damage from one wrong ZUPT is far larger than from one missed one, so the
   * asymmetry is built in rather than hoped for.
   */
  agreement: number;
  /**
   * A POTHOLE_EVENT is accepted on a single frame.
   *
   * The asymmetry is deliberate and is the opposite of the one above: a
   * pothole IS a single-frame event, requiring three in a row would mean never
   * detecting one, and the cost of a false positive is that one IMU sample is
   * ignored — which is nothing.
   */
  potholeImmediate: boolean;
  /**
   * A higher bar for the classes that trigger a ZERO-VELOCITY UPDATE.
   *
   * ★ SET FROM THE MEASURED PRECISION, NOT FROM TASTE ★
   * On the held-out journey the model's precision for IDLING is 0.70: when it
   * says the vehicle is idling it is right about seven times in ten. Seven in
   * ten is fine for a status line and not fine for a ZUPT, because a ZUPT
   * asserted while moving zeroes a real velocity AND teaches the accelerometer
   * bias estimator from a moving vehicle — an error that outlives the sample
   * that caused it.
   *
   * The consequences are asymmetric, so the thresholds are too. A missed stop
   * costs one un-harvested calibration at a red light; there will be another
   * one in a minute.
   */
  stoppedMinConfidence: number;
}

export const DEFAULT_MOTION_GATE_CONFIG: MotionGateConfig = {
  minConfidence: 0.6,
  agreement: 3,
  potholeImmediate: true,
  stoppedMinConfidence: 0.85,
};

export interface MotionVerdict {
  /** The accepted state, or null while nothing has been confirmed. */
  state: MotionState | null;
  confidence: number;
  /** True on the frames a pothole impulse was detected. */
  pothole: boolean;
  /**
   * True only when a stopped state is confident enough to act on — see
   * `stoppedMinConfidence`. Separate from `state` because the engine displays
   * the state and ACTS on this, and the two must not be confused.
   */
  stoppedConfidently: boolean;
  /** The raw per-frame prediction, for the debug panel. */
  raw: MotionPrediction | null;
}

const EMPTY_VERDICT: MotionVerdict = {
  state: null,
  confidence: 0,
  pothole: false,
  stoppedConfidently: false,
  raw: null,
};

/**
 * Turns a stream of per-frame predictions into a state the engine may act on.
 */
export class MotionGate {
  private config: MotionGateConfig;
  private accepted: MotionState | null = null;
  private candidate: MotionState | null = null;
  private streak = 0;
  private lastConfidence = 0;

  constructor(config: Partial<MotionGateConfig> = {}) {
    this.config = { ...DEFAULT_MOTION_GATE_CONFIG, ...config };
  }

  setConfig(patch: Partial<MotionGateConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  get state(): MotionState | null {
    return this.accepted;
  }

  push(p: MotionPrediction | null): MotionVerdict {
    if (!p || p.confidence < this.config.minConfidence) {
      // An unconfident frame breaks a streak but does not revoke the state
      // already accepted: losing confidence for one window is not evidence
      // that the vehicle did something else.
      this.candidate = null;
      this.streak = 0;
      return { ...EMPTY_VERDICT, state: this.accepted, confidence: this.lastConfidence, raw: p };
    }

    this.lastConfidence = p.confidence;

    if (p.state === 'POTHOLE_EVENT' && this.config.potholeImmediate) {
      // Reported, but never latched as the vehicle's state — a pothole is an
      // event that happens TO a vehicle that is otherwise doing something else.
      return {
        state: this.accepted,
        confidence: p.confidence,
        pothole: true,
        stoppedConfidently: false,
        raw: p,
      };
    }

    if (p.state === this.candidate) this.streak++;
    else {
      this.candidate = p.state;
      this.streak = 1;
    }

    if (this.streak >= this.config.agreement) this.accepted = this.candidate;

    return {
      state: this.accepted,
      confidence: p.confidence,
      pothole: false,
      stoppedConfidently:
        isStoppedState(this.accepted) &&
        p.state === this.accepted &&
        p.confidence >= this.config.stoppedMinConfidence,
      raw: p,
    };
  }

  reset(): void {
    this.accepted = null;
    this.candidate = null;
    this.streak = 0;
    this.lastConfidence = 0;
  }
}

/** True for the states in which the vehicle is not travelling. */
export function isStoppedState(s: MotionState | null): boolean {
  return s === 'STATIONARY' || s === 'IDLING';
}

/** True while the vehicle is cornering, where gyro carries the information. */
export function isTurningState(s: MotionState | null): boolean {
  return s === 'TURNING_LEFT' || s === 'TURNING_RIGHT';
}
