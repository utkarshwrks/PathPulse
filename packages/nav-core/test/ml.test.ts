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
    // Gate off: it now withholds the model until GNSS has scored it, which
    // takes about ten seconds of driving, and this test is about the predictor
    // being wired up rather than about the gate. See `mlSpeedTrustGate`.
    const e = new NavigationEngine({ mlSpeedTrustGate: false });
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
    const e = new NavigationEngine({ mlSpeedTrustGate: false });
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

  it('★ a model may move the estimate, not teleport it', () => {
    // See `mlSpeedMaxAccelMps2`. The drive establishes 10 m/s on Doppler, then
    // GNSS goes and the model asserts 35 — a 25 m/s step that no vehicle can
    // produce, and precisely the shape of the field report: the marker running
    // off down the road and being yanked back by the next fix.
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(35), { mean: ZERO_MEAN, std: UNIT_STD });
    let t = 0;
    for (; t < 6000; t += 20) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: 10 };
      }
      e.update(s);
    }
    const cutAt = t;
    // One second into the outage, 4 m/s^2 gets from 10 to at most 14.
    let atOneSecond = 0;
    for (; t < cutAt + 1000; t += 20) atOneSecond = e.update(sample(t)).velocityMps;
    expect(atOneSecond).toBeLessThan(15);
    expect(atOneSecond).toBeGreaterThan(10);
  });

  it('★ and gets there, if it keeps saying so', () => {
    // The bound delays a wrong answer; it must not silence a right one. Given
    // long enough the estimate reaches what the model claims, so this is a
    // rate limit and not a ceiling.
    //
    // A model insisting on 25 m/s against a Doppler that measured 10 is out by
    // 2.5x, which `mlSpeedTrustGate` would refuse — but only once it has seen
    // `minObservations` pairs, and six seconds of 1 Hz fixes is six. So this
    // still exercises the rate limit, which is what it is for. The gate's own
    // behaviour is measured below.
    // ★ WITH THE CEILING OFF, WHICH IS WHAT THIS ASSERTION IS ABOUT ★
    // `outageSpeedCeiling` now ships on — Tier F asked for it, see §24.15 —
    // and it deliberately bounds exactly what this test measures. The rate
    // limit is a separate mechanism and still has to work on its own.
    const e = new NavigationEngine({ outageSpeedCeiling: false, mlSpeedTrustGate: false });
    e.setSpeedPredictor(new MockSpeedPredictor(25), { mean: ZERO_MEAN, std: UNIT_STD });
    const out = run(e, { gnssMs: 6000, outageMs: 20_000 });
    expect(out.diagnostics.speedSource).toBe('ML');
    expect(out.update(sample(26_020)).velocityMps).toBeGreaterThan(20);
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

/**
 * ★ THE FIELD REPORT, AS A TEST ★
 *
 * A scooter ridden at an indicated 25-30 km/h through a city, the receiver
 * blocked for 45 s, and the badge reading `[ML] 89 km/h` with 2274 m of
 * distance banked. The model was reading a two-wheeler's vibration — nothing
 * like the cars in IO-VNBD — and answering three times the truth, and nothing
 * in the chain was entitled to disagree with it.
 *
 * "what the fuck is 80 71 speed in dead reckoning ... just catch the speed in
 * which u missed location then in that mean speed u take it"
 */
describe('an inferred speed is bounded by the last measured one', () => {
  // OFF by default — see `outageSpeedCeiling` for the measurement that put it
  // there. These lock in the mechanism for the toggle and for the failure the
  // trust gate cannot see: a model that goes wrong only once GNSS is gone.
  // The gate is a separate guard and would withhold the model before these
  // ever reach the ceiling they are about.
  const CEILING = { outageSpeedCeiling: true, mlSpeedTrustGate: false } as const;
  const ZERO12 = new Array(12).fill(0);
  const ONE12 = new Array(12).fill(1);

  /** A phone on a machine that is genuinely still: no vibration to read. */
  function stillSample(t: number): SensorSample {
    return {
      t,
      imu: { ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 },
    };
  }

  /** 8.3 m/s is 30 km/h — the ride in the report. */
  const RIDE_MPS = 8.3;

  function ride(engine: NavigationEngine, gnssMs: number, outageMs: number): number[] {
    const speeds: number[] = [];
    let t = 0;
    for (; t < gnssMs; t += 20) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: RIDE_MPS };
      }
      engine.update(s);
    }
    for (; t < gnssMs + outageMs; t += 20) {
      speeds.push(engine.update(sample(t)).velocityMps);
    }
    return speeds;
  }

  it('★ 45 s of outage no longer reaches 89 km/h', () => {
    const e = new NavigationEngine(CEILING);
    // What the model actually said on the handset: three times the truth.
    e.setSpeedPredictor(new MockSpeedPredictor(24.7), { mean: ZERO12, std: ONE12 });
    const speeds = ride(e, 6000, 45_000);
    expect(e.currentSpeedSource).toBe('ML');
    const worst = Math.max(...speeds);
    // 8.3 * 1.35 + 2.5 = 13.7 m/s, or 49 km/h. Was 24.7 m/s — 89 km/h.
    expect(worst).toBeLessThanOrEqual(13.71);
    expect(worst * 3.6).toBeLessThan(50);
  });

  it('the bound opens gradually rather than snapping shut', () => {
    const e = new NavigationEngine(CEILING);
    e.setSpeedPredictor(new MockSpeedPredictor(24.7), { mean: ZERO12, std: ONE12 });
    const speeds = ride(e, 6000, 45_000);
    // One second in, the estimate is still close to what was measured.
    expect(speeds[50]!).toBeLessThan(RIDE_MPS + 2);
    // And by the end it has been allowed the full headroom, not held at the
    // Doppler value — this is a bound on an inference, not a refusal to make
    // one. See `outageSpeedRampMs`.
    expect(speeds[speeds.length - 1]!).toBeGreaterThan(RIDE_MPS + 3);
  });

  it('a model that agrees with the receiver is not touched at all', () => {
    // ★ WHERE THE MODEL BEHAVES, THE BOUND NEVER BINDS ★ This is what makes
    // the change safe to ship against the published drift figures.
    const bounded = new NavigationEngine(CEILING);
    const free = new NavigationEngine({ outageSpeedCeiling: false, mlSpeedTrustGate: false });
    for (const e of [bounded, free]) {
      e.setSpeedPredictor(new MockSpeedPredictor(RIDE_MPS), { mean: ZERO12, std: ONE12 });
    }
    const a = ride(bounded, 6000, 45_000);
    const b = ride(free, 6000, 45_000);
    for (let i = 0; i < a.length; i++) expect(a[i]!).toBeCloseTo(b[i]!, 6);
  });

  it('a genuine motorway speed keeps its headroom', () => {
    // The bound is proportional as well as absolute, so it does not punish a
    // fast vehicle for being fast: 25 m/s of Doppler buys 33.75 + 2.5.
    const e = new NavigationEngine(CEILING);
    e.setSpeedPredictor(new MockSpeedPredictor(30), { mean: ZERO12, std: ONE12 });
    let t = 0;
    for (; t < 6000; t += 20) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: 25 };
      }
      e.update(s);
    }
    let v = 0;
    for (; t < 36_000; t += 20) v = e.update(sample(t)).velocityMps;
    expect(v).toBeGreaterThan(29);
  });

  it('a stop mid-outage does not cap the pull-away at walking pace', () => {
    // ★ A ZUPT IS KNOWLEDGE ABOUT NOW, NOT ABOUT THE ENVELOPE ★ See
    // `measuredSpeedMps`. Anchoring the ceiling on the zero would leave the
    // vehicle unable to exceed 2.5 m/s for the rest of the outage.
    const e = new NavigationEngine(CEILING);
    e.setSpeedPredictor(new MockSpeedPredictor(24.7), { mean: ZERO12, std: ONE12 });
    let t = 0;
    for (; t < 6000; t += 20) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: RIDE_MPS };
      }
      e.update(s);
    }
    // A stop, then motion again — both without GNSS.
    for (; t < 16_000; t += 20) e.update(stillSample(t));
    let v = 0;
    for (; t < 40_000; t += 20) v = e.update(sample(t)).velocityMps;
    expect(v).toBeGreaterThan(RIDE_MPS);
  });
});

/**
 * ★ THE RECEIVER HAD BEEN CONTRADICTING THE MODEL ALL ALONG ★
 *
 * See `mlSpeedTrustGate`. On a scooter ridden at an indicated 25-30 km/h the
 * IO-VNBD-trained network answered roughly three times the truth, and the
 * chain anchored the velocity vector to it: `[ML] 89 km/h`, 2274 m of distance
 * on a ride of well under a kilometre, and a trail sprawled across streets the
 * rider never went down. Every second of the drive before that outage, the
 * receiver reported a Doppler speed and the model reported its opinion of the
 * same moment. Nothing compared them.
 */
describe('the speed model is checked against the receiver that can check it', () => {
  const ZERO12 = new Array(12).fill(0);
  const ONE12 = new Array(12).fill(1);
  const RIDE_MPS = 8.3; // 30 km/h

  function ride(engine: NavigationEngine, gnssMs: number, outageMs: number, gnssMps: number) {
    let t = 0;
    for (; t < gnssMs; t += 20) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: gnssMps };
      }
      engine.update(s);
    }
    const speeds: number[] = [];
    for (; t < gnssMs + outageMs; t += 20) speeds.push(engine.update(sample(t)).velocityMps);
    return speeds;
  }

  it('★ a model reading three times the truth is not consulted in the outage', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(24.7), { mean: ZERO12, std: ONE12 });
    const speeds = ride(e, 30_000, 45_000, RIDE_MPS);
    expect(e.currentSpeedSource).not.toBe('ML');
    // 89 km/h was 24.7 m/s. Coasting from the measured speed instead.
    expect(Math.max(...speeds)).toBeLessThan(RIDE_MPS * 1.5);
  });

  it('★ and says so in the log rather than falling silent', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(24.7), { mean: ZERO12, std: ONE12 });
    ride(e, 30_000, 10_000, RIDE_MPS);
    const said = e.events.all.filter((x) => x.type === 'ML_SUPPRESSED');
    expect(said.length).toBe(1);
    expect(said[0]!.message).toContain('not describing this vehicle');
  });

  it('a model that agrees with the receiver is used exactly as before', () => {
    const gated = new NavigationEngine();
    const ungated = new NavigationEngine({ mlSpeedTrustGate: false });
    for (const e of [gated, ungated]) {
      e.setSpeedPredictor(new MockSpeedPredictor(RIDE_MPS * 1.1), { mean: ZERO12, std: ONE12 });
    }
    const a = ride(gated, 30_000, 45_000, RIDE_MPS);
    const b = ride(ungated, 30_000, 45_000, RIDE_MPS);
    expect(gated.currentSpeedSource).toBe('ML');
    for (let i = 0; i < a.length; i++) expect(a[i]!).toBeCloseTo(b[i]!, 6);
  });

  it('★ withholds the model until GNSS has actually scored it', () => {
    // ★ THE CONTRACT TIER F INVERTED ★
    //
    // This used to assert the opposite: silent until it has something to say,
    // so a handset that had only just acquired behaved exactly as it did. The
    // first Tier F ride showed what that costs. Its outage began twenty
    // seconds in, with the vehicle stopped until then, so no pair had ever
    // cleared `minSpeedMps` — and the model asserted 92 km/h on a scooter and
    // drew 945 m over a 216 m stretch, unchecked, because the check had not
    // been earned yet.
    //
    // The asymmetry is the argument. A model withheld costs the chain its best
    // inference and falls back to integrating from the last Doppler speed,
    // which is measured, bounded, and the arm every published figure is
    // compared against. A model admitted without evidence costs an outage.
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(24.7), { mean: ZERO12, std: ONE12 });
    ride(e, 5000, 4000, RIDE_MPS);
    expect(e.currentSpeedSource).not.toBe('ML');
  });

  it('and consults it once the receiver has, which takes about ten seconds', () => {
    const e = new NavigationEngine({ outageSpeedCeiling: false });
    e.setSpeedPredictor(new MockSpeedPredictor(RIDE_MPS * 1.1), { mean: ZERO12, std: ONE12 });
    ride(e, 30_000, 4000, RIDE_MPS);
    expect(e.currentSpeedSource).toBe('ML');
  });

  it('a model that under-reads by as much is refused too', () => {
    // The bound is two-sided: a model reading a third of the truth costs
    // distance just as surely, and is just as clearly describing something
    // else.
    const e = new NavigationEngine();
    e.setSpeedPredictor(new MockSpeedPredictor(2.6), { mean: ZERO12, std: ONE12 });
    ride(e, 30_000, 10_000, RIDE_MPS);
    expect(e.currentSpeedSource).not.toBe('ML');
  });

  it('can be switched off, and then the field report reproduces', () => {
    // Both guards off: the gate is what this test is about, and the ceiling
    // would otherwise bound the runaway it is trying to reproduce.
    const e = new NavigationEngine({ mlSpeedTrustGate: false, outageSpeedCeiling: false });
    e.setSpeedPredictor(new MockSpeedPredictor(24.7), { mean: ZERO12, std: ONE12 });
    const speeds = ride(e, 30_000, 45_000, RIDE_MPS);
    expect(e.currentSpeedSource).toBe('ML');
    expect(Math.max(...speeds) * 3.6).toBeGreaterThan(80);
  });
});

/**
 * ★ DROPPING SAMPLES IS NOT SAMPLING, IT IS ALIASING ★
 *
 * `SpeedWindowBuffer` decimates by keeping one sample every 100 ms. On the
 * handset that is one in thirteen — the IMU arrives at about 127 Hz — and
 * taking every thirteenth sample of a signal with energy above 5 Hz does not
 * remove that energy. It FOLDS it into the 0-5 Hz band, where it is
 * arithmetically indistinguishable from real vehicle acceleration.
 *
 * A four-stroke single at 1500-3000 rpm fires at 12.5-25 Hz. Chain, road and
 * suspension noise runs to 60. All of it lands inside the band the model reads
 * as speed, so the louder the vehicle the faster the model thinks it is going
 * — which no amount of retraining could fix, because the fault is in the
 * signal rather than in the weights.
 */
describe('the speed model is fed a band-limited signal', () => {
  const MEAN12 = new Array(12).fill(0);
  const STD12 = new Array(12).fill(1);

  /** A pure tone at `hz`, sampled at `rateHz`, pushed through the buffer. */
  function toneWindow(hz: number, rateHz: number, antiAlias: boolean): Float32Array | null {
    const b = new SpeedWindowBuffer(ML_WINDOW_SAMPLES, false, antiAlias);
    const dt = 1000 / rateHz;
    // Long enough to fill a 6 s window at 10 Hz with margin.
    for (let i = 0; i < rateHz * 12; i++) {
      const t = i * dt;
      const v = Math.sin((2 * Math.PI * hz * t) / 1000);
      b.push(t, v, 0, 9.81, 0, 0, 0);
    }
    return b.buildWindow(MEAN12, STD12);
  }

  function amplitude(w: Float32Array | null, n = ML_WINDOW_SAMPLES): number {
    if (!w) return 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = w[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return (max - min) / 2;
  }

  it('★ a 25 Hz tone folds straight into the band without the filter', () => {
    // 25 Hz sampled at 10 Hz aliases to 5 Hz — engine firing frequency, read
    // as vehicle dynamics.
    const folded = amplitude(toneWindow(25, 127, false));
    expect(folded).toBeGreaterThan(0.5);
  });

  it('★ and is removed by it', () => {
    const filtered = amplitude(toneWindow(25, 127, true));
    expect(filtered).toBeLessThan(0.1);
  });

  it('leaves real vehicle dynamics alone', () => {
    // 1 Hz is braking and cornering — the signal the model is supposed to read.
    const passed = amplitude(toneWindow(1, 127, true));
    expect(passed).toBeGreaterThan(0.5);
  });

  it('★ stands down on a stream already at the target rate', () => {
    // IO-VNBD logged its handset at 10 Hz natively, so the sensor's own
    // anti-alias ran before that rate existed. Filtering it again removes real
    // content and adds lag — measured as Tier R 31.3 % to 32.2 %.
    const a = toneWindow(1, 10, true);
    const b = toneWindow(1, 10, false);
    expect(a).not.toBeNull();
    for (let i = 0; i < ML_WINDOW_SAMPLES; i++) {
      expect(a![i]!).toBeCloseTo(b![i]!, 6);
    }
  });

  it('never emits a non-finite value, however hostile the input', () => {
    const b = new SpeedWindowBuffer(ML_WINDOW_SAMPLES, false, true);
    for (let i = 0; i < 2000; i++) {
      b.push(i * 8, NaN, Infinity, 9.81, -Infinity, 0, NaN);
    }
    const w = b.buildWindow(MEAN12, STD12);
    if (w) for (const v of w) expect(Number.isFinite(v)).toBe(true);
  });
});
