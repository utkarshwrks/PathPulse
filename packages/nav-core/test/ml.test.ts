import { describe, expect, it } from 'vitest';
import {
  ML_CHANNELS,
  ML_MODEL_CHANNELS,
  ML_RAW_CHANNELS,
  ML_SAMPLE_RATE_HZ,
  ML_WINDOW_SAMPLES,
  MockSpeedPredictor,
  NavigationEngine,
  NullSpeedPredictor,
  SpeedSmoother,
  SpeedWindowBuffer,
  type SensorSample,
} from '../src/index.js';

const ZERO_MEAN = [0, 0, 0, 0, 0, 0];
const UNIT_STD = [1, 1, 1, 1, 1, 1];

/**
 * A sample from a phone in a MOVING vehicle.
 *
 * The vibration matters. A perfectly clean `az = 9.81` is, correctly, read as
 * stationary by StationarityDetector, ZUPT then zeroes the velocity and the
 * engine reports STOPPED — which is right, and makes the sample useless for
 * testing the speed path. Real road vibration is what tells the two apart, so
 * the fixture has to contain some. Deterministic, so the tests are too.
 */
function sample(t: number, over: Partial<SensorSample> = {}): SensorSample {
  const p = t / 1000;
  return {
    t,
    imu: {
      ax: 0.35 * Math.sin(p * 7.1),
      ay: 0.25 * Math.sin(p * 11.3),
      az: 9.81 + 0.4 * Math.sin(p * 13.7),
      gx: 0.02 * Math.sin(p * 5.3),
      gy: 0.02 * Math.sin(p * 3.1),
      gz: 0.05 * Math.sin(p * 2.3),
    },
    ...over,
  };
}

describe('SpeedWindowBuffer', () => {
  it('decimates a 50 Hz stream to the model\'s 10 Hz', () => {
    const b = new SpeedWindowBuffer();
    let accepted = 0;
    // A full window of 50 Hz input: 5 raw samples per accepted one.
    for (let i = 0; i < ML_WINDOW_SAMPLES * 5; i++) {
      if (b.push(i * 20, 1, 2, 3, 4, 5, 6)) accepted++;
    }
    expect(accepted).toBeGreaterThanOrEqual(ML_WINDOW_SAMPLES);
    expect(accepted).toBeLessThanOrEqual(ML_WINDOW_SAMPLES + 1);
  });

  it('accepts every sample of a stream already at 10 Hz', () => {
    const b = new SpeedWindowBuffer();
    let accepted = 0;
    for (let i = 0; i < ML_WINDOW_SAMPLES; i++) if (b.push(i * 100, 1, 1, 1, 1, 1, 1)) accepted++;
    expect(accepted).toBe(ML_WINDOW_SAMPLES);
    expect(b.isFull).toBe(true);
  });

  it('is not full before a complete window has arrived', () => {
    const b = new SpeedWindowBuffer();
    for (let i = 0; i < ML_WINDOW_SAMPLES - 1; i++) b.push(i * 100, 1, 1, 1, 1, 1, 1);
    expect(b.isFull).toBe(false);
    expect(b.buildWindow(ZERO_MEAN, UNIT_STD)).toBeNull();
  });

  it('emits (channel, time) order — the layout Conv1d expects', () => {
    const b = new SpeedWindowBuffer();
    // Channel c carries the constant value c, so a correctly laid-out window is
    // n zeros, then n ones, and so on. A (time, channel) layout would instead
    // repeat 0..5 n times, which this catches.
    for (let i = 0; i < ML_WINDOW_SAMPLES; i++) b.push(i * 100, 0, 1, 2, 3, 4, 5);
    // A six-entry scaler asks for the raw channels only — the derivation is
    // driven by the scaler's width, so this exercises the raw layout alone.
    const w = b.buildWindow(ZERO_MEAN, UNIT_STD)!;
    expect(w.length).toBe(ML_RAW_CHANNELS * ML_WINDOW_SAMPLES);
    for (let c = 0; c < ML_RAW_CHANNELS; c++) {
      for (let t = 0; t < ML_WINDOW_SAMPLES; t++) {
        expect(w[c * ML_WINDOW_SAMPLES + t]).toBe(c);
      }
    }
  });

  it('applies the scaler per channel', () => {
    const b = new SpeedWindowBuffer();
    for (let i = 0; i < ML_WINDOW_SAMPLES; i++) b.push(i * 100, 10, 10, 10, 10, 10, 10);
    const w = b.buildWindow([10, 8, 10, 10, 10, 10], [1, 2, 1, 1, 1, 1])!;
    expect(w[0]).toBe(0); // (10 - 10) / 1
    expect(w[ML_WINDOW_SAMPLES]).toBe(1); // (10 - 8) / 2
  });

  it('keeps the oldest sample first once the ring has wrapped', () => {
    const b = new SpeedWindowBuffer();
    // Push one more than a full window; the first value must have fallen off.
    for (let i = 0; i <= ML_WINDOW_SAMPLES; i++) b.push(i * 100, i, 0, 0, 0, 0, 0);
    const w = b.buildWindow(ZERO_MEAN, UNIT_STD)!;
    expect(w[0]).toBe(1);
    expect(w[ML_WINDOW_SAMPLES - 1]).toBe(ML_WINDOW_SAMPLES);
  });

  it('survives NaN without poisoning the window', () => {
    const b = new SpeedWindowBuffer();
    for (let i = 0; i < ML_WINDOW_SAMPLES; i++) b.push(i * 100, NaN, Infinity, 1, 1, 1, 1);
    const w = b.buildWindow(ZERO_MEAN, UNIT_STD)!;
    expect(w.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('ignores a non-finite timestamp', () => {
    const b = new SpeedWindowBuffer();
    expect(b.push(NaN, 1, 1, 1, 1, 1, 1)).toBe(false);
  });

  it('does not burst-accept after a gap in the stream', () => {
    // A backgrounded tab stalls the sensor, then resumes. Advancing the accept
    // deadline by one period at a time would let a run of consecutive samples
    // through to "catch up", packing them into the window at the wrong rate.
    const b = new SpeedWindowBuffer();
    b.push(0, 1, 1, 1, 1, 1, 1);
    expect(b.push(10_000, 1, 1, 1, 1, 1, 1)).toBe(true);
    expect(b.push(10_020, 1, 1, 1, 1, 1, 1)).toBe(false);
    expect(b.push(10_040, 1, 1, 1, 1, 1, 1)).toBe(false);
    expect(b.push(10_100, 1, 1, 1, 1, 1, 1)).toBe(true);
  });

  it('clears on reset', () => {
    const b = new SpeedWindowBuffer();
    for (let i = 0; i < ML_WINDOW_SAMPLES; i++) b.push(i * 100, 1, 1, 1, 1, 1, 1);
    b.reset();
    expect(b.isFull).toBe(false);
  });

  it('agrees with the Python side about rate, window length and channels', () => {
    // These are a contract with ml/config.py and the shipped scaler.json.
    expect(ML_SAMPLE_RATE_HZ).toBe(10);
    expect(ML_WINDOW_SAMPLES).toBe(60);
    // The ring stores what the sensor gives; the network reads that plus six
    // channels derived from it. Conflating the two is how the window ends up
    // half-filled with garbage that still has the right length.
    expect(ML_RAW_CHANNELS).toBe(6);
    expect(ML_MODEL_CHANNELS).toBe(12);
    expect(ML_CHANNELS).toBe(ML_RAW_CHANNELS);
  });
});

describe('SpeedSmoother', () => {
  it('averages over its window', () => {
    const s = new SpeedSmoother(4);
    [10, 20, 30, 40].forEach((v) => s.push(v));
    expect(s.value).toBe(25);
  });

  it('drops the oldest beyond its size', () => {
    const s = new SpeedSmoother(2);
    s.push(0);
    s.push(10);
    s.push(20);
    expect(s.value).toBe(15);
  });

  it('is NaN before anything arrives, and ignores non-finite input', () => {
    const s = new SpeedSmoother(3);
    expect(Number.isNaN(s.value)).toBe(true);
    s.push(NaN);
    expect(s.count).toBe(0);
    s.push(5);
    expect(s.value).toBe(5);
  });
});

describe('predictors', () => {
  it('NullSpeedPredictor is never ready and never answers', () => {
    const p = new NullSpeedPredictor();
    expect(p.isReady()).toBe(false);
    expect(Number.isNaN(p.predict())).toBe(true);
  });

  it('MockSpeedPredictor records what it was asked', () => {
    const p = new MockSpeedPredictor(12);
    const w = new Float32Array(ML_MODEL_CHANNELS * ML_WINDOW_SAMPLES);
    expect(p.predict(w)).toBe(12);
    expect(p.seen).toHaveLength(1);
  });
});

describe('NavigationEngine + ML speed', () => {
  /** Drive the engine with GNSS for a while, then cut it. */
  function run(engine: NavigationEngine, opts: { gnssMs: number; outageMs: number }) {
    const step = 20;
    let t = 0;
    for (; t < opts.gnssMs; t += step) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: 10 };
      }
      engine.update(s);
    }
    const end = t + opts.outageMs;
    for (; t < end; t += step) engine.update(sample(t));
    return engine;
  }

  it('reports INTEGRATED when no model is loaded', () => {
    const e = new NavigationEngine();
    run(e, { gnssMs: 5000, outageMs: 8000 });
    expect(e.diagnostics.mlReady).toBe(false);
    expect(e.currentSpeedSource).toBe('INTEGRATED');
  });

  it('reports ML once a ready predictor is supplied', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(11), { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 8000 });
    expect(e.diagnostics.mlReady).toBe(true);
    expect(e.currentSpeedSource).toBe('ML');
    expect(e.diagnostics.mlSpeedMps).toBeCloseTo(11, 5);
  });

  it('prefers GNSS Doppler over the model while a fix is trusted', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(30), { mean: ZERO_MEAN, std: UNIT_STD });
    let t = 0;
    for (; t < 6000; t += 20) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: 10 };
      }
      e.update(s);
    }
    // The last sample carried a fix, so speed must come from it, not the model.
    const s = sample(t);
    s.gnss = { lat: 23.161, lon: 79.93, accuracyM: 5, speedMps: 10 };
    e.update(s);
    expect(e.currentSpeedSource).toBe('GNSS');
  });

  it('ignores the model when useMlSpeed is off', () => {
    const e = new NavigationEngine({ useMlSpeed: false });
    e.setSpeedPredictor(new MockSpeedPredictor(11), { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 8000 });
    expect(e.currentSpeedSource).toBe('INTEGRATED');
    expect(e.diagnostics.mlInferences).toBe(0);
  });

  it('honours the inference interval instead of running every sample', () => {
    const p = new MockSpeedPredictor(11);
    const e = new NavigationEngine({ mlInferenceIntervalMs: 500 });
    e.setSpeedPredictor(p, { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 3000, outageMs: 10_000 });
    // 13 s of samples at 20 ms is 650 samples; at 500 ms it must be ~26 runs.
    expect(e.diagnostics.mlInferences).toBeLessThan(40);
    expect(e.diagnostics.mlInferences).toBeGreaterThan(10);
  });

  it('falls back cleanly when the predictor stops being ready', () => {
    const p = new MockSpeedPredictor(11);
    const e = new NavigationEngine();
    e.setSpeedPredictor(p, { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 4000 });
    expect(e.currentSpeedSource).toBe('ML');
    p.setReady(false);
    for (let t = 9000; t < 12_000; t += 20) e.update(sample(t));
    expect(e.currentSpeedSource).toBe('INTEGRATED');
  });

  it('clamps an absurd prediction rather than driving the marker off the map', () => {
    const e = new NavigationEngine({ maxSpeedMps: 40 });
    e.setSpeedPredictor(new MockSpeedPredictor(5000), { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 6000 });
    expect(e.diagnostics.mlSpeedMps).toBeLessThanOrEqual(40);
  });

  it('a NaN prediction never reaches the emitted state', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(NaN), { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 6000 });
    const s = e.update(sample(11_020));
    expect(Number.isFinite(s.velocityMps)).toBe(true);
    expect(Number.isFinite(s.position.lat)).toBe(true);
  });

  it('detaching the predictor restores the pre-Phase-8 behaviour', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(11), { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 4000 });
    e.setSpeedPredictor(null);
    for (let t = 9000; t < 12_000; t += 20) e.update(sample(t));
    expect(e.diagnostics.mlReady).toBe(false);
    expect(e.currentSpeedSource).toBe('INTEGRATED');
  });

  it('reset clears the model counters', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(11), { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 6000 });
    expect(e.diagnostics.mlInferences).toBeGreaterThan(0);
    e.reset();
    expect(e.diagnostics.mlInferences).toBe(0);
    expect(e.currentSpeedSource).toBe('NONE');
  });

  it('feeds the model RAW device-frame IMU, not the conditioned signal', () => {
    // The model trained on accelerometer values with gravity still in them. If
    // the engine ever starts handing it gravity-removed, bias-corrected values
    // the predictions become meaningless while still looking plausible, so pin
    // the contract: az near 9.81 must reach the predictor.
    const p = new MockSpeedPredictor(11);
    const e = new NavigationEngine();
    e.setSpeedPredictor(p, { mean: ZERO_MEAN, std: UNIT_STD });
    run(e, { gnssMs: 5000, outageMs: 4000 });
    expect(p.seen.length).toBeGreaterThan(0);
    const w = p.seen[p.seen.length - 1]!;
    // Channel 2 is az; its window starts at index 2 * ML_WINDOW_SAMPLES.
    const az = w[2 * ML_WINDOW_SAMPLES]!;
    expect(az).toBeGreaterThan(9);
  });
});
