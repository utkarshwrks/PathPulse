/**
 * Phase 13, Model 4 — the GNSS quality classifier.
 *
 * ★ THE FOURTH AND LAST MODEL THE PROBLEM STATEMENT ASKS FOR ★
 *
 *   input:  satellite count, C/N0 distribution, DOP, position jump history,
 *           IMU-GNSS disagreement
 *   output: fix quality (GOOD / MULTIPATH / SPOOFED / LOST)
 *   use:    mode transition decisions, and spoofing detection
 *
 * ★ WHY THIS IS NOT A REPLACEMENT FOR detect/spoofing.ts ★
 *
 * Phase 9D's `SpoofingDetector` is three hand-written rules — a static hold, an
 * implausible jump, a constellation collapse — and each one is a statement
 * about physics that a judge can read and check. That is worth keeping, and it
 * ships enabled.
 *
 * What it cannot do is combine weak evidence. Multipath in an urban canyon
 * does not trip any single rule: the satellite count is a little low, the C/N0
 * a little poor, the fix jitters a little more than usual, and the IMU
 * disagrees a little. Four "a littles" that each stay under a threshold, and
 * together are unmistakable. That is precisely what a classifier is for.
 *
 * ★ AND WHAT IT IS ALLOWED TO DO ★
 *
 * Advisory. It may lower confidence, it may make the state machine leave GNSS
 * sooner, and it may not gate a fix. `detect/spoofing.ts` carries the long
 * argument for that rule and it applies here with more force, not less: a
 * detector that rejects the fix it is suspicious of converts a false positive
 * into a navigation failure, and a learned detector has more ways to be
 * confidently wrong than three rules do.
 */
import { parseCnnWeights, runCnn, type SpeedCnnWeights } from './cnn.js';
import { softmax } from './motionModel.js';

/**
 * The classes, in the order the model's output vector uses.
 *
 * ★ THIS ORDER IS A CONTRACT ★ It must match `GNSS_QUALITY_CLASSES` in
 * ml/config.py. A reordered list still runs, still looks confident, and calls
 * a good fix spoofed.
 */
export const GNSS_QUALITY_CLASSES = ['GOOD', 'MULTIPATH', 'SPOOFED', 'LOST'] as const;
export type GnssQuality = (typeof GNSS_QUALITY_CLASSES)[number];

/**
 * The feature vector, in order. This IS the contract.
 *
 * Every one is computable on the phone at the instant a fix arrives. A feature
 * that needs the future, or a map, or the answer, is a feature that cannot be
 * used however well it predicts in training.
 */
export const GNSS_QUALITY_FEATURES = [
  /** Satellites used in the fix. The single strongest term, and rightly. */
  'satCount',
  /** How far the count has fallen below its own recent baseline. */
  'satDropFromBaseline',
  /** Mean carrier-to-noise density, dB-Hz. Low means signals off concrete. */
  'meanCn0',
  /** Spread of C/N0 across satellites. A reflected signal is an outlier. */
  'cn0Spread',
  /** The receiver's own reported accuracy, m. */
  'accuracyM',
  /** How much worse that is than its own recent baseline. */
  'accuracyRatio',
  /** Distance from the previous fix, m — the jump term. */
  'jumpM',
  /** That jump expressed as an implied speed, m/s. */
  'impliedSpeedMps',
  /** How far the implied speed disagrees with what the IMU believes, m/s. */
  'imuDisagreementMps',
  /** Seconds since the previous fix. A gap is itself evidence. */
  'fixIntervalS',
  /** Horizontal dilution of precision, when the receiver reports it. */
  'hdop',
] as const;

export type GnssQualityFeatureName = (typeof GNSS_QUALITY_FEATURES)[number];
export const GNSS_QUALITY_FEATURE_COUNT = GNSS_QUALITY_FEATURES.length;

export interface GnssQualityInput {
  satCount: number;
  satBaseline: number;
  meanCn0: number;
  cn0Spread: number;
  accuracyM: number;
  accuracyBaselineM: number;
  jumpM: number;
  fixIntervalS: number;
  drSpeedMps: number;
  hdop: number;
}

/**
 * A usable number, or the fallback.
 *
 * Takes `unknown` rather than `number` on purpose: half the callers are
 * reading optional fields off a fix the receiver may simply not have filled
 * in, and a signature that pretended otherwise would push a `?? 0` to every
 * call site — which is the same fallback written eleven times instead of once.
 */
const finite = (v: number | undefined, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Build the feature vector. One definition, used by training and the engine. */
export function buildGnssQualityFeatures(input: GnssQualityInput): Float32Array {
  const interval = Math.max(0.05, finite(input.fixIntervalS, 1));
  const jump = Math.max(0, finite(input.jumpM));
  const implied = jump / interval;
  const accuracy = Math.max(0.1, finite(input.accuracyM, 10));
  const baseline = Math.max(0.1, finite(input.accuracyBaselineM, accuracy));

  const out = new Float32Array(GNSS_QUALITY_FEATURE_COUNT);
  out[0] = finite(input.satCount);
  out[1] = Math.max(0, finite(input.satBaseline) - finite(input.satCount));
  // 0 dB-Hz is not a plausible reading; it means "the receiver did not say".
  // Substituting a typical open-sky value keeps a missing field from looking
  // like the worst possible signal, which is how an absent sensor becomes a
  // permanent MULTIPATH verdict.
  out[2] = finite(input.meanCn0, 35);
  out[3] = finite(input.cn0Spread);
  out[4] = accuracy;
  out[5] = accuracy / baseline;
  out[6] = jump;
  out[7] = implied;
  out[8] = Math.abs(implied - Math.max(0, finite(input.drSpeedMps)));
  out[9] = interval;
  out[10] = finite(input.hdop, 1);
  return out;
}

export interface GnssQualityPrediction {
  quality: GnssQuality;
  confidence: number;
  probabilities: number[];
}

export interface GnssQualityClassifier {
  isReady(): boolean;
  predict(features: Float32Array): GnssQualityPrediction | null;
  readonly scaler: { mean: number[]; std: number[] };
}

export class NullGnssQualityClassifier implements GnssQualityClassifier {
  readonly scaler = {
    mean: new Array(GNSS_QUALITY_FEATURE_COUNT).fill(0),
    std: new Array(GNSS_QUALITY_FEATURE_COUNT).fill(1),
  };
  isReady(): boolean {
    return false;
  }
  predict(): GnssQualityPrediction | null {
    return null;
  }
}

/** Parse an exported GnssQualityMLP, checked against this file's contract. */
export function parseGnssQualityWeights(raw: unknown): SpeedCnnWeights {
  const w = parseCnnWeights(raw, {
    architecture: 'GnssQualityMLP',
    windowSamples: 1,
    channels: GNSS_QUALITY_FEATURE_COUNT,
  });

  const last = w.layers[w.layers.length - 1];
  if (!last || last.type !== 'linear' || last.outFeatures !== GNSS_QUALITY_CLASSES.length) {
    throw new Error(
      `GnssQualityMLP must end in a linear layer with ${GNSS_QUALITY_CLASSES.length} outputs`,
    );
  }

  const classes = (raw as Record<string, unknown>)['classes'];
  if (Array.isArray(classes)) {
    for (let i = 0; i < GNSS_QUALITY_CLASSES.length; i++) {
      if (classes[i] !== GNSS_QUALITY_CLASSES[i]) {
        throw new Error(
          `class ${i} is "${String(classes[i])}" in the model and "${GNSS_QUALITY_CLASSES[i]}" in the engine`,
        );
      }
    }
  }

  const names = (raw as Record<string, unknown>)['channels'];
  if (Array.isArray(names)) {
    for (let i = 0; i < GNSS_QUALITY_FEATURES.length; i++) {
      if (names[i] !== GNSS_QUALITY_FEATURES[i]) {
        throw new Error(
          `feature ${i} is "${String(names[i])}" in the model and "${GNSS_QUALITY_FEATURES[i]}" in the engine`,
        );
      }
    }
  }
  return w;
}

/** An MLP over the feature vector, run by the shared network evaluator. */
export class MlpGnssQualityClassifier implements GnssQualityClassifier {
  constructor(private readonly weights: SpeedCnnWeights) {}

  get scaler(): { mean: number[]; std: number[] } {
    return this.weights.scaler;
  }

  isReady(): boolean {
    return this.weights.layers.length > 0;
  }

  predict(features: Float32Array): GnssQualityPrediction | null {
    if (features.length !== GNSS_QUALITY_FEATURE_COUNT) return null;
    const { mean, std } = this.weights.scaler;
    const scaled = new Float32Array(GNSS_QUALITY_FEATURE_COUNT);
    for (let i = 0; i < GNSS_QUALITY_FEATURE_COUNT; i++) {
      const s = std[i] ?? 1;
      scaled[i] = (features[i]! - (mean[i] ?? 0)) / (s === 0 ? 1 : s);
    }

    const logits = runCnn(this.weights, scaled);
    if (!logits || logits.length !== GNSS_QUALITY_CLASSES.length) return null;

    const probabilities = softmax(logits);
    let best = 0;
    for (let i = 1; i < probabilities.length; i++) {
      if (probabilities[i]! > probabilities[best]!) best = i;
    }
    const confidence = probabilities[best]!;
    if (!Number.isFinite(confidence)) return null;
    return { quality: GNSS_QUALITY_CLASSES[best]!, confidence, probabilities };
  }
}

/**
 * Running baselines and the previous fix, so the caller does not have to keep
 * them — and so training and inference compute them identically.
 */
export class GnssQualityTracker {
  private satBaseline: number | null = null;
  private accuracyBaseline: number | null = null;
  private previous: { t: number; lat: number; lon: number } | null = null;

  /** @returns the feature vector for this fix, or null if it is the first. */
  push(fix: {
    t: number;
    lat: number;
    lon: number;
    accuracyM: number;
    satCount?: number;
    meanCn0?: number;
    cn0Spread?: number;
    hdop?: number;
    drSpeedMps: number;
  }): Float32Array | null {
    const sats = finite(fix.satCount, 0);
    // ★ THE BASELINE IS SLOW, AND THAT IS THE POINT ★ It is the answer to
    // "worse than what?". A count of six is fine on a receiver that has been
    // seeing seven and alarming on one that has been seeing fourteen, and a
    // fast baseline would follow the degradation down and never notice.
    this.satBaseline = this.satBaseline === null ? sats : this.satBaseline * 0.98 + sats * 0.02;
    const accuracy = Math.max(0.1, finite(fix.accuracyM, 10));
    this.accuracyBaseline =
      this.accuracyBaseline === null
        ? accuracy
        : this.accuracyBaseline * 0.98 + accuracy * 0.02;

    const previous = this.previous;
    this.previous = { t: fix.t, lat: fix.lat, lon: fix.lon };
    if (!previous) return null;

    const mPerLat = 111_320;
    const mPerLon = 111_320 * Math.cos((fix.lat * Math.PI) / 180);
    const jumpM = Math.hypot(
      (fix.lon - previous.lon) * mPerLon,
      (fix.lat - previous.lat) * mPerLat,
    );

    return buildGnssQualityFeatures({
      satCount: sats,
      satBaseline: this.satBaseline,
      meanCn0: finite(fix.meanCn0, 35),
      cn0Spread: finite(fix.cn0Spread, 0),
      accuracyM: accuracy,
      accuracyBaselineM: this.accuracyBaseline,
      jumpM,
      fixIntervalS: Math.max(0.05, (fix.t - previous.t) / 1000),
      drSpeedMps: fix.drSpeedMps,
      hdop: finite(fix.hdop, 1),
    });
  }

  reset(): void {
    this.satBaseline = null;
    this.accuracyBaseline = null;
    this.previous = null;
  }
}
