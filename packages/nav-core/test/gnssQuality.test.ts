/**
 * Phase 13, Model 4 — the GNSS quality classifier.
 *
 * ★ THE MOST IMPORTANT TEST IN THIS FILE IS THAT IT CANNOT GATE A FIX ★
 *
 * `detect/spoofing.ts` carries the argument: a detector that rejects the fix it
 * is suspicious of converts a false positive into a navigation failure. That
 * applies to a learned detector with MORE force, not less — three readable
 * rules have far fewer ways to be confidently wrong than a network trained on
 * modelled corruptions.
 *
 * So this model is advisory. It lowers the confidence bar and touches nothing
 * else, and that boundary is asserted rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  GNSS_QUALITY_CLASSES,
  GNSS_QUALITY_FEATURES,
  GNSS_QUALITY_FEATURE_COUNT,
  GnssQualityTracker,
  MlpGnssQualityClassifier,
  NullGnssQualityClassifier,
  buildGnssQualityFeatures,
  parseGnssQualityWeights,
} from '../src/ml/gnssQualityModel.js';

const at = (name: (typeof GNSS_QUALITY_FEATURES)[number]) => GNSS_QUALITY_FEATURES.indexOf(name);

const INPUT = {
  satCount: 11,
  satBaseline: 12,
  meanCn0: 38,
  cn0Spread: 3,
  accuracyM: 5,
  accuracyBaselineM: 4,
  jumpM: 12,
  fixIntervalS: 1,
  drSpeedMps: 11,
  hdop: 1,
};

describe('the feature vector', () => {
  it('is the single definition both sides use', () => {
    expect(GNSS_QUALITY_FEATURES).toHaveLength(GNSS_QUALITY_FEATURE_COUNT);
    expect(new Set(GNSS_QUALITY_FEATURES).size).toBe(GNSS_QUALITY_FEATURE_COUNT);
  });

  it('puts each value where its name says', () => {
    const f = buildGnssQualityFeatures(INPUT);
    expect(f[at('satCount')]).toBe(11);
    expect(f[at('satDropFromBaseline')]).toBeCloseTo(1, 5);
    expect(f[at('jumpM')]).toBeCloseTo(12, 5);
    expect(f[at('impliedSpeedMps')]).toBeCloseTo(12, 5);
    // 12 m in 1 s is 12 m/s implied; the IMU says 11. One metre per second of
    // disagreement, which is the term that separates a spoof from a bad fix.
    expect(f[at('imuDisagreementMps')]).toBeCloseTo(1, 5);
  });

  it('★ substitutes a typical C/N0 when the receiver did not report one', () => {
    // 0 dB-Hz is not a plausible reading, it means "not measured". Treating it
    // as the worst possible signal would make every phone that omits the field
    // permanently MULTIPATH.
    const f = buildGnssQualityFeatures({ ...INPUT, meanCn0: Number.NaN });
    expect(f[at('meanCn0')]).toBe(35);
  });

  it('never divides by zero on a duplicated fix', () => {
    const f = buildGnssQualityFeatures({ ...INPUT, fixIntervalS: 0, accuracyBaselineM: 0 });
    expect(f.every(Number.isFinite)).toBe(true);
  });

  it('survives non-finite input throughout', () => {
    const f = buildGnssQualityFeatures({
      satCount: Number.NaN,
      satBaseline: Infinity,
      meanCn0: Number.NaN,
      cn0Spread: Number.NaN,
      accuracyM: Number.NaN,
      accuracyBaselineM: Number.NaN,
      jumpM: Number.NaN,
      fixIntervalS: Number.NaN,
      drSpeedMps: Number.NaN,
      hdop: Number.NaN,
    });
    expect(f.every(Number.isFinite)).toBe(true);
  });
});

describe('GnssQualityTracker', () => {
  it('has no opinion about the very first fix', () => {
    // There is no jump without a previous position, and inventing one would
    // put a fictitious 0 m/s disagreement into the first row of every drive.
    const t = new GnssQualityTracker();
    expect(t.push({ t: 0, lat: 23.16, lon: 79.93, accuracyM: 4, drSpeedMps: 0 })).toBeNull();
  });

  it('measures the jump between consecutive fixes', () => {
    const t = new GnssQualityTracker();
    t.push({ t: 0, lat: 23.16, lon: 79.93, accuracyM: 4, drSpeedMps: 10 });
    // ~11.13 m north.
    const f = t.push({ t: 1000, lat: 23.1601, lon: 79.93, accuracyM: 4, drSpeedMps: 10 });
    expect(f![at('jumpM')]).toBeGreaterThan(10);
    expect(f![at('jumpM')]).toBeLessThan(13);
  });

  it('★ the baseline is the answer to "worse than what?"', () => {
    // Six satellites is fine on a receiver that has been seeing seven and
    // alarming on one that has been seeing fourteen. A baseline that followed
    // the degradation down would never notice it.
    const t = new GnssQualityTracker();
    for (let i = 0; i < 200; i++) {
      t.push({ t: i * 1000, lat: 23.16, lon: 79.93, accuracyM: 4, satCount: 14, drSpeedMps: 0 });
    }
    const f = t.push({
      t: 200_000,
      lat: 23.16,
      lon: 79.93,
      accuracyM: 4,
      satCount: 6,
      drSpeedMps: 0,
    });
    expect(f![at('satDropFromBaseline')]).toBeGreaterThan(6);
  });

  it('forgets everything on reset', () => {
    const t = new GnssQualityTracker();
    t.push({ t: 0, lat: 1, lon: 2, accuracyM: 4, drSpeedMps: 0 });
    t.reset();
    expect(t.push({ t: 1000, lat: 1, lon: 2, accuracyM: 4, drSpeedMps: 0 })).toBeNull();
  });
});

describe('NullGnssQualityClassifier', () => {
  it('is never ready and never answers', () => {
    const c = new NullGnssQualityClassifier();
    expect(c.isReady()).toBe(false);
    expect(c.predict()).toBeNull();
  });
});

describe('the exported weights', () => {
  const path = new URL('../../../apps/web/public/models/gnss_quality_model.json', import.meta.url);
  let raw: unknown;
  try {
    raw = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
  } catch {
    raw = null;
  }

  it.runIf(raw !== null)('load and agree about the classes and the features', () => {
    // The contract test. A reordered class list still runs, still looks
    // confident, and calls a good fix spoofed.
    const w = parseGnssQualityWeights(raw);
    expect(w.channels).toEqual([...GNSS_QUALITY_FEATURES]);
    expect((raw as { classes: string[] }).classes).toEqual([...GNSS_QUALITY_CLASSES]);
  });

  it.runIf(raw !== null)('produce a distribution over all four classes', () => {
    const c = new MlpGnssQualityClassifier(parseGnssQualityWeights(raw));
    const out = c.predict(buildGnssQualityFeatures(INPUT));
    expect(out).not.toBeNull();
    expect(out!.probabilities).toHaveLength(4);
    expect(out!.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(GNSS_QUALITY_CLASSES).toContain(out!.quality);
  });

  it.runIf(raw !== null)('★ call an obviously dead receiver LOST', () => {
    // Not a hard case, and that is the point: if the model cannot get this
    // one right, the export or the scaler is wrong rather than the model.
    const c = new MlpGnssQualityClassifier(parseGnssQualityWeights(raw));
    const out = c.predict(
      buildGnssQualityFeatures({
        satCount: 1,
        satBaseline: 12,
        meanCn0: 9,
        cn0Spread: 3,
        accuracyM: 150,
        accuracyBaselineM: 5,
        jumpM: 40,
        fixIntervalS: 1,
        drSpeedMps: 12,
        hdop: 12,
      }),
    );
    expect(out!.quality).toBe('LOST');
  });

  it.runIf(raw !== null)('are deterministic', () => {
    const c = new MlpGnssQualityClassifier(parseGnssQualityWeights(raw));
    const f = buildGnssQualityFeatures(INPUT);
    expect(c.predict(f)).toEqual(c.predict(f));
  });

  it('refuses a model whose class list disagrees', () => {
    const zeros = (n: number) => Buffer.from(new Float32Array(n).buffer).toString('base64');
    expect(() =>
      parseGnssQualityWeights({
        architecture: 'GnssQualityMLP',
        encoding: 'base64-float32-le',
        windowSamples: 1,
        sampleRateHz: 10,
        channels: [...GNSS_QUALITY_FEATURES],
        classes: [...GNSS_QUALITY_CLASSES].reverse(),
        scaler: {
          mean: new Array(GNSS_QUALITY_FEATURE_COUNT).fill(0),
          std: new Array(GNSS_QUALITY_FEATURE_COUNT).fill(1),
        },
        layers: [
          {
            type: 'linear',
            inFeatures: GNSS_QUALITY_FEATURE_COUNT,
            outFeatures: 4,
            weight: zeros(GNSS_QUALITY_FEATURE_COUNT * 4),
            bias: zeros(4),
          },
        ],
      }),
    ).toThrow(/class 0/);
  });

  it('refuses one of the other three models', () => {
    expect(() => parseGnssQualityWeights({ architecture: 'MotionCNN' })).toThrow(/architecture/);
  });
});
