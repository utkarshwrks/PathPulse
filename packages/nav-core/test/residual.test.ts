/**
 * Phase 13, Model 3 — the drift-residual corrector.
 *
 * ★ THIS MODEL SHIPS DISABLED, AND THESE TESTS ARE WHY IT IS STILL HERE ★
 *
 * Measured with a route-disjoint split, both directions, it does NOT
 * generalise: trained on city outages and asked about highway ones it makes
 * along-track error nearly three times worse, and the other way round eight
 * times worse. The reason is visible in the features — city and highway
 * driving barely overlap in speed, distance or covariance, so a network fitted
 * on one extrapolates on the other, confidently and linearly.
 *
 * What survives is the mechanism and, more importantly, the BOUND: with the
 * engine's clamp in place the same broken model degrades the estimate by 28-49
 * % instead of destroying it by 800 %. That bound is tested here, because the
 * next model to go in this slot will be trained on real drives and the guard
 * has to be trustworthy before it is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESIDUAL_CONFIG,
  DRIFT_FEATURES,
  DRIFT_FEATURE_COUNT,
  MlpResidualCorrector,
  NullResidualCorrector,
  buildDriftFeatures,
  clampResidual,
  parseResidualWeights,
} from '../src/ml/residualModel.js';

const zeros = (n: number): string => Buffer.from(new Float32Array(n).buffer).toString('base64');
const block = (values: number[]): string =>
  Buffer.from(new Float32Array(values).buffer).toString('base64');

const INPUT = {
  timeSinceGnssMs: 45_000,
  speedMps: 18,
  distanceSinceOutageM: 800,
  covarianceAlongM: 40,
  covarianceCrossM: 5,
  headingSigmaDeg: 3,
  turnsSinceOutage: 2,
  zuptsSinceOutage: 1,
  gyroBiasZ: 0.004,
  accelBiasMag: 0.12,
  roadMatched: true,
};

describe('the feature vector', () => {
  it('is the single definition both sides use', () => {
    // ★ THE CONTRACT ★ The eval harness writes training rows from
    // `engine.driftFeatures`, which calls this; the engine reads them at
    // inference through the same function. Two definitions would eventually be
    // two different definitions, which is how Model 2 lost an afternoon.
    expect(DRIFT_FEATURES).toHaveLength(DRIFT_FEATURE_COUNT);
    expect(new Set(DRIFT_FEATURES).size).toBe(DRIFT_FEATURE_COUNT);
  });

  it('puts each value where its name says', () => {
    const f = buildDriftFeatures(INPUT);
    expect(f).toHaveLength(DRIFT_FEATURE_COUNT);
    expect(f[DRIFT_FEATURES.indexOf('timeSinceGnssS')]).toBeCloseTo(45, 6);
    expect(f[DRIFT_FEATURES.indexOf('speedMps')]).toBeCloseTo(18, 6);
    expect(f[DRIFT_FEATURES.indexOf('turnsSinceOutage')]).toBe(2);
    expect(f[DRIFT_FEATURES.indexOf('roadMatched')]).toBe(1);
  });

  it('converts milliseconds to seconds, once, here', () => {
    // The unit conversion lives in exactly one place. IO-VNBD's own time
    // column cost Model 2 a training run for exactly this reason.
    expect(buildDriftFeatures({ ...INPUT, timeSinceGnssMs: 1000 })[0]).toBeCloseTo(1, 9);
  });

  it('turns a non-finite input into zero rather than poisoning the network', () => {
    const f = buildDriftFeatures({ ...INPUT, speedMps: Number.NaN, gyroBiasZ: Infinity });
    expect(f.every(Number.isFinite)).toBe(true);
  });
});

describe('clampResidual', () => {
  it('bounds the correction by the estimator’s own uncertainty', () => {
    // ★ THE HONEST CEILING ON "HOW WRONG COULD WE BE" IS ALREADY COMPUTED ★
    // It is the covariance. A correction larger than that is the model
    // asserting it knows the error better than the filter knows its own
    // uncertainty, which is a claim no residual model has earned.
    const out = clampResidual({ alongM: 400, crossM: -300 }, { alongM: 12, crossM: 4 });
    expect(out.alongM).toBe(12);
    expect(out.crossM).toBe(-4);
  });

  it('leaves a modest correction alone', () => {
    const out = clampResidual({ alongM: 5, crossM: -1 }, { alongM: 30, crossM: 6 });
    expect(out.alongM).toBe(5);
    expect(out.crossM).toBe(-1);
  });

  it('never exceeds the absolute ceiling, whatever the covariance claims', () => {
    const out = clampResidual({ alongM: 5000, crossM: 5000 }, { alongM: 9999, crossM: 9999 });
    expect(Math.abs(out.alongM)).toBeLessThanOrEqual(DEFAULT_RESIDUAL_CONFIG.maxCorrectionM);
    expect(Math.abs(out.crossM)).toBeLessThanOrEqual(DEFAULT_RESIDUAL_CONFIG.maxCorrectionM);
  });

  it('corrects nothing when the estimator claims no uncertainty', () => {
    const out = clampResidual({ alongM: 20, crossM: 20 }, { alongM: 0, crossM: 0 });
    expect(out).toEqual({ alongM: 0, crossM: 0 });
  });

  it('survives a non-finite prediction', () => {
    const out = clampResidual({ alongM: Number.NaN, crossM: Infinity }, { alongM: 10, crossM: 10 });
    expect(out.alongM).toBe(0);
    expect(out.crossM).toBe(0);
  });

  it('★ bounds the damage a model that does not generalise can do', () => {
    // The measured case. Trained on city outages, asked about a highway one,
    // the network predicted a 426 m along-track error where the truth was 45 m.
    // Unbounded that is a catastrophe; bounded by a 40 m covariance it is a
    // 40 m mistake, which is the difference between degrading an estimate and
    // destroying it.
    const wild = { alongM: 426, crossM: 247 };
    const out = clampResidual(wild, { alongM: 40, crossM: 5 });
    expect(out.alongM).toBe(40);
    expect(out.crossM).toBe(5);
  });
});

describe('NullResidualCorrector', () => {
  it('is never ready and never answers', () => {
    const c = new NullResidualCorrector();
    expect(c.isReady()).toBe(false);
    expect(c.predict()).toBeNull();
    expect(c.scaler.mean).toHaveLength(DRIFT_FEATURE_COUNT);
  });
});

describe('MlpResidualCorrector', () => {
  /** A hand-built network: two outputs, weight 1 on the first two features. */
  const weights = {
    architecture: 'ResidualMLP',
    encoding: 'base64-float32-le',
    windowSamples: 1,
    sampleRateHz: 10,
    channels: [...DRIFT_FEATURES],
    scaler: {
      mean: new Array(DRIFT_FEATURE_COUNT).fill(0),
      std: new Array(DRIFT_FEATURE_COUNT).fill(1),
    },
    layers: [
      {
        type: 'linear',
        inFeatures: DRIFT_FEATURE_COUNT,
        outFeatures: 2,
        // Row 0 reads feature 0; row 1 reads feature 1.
        weight: block([
          ...[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          ...[0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ]),
        bias: block([0.5, -0.25]),
      },
    ],
  };

  it('evaluates as an MLP through the shared network runner', () => {
    // An MLP is a CNN with no convolutions, so `runCnn` needs no special case
    // and the tests that exercise the speed model exercise this arithmetic too.
    const c = new MlpResidualCorrector(parseResidualWeights(weights));
    expect(c.isReady()).toBe(true);
    const out = c.predict(buildDriftFeatures({ ...INPUT, timeSinceGnssMs: 10_000, speedMps: 4 }));
    expect(out!.alongM).toBeCloseTo(10 + 0.5, 4);
    expect(out!.crossM).toBeCloseTo(4 - 0.25, 4);
  });

  it('applies the scaler it was trained with', () => {
    const scaled = {
      ...weights,
      scaler: {
        mean: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        std: [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      },
    };
    const c = new MlpResidualCorrector(parseResidualWeights(scaled));
    const out = c.predict(buildDriftFeatures({ ...INPUT, timeSinceGnssMs: 30_000, speedMps: 0 }));
    // (30 - 10) / 2 = 10, plus the 0.5 bias.
    expect(out!.alongM).toBeCloseTo(10.5, 4);
  });

  it('refuses a feature vector of the wrong length', () => {
    const c = new MlpResidualCorrector(parseResidualWeights(weights));
    expect(c.predict(new Float32Array(3))).toBeNull();
  });

  it('refuses a model whose feature list disagrees with the engine', () => {
    // The same failure Model 2's class list has: it runs, it looks confident,
    // and it corrects in the wrong direction.
    const bad = { ...weights, channels: [...DRIFT_FEATURES].reverse() };
    expect(() => parseResidualWeights(bad)).toThrow(/feature 0/);
  });

  it('refuses a model that does not emit exactly along and cross', () => {
    const bad = {
      ...weights,
      layers: [
        {
          type: 'linear',
          inFeatures: DRIFT_FEATURE_COUNT,
          outFeatures: 3,
          weight: zeros(DRIFT_FEATURE_COUNT * 3),
          bias: zeros(3),
        },
      ],
    };
    expect(() => parseResidualWeights(bad)).toThrow(/2 outputs/);
  });

  it('refuses one of the other two models', () => {
    expect(() => parseResidualWeights({ architecture: 'MotionCNN' })).toThrow(/architecture/);
  });
});
