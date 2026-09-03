/**
 * Phase 13, Model 3 — AI drift-residual correction.
 *
 * ★ THE THIRD PLACE THE PROBLEM STATEMENT ASKS FOR AI ★
 *
 *   "AI based fusion model to mitigate drift errors"
 *
 * Phase 8 predicts speed. Phase 13's Model 2 classifies motion. This one
 * predicts the ESTIMATOR'S OWN ERROR and subtracts it.
 *
 * The idea is less strange than it sounds. Dead-reckoning error is not random:
 * it is a systematic function of how long GNSS has been gone, how fast the
 * vehicle is going, how many turns it has taken, how much the gyro bias was
 * estimated at, and how wide the filter thinks its own uncertainty is. Every
 * one of those is available on-device at the moment the correction is needed.
 * If a model can learn "eighty seconds into an outage at motorway speed with
 * two turns behind you, the estimate is typically twelve metres long", then
 * subtracting twelve metres is free accuracy.
 *
 * ★ AND IT MIGHT NOT WORK, WHICH IS WHY THE FEATURES LIVE HERE ★
 *
 * The failure mode of a residual corrector is that it learns the ROUTE rather
 * than the physics, and then confidently mis-corrects on a road it has never
 * seen. The only defence is an honest split — train on one set of drives,
 * measure on another — and reporting the answer either way. See the note in
 * docs/residual.md.
 *
 * `buildDriftFeatures` is deliberately the single place the feature vector is
 * defined. The eval harness calls it to write training rows and the engine
 * calls it to run inference, so the two cannot drift apart. Phase 13's Model 2
 * taught that lesson the expensive way: a contract stated in two places is a
 * contract that will eventually be stated differently in each.
 */
import { parseCnnWeights, runCnn, type SpeedCnnWeights } from './cnn.js';

/**
 * The feature vector, in order. This IS the contract.
 *
 * Every one of these is available on the phone during an outage. Nothing here
 * needs GNSS, a map lookup, or knowledge of the route — a feature the engine
 * cannot produce at the moment of correction is a feature that cannot be used,
 * however well it predicts in training.
 */
export const DRIFT_FEATURES = [
  /** Seconds since the last trusted fix. The dominant term, and it should be. */
  'timeSinceGnssS',
  /** Current speed, m/s. Error accumulates with distance, not with time alone. */
  'speedMps',
  /** Metres travelled since dead reckoning began. */
  'distanceSinceOutageM',
  /** The engine's own along-track uncertainty, m. */
  'covarianceAlongM',
  /** And cross-track, which road snapping bounds and along-track does not. */
  'covarianceCrossM',
  /** Heading uncertainty, degrees — the term that becomes cross-track error. */
  'headingSigmaDeg',
  /** Completed turns since the outage began. Each one is a chance to be wrong. */
  'turnsSinceOutage',
  /** ZUPTs since the outage began. Each one is a free re-anchoring of velocity. */
  'zuptsSinceOutage',
  /** Estimated gyro-Z bias, rad/s. What becomes heading error. */
  'gyroBiasZ',
  /** Magnitude of the estimated accelerometer bias, m/s^2. */
  'accelBiasMag',
  /** 1 when a road is currently matched, 0 otherwise. */
  'roadMatched',
] as const;

export type DriftFeatureName = (typeof DRIFT_FEATURES)[number];
export const DRIFT_FEATURE_COUNT = DRIFT_FEATURES.length;

export interface DriftFeatureInput {
  timeSinceGnssMs: number;
  speedMps: number;
  distanceSinceOutageM: number;
  covarianceAlongM: number;
  covarianceCrossM: number;
  headingSigmaDeg: number;
  turnsSinceOutage: number;
  zuptsSinceOutage: number;
  gyroBiasZ: number;
  accelBiasMag: number;
  roadMatched: boolean;
}

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Build the feature vector. The one definition, used by training and by the engine. */
export function buildDriftFeatures(input: DriftFeatureInput): Float32Array {
  const out = new Float32Array(DRIFT_FEATURE_COUNT);
  out[0] = finite(input.timeSinceGnssMs) / 1000;
  out[1] = finite(input.speedMps);
  out[2] = finite(input.distanceSinceOutageM);
  out[3] = finite(input.covarianceAlongM);
  out[4] = finite(input.covarianceCrossM);
  out[5] = finite(input.headingSigmaDeg);
  out[6] = finite(input.turnsSinceOutage);
  out[7] = finite(input.zuptsSinceOutage);
  out[8] = finite(input.gyroBiasZ);
  out[9] = finite(input.accelBiasMag);
  out[10] = input.roadMatched ? 1 : 0;
  return out;
}

/** Predicted error of the estimate, in the direction of travel, metres. */
export interface DriftResidual {
  alongM: number;
  crossM: number;
}

export interface ResidualCorrector {
  isReady(): boolean;
  predict(features: Float32Array): DriftResidual | null;
  readonly scaler: { mean: number[]; std: number[] };
}

export class NullResidualCorrector implements ResidualCorrector {
  readonly scaler = {
    mean: new Array(DRIFT_FEATURE_COUNT).fill(0),
    std: new Array(DRIFT_FEATURE_COUNT).fill(1),
  };
  isReady(): boolean {
    return false;
  }
  predict(): DriftResidual | null {
    return null;
  }
}

/**
 * How far the correction is allowed to go.
 *
 * ★ A CORRECTOR THAT CAN MOVE THE MARKER ANYWHERE IS NOT A CORRECTOR ★
 * The model is trained on drives that ended; asked about a drive that has gone
 * somewhere those never went, it extrapolates, and a two-layer network
 * extrapolates confidently and linearly to whatever the features imply. Bounded
 * as a FRACTION of the engine's own stated uncertainty rather than as a fixed
 * number of metres, because the honest ceiling on "how wrong could we be" is
 * exactly what the covariance already estimates.
 */
export interface ResidualConfig {
  /** Correction is capped at this multiple of the along/cross covariance. */
  maxFractionOfSigma: number;
  /** And never more than this many metres, whatever the covariance says. */
  maxCorrectionM: number;
}

export const DEFAULT_RESIDUAL_CONFIG: ResidualConfig = {
  maxFractionOfSigma: 1,
  maxCorrectionM: 50,
};

/** Clamp a raw prediction to what the engine's own uncertainty can justify. */
export function clampResidual(
  raw: DriftResidual,
  covariance: { alongM: number; crossM: number },
  config: ResidualConfig = DEFAULT_RESIDUAL_CONFIG,
): DriftResidual {
  const limit = (sigma: number): number =>
    Math.min(
      config.maxCorrectionM,
      Math.max(0, (Number.isFinite(sigma) ? sigma : 0) * config.maxFractionOfSigma),
    );
  const clamp = (v: number, lim: number): number =>
    !Number.isFinite(v) ? 0 : Math.max(-lim, Math.min(lim, v));
  return {
    alongM: clamp(raw.alongM, limit(covariance.alongM)),
    crossM: clamp(raw.crossM, limit(covariance.crossM)),
  };
}

/** Parse an exported ResidualMLP, checked against this file's contract. */
export function parseResidualWeights(raw: unknown): SpeedCnnWeights {
  const w = parseCnnWeights(raw, {
    architecture: 'ResidualMLP',
    // A feature vector, not a time series: one "sample" of eleven channels.
    windowSamples: 1,
    channels: DRIFT_FEATURE_COUNT,
  });

  const last = w.layers[w.layers.length - 1];
  if (!last || last.type !== 'linear' || last.outFeatures !== 2) {
    throw new Error('ResidualMLP must end in a linear layer with 2 outputs (along, cross)');
  }

  // The feature names must match, in order. A model trained against a
  // reordered feature list still runs, still looks confident, and corrects in
  // the wrong direction — the same failure Model 2's class list has.
  const names = (raw as Record<string, unknown>)['channels'];
  if (Array.isArray(names)) {
    for (let i = 0; i < DRIFT_FEATURES.length; i++) {
      if (names[i] !== DRIFT_FEATURES[i]) {
        throw new Error(
          `feature ${i} is "${String(names[i])}" in the model and "${DRIFT_FEATURES[i]}" in the engine`,
        );
      }
    }
  }
  return w;
}

/**
 * The corrector, evaluated by the same pure-TypeScript network runner the two
 * convolutional models use.
 *
 * An MLP is a CNN with no convolutions, so `runCnn` needs no special case: the
 * feature vector enters as eleven channels of length one and every layer in
 * between is a `linear`. One implementation, three models, and the tests that
 * exercise the speed model exercise this one's arithmetic too.
 */
export class MlpResidualCorrector implements ResidualCorrector {
  constructor(private readonly weights: SpeedCnnWeights) {}

  get scaler(): { mean: number[]; std: number[] } {
    return this.weights.scaler;
  }

  isReady(): boolean {
    return this.weights.layers.length > 0;
  }

  predict(features: Float32Array): DriftResidual | null {
    if (features.length !== DRIFT_FEATURE_COUNT) return null;
    const { mean, std } = this.weights.scaler;
    const scaled = new Float32Array(DRIFT_FEATURE_COUNT);
    for (let i = 0; i < DRIFT_FEATURE_COUNT; i++) {
      const s = std[i] ?? 1;
      scaled[i] = (features[i]! - (mean[i] ?? 0)) / (s === 0 ? 1 : s);
    }

    const out = runCnn(this.weights, scaled);
    if (!out || out.length !== 2) return null;
    const alongM = out[0]!;
    const crossM = out[1]!;
    if (!Number.isFinite(alongM) || !Number.isFinite(crossM)) return null;
    return { alongM, crossM };
  }
}
