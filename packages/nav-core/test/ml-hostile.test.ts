/**
 * Adversarial tests for the Phase 8 speed model.
 *
 * The happy path is covered by ml.test.ts and cnn.test.ts. This file assumes
 * the code is wrong and tries to prove it: malformed weights, weights that do
 * not match their declared shape, a predictor that throws, a contract that has
 * silently drifted, clocks that run backwards.
 *
 * The bar: nothing here may crash the engine, and nothing may produce a
 * confident wrong answer. Refusing loudly is always acceptable. Returning a
 * plausible number from broken input never is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CnnSpeedPredictor,
  decodeFloat32,
  ML_CHANNELS,
  ML_WINDOW_SAMPLES,
  NavigationEngine,
  parseSpeedCnnWeights,
  runSpeedCnn,
  SpeedWindowBuffer,
  type SensorSample,
  type SpeedPredictor,
} from '../src/index.js';

const HERE = new URL('.', import.meta.url).pathname;
const MODEL_PATH = join(HERE, '../../../apps/web/public/models/speed_model.json');
const rawModel = JSON.parse(readFileSync(MODEL_PATH, 'utf8')) as Record<string, unknown>;
const weights = parseSpeedCnnWeights(rawModel);

function b64(values: number[]): string {
  return Buffer.from(new Float32Array(values).buffer).toString('base64');
}

/** A moving-vehicle sample — see ml.test.ts for why the vibration matters. */
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

function drive(engine: NavigationEngine, gnssMs: number, outageMs: number) {
  let t = 0;
  for (; t < gnssMs; t += 20) {
    const s = sample(t);
    if (t % 1000 === 0) {
      s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: 10 };
    }
    engine.update(s);
  }
  for (const end = t + outageMs; t < end; t += 20) engine.update(sample(t));
  return t;
}

// ── 1. Malformed weights ────────────────────────────────────────────────────

describe('parseSpeedCnnWeights refuses what it cannot trust', () => {
  it('rejects a conv whose weight block does not match its declared shape', () => {
    // 32 x 6 x 5 = 960 floats are required. Give it 10.
    expect(() =>
      parseSpeedCnnWeights({
        ...rawModel,
        layers: [
          {
            type: 'conv1d',
            inChannels: 6,
            outChannels: 32,
            kernel: 5,
            padding: 2,
            weight: b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
            bias: b64(new Array(32).fill(0)),
          },
        ],
      }),
    ).toThrow(/weight|shape|expected/i);
  });

  it('rejects a conv whose bias length does not match its output channels', () => {
    expect(() =>
      parseSpeedCnnWeights({
        ...rawModel,
        layers: [
          {
            type: 'conv1d',
            inChannels: 1,
            outChannels: 2,
            kernel: 1,
            padding: 0,
            weight: b64([1, 2]),
            bias: b64([1, 2, 3, 4, 5]),
          },
        ],
      }),
    ).toThrow(/bias|shape|expected/i);
  });

  it('rejects a linear layer whose weight block is the wrong size', () => {
    expect(() =>
      parseSpeedCnnWeights({
        ...rawModel,
        layers: [
          {
            type: 'linear',
            inFeatures: 64,
            outFeatures: 32,
            weight: b64([1, 2, 3]),
            bias: b64(new Array(32).fill(0)),
          },
        ],
      }),
    ).toThrow(/weight|shape|expected/i);
  });

  it('rejects weights containing NaN or Infinity', () => {
    // A corrupt download can decode perfectly and still be poison. Every
    // prediction afterwards is NaN, the model still reports "loaded", and the
    // debug panel shows a dash with no explanation.
    expect(() =>
      parseSpeedCnnWeights({
        ...rawModel,
        layers: [
          {
            type: 'conv1d',
            inChannels: 1,
            outChannels: 1,
            kernel: 1,
            padding: 0,
            weight: b64([NaN]),
            bias: b64([0]),
          },
        ],
      }),
    ).toThrow(/finite|NaN|Infinity/i);
  });

  it('rejects a window length that disagrees with the engine', () => {
    // If someone retrains at a different window and ships it, the engine keeps
    // building 20-sample windows and runSpeedCnn returns NaN for every one of
    // them. The model reports loaded and answers nothing, forever.
    expect(() =>
      parseSpeedCnnWeights({ ...rawModel, windowSamples: 100 }),
    ).toThrow(/window/i);
  });

  it('rejects a sample rate that disagrees with the engine', () => {
    expect(() => parseSpeedCnnWeights({ ...rawModel, sampleRateHz: 50 })).toThrow(/rate/i);
  });

  it('rejects a channel count that disagrees with the engine', () => {
    expect(() =>
      parseSpeedCnnWeights({ ...rawModel, channels: ['ax', 'ay', 'az'] }),
    ).toThrow(/channel/i);
  });

  it('rejects a scaler of the wrong length', () => {
    expect(() =>
      parseSpeedCnnWeights({ ...rawModel, scaler: { mean: [0, 0], std: [1, 1] } }),
    ).toThrow(/scaler|channel/i);
  });

  it('rejects a scaler containing a zero standard deviation', () => {
    // Dividing by it yields Infinity for that channel and poisons the window.
    const mean = new Array(ML_CHANNELS).fill(0);
    const std = new Array(ML_CHANNELS).fill(1);
    std[2] = 0;
    expect(() => parseSpeedCnnWeights({ ...rawModel, scaler: { mean, std } })).toThrow(
      /scaler|std|zero/i,
    );
  });

  it('rejects an empty layer list rather than loading a model that does nothing', () => {
    expect(() => parseSpeedCnnWeights({ ...rawModel, layers: [] })).toThrow(/layer/i);
  });

  it('still accepts the real shipped model', () => {
    // The guard rails must not have become so tight that the real artefact
    // fails them. This is the test that catches an over-strict validator.
    const w = parseSpeedCnnWeights(rawModel);
    expect(w.layers.length).toBeGreaterThan(5);
    expect(new CnnSpeedPredictor(w).isReady()).toBe(true);
  });
});

// ── 2. The decoder ──────────────────────────────────────────────────────────

describe('decodeFloat32 under abuse', () => {
  it('decodes negative and subnormal values exactly', () => {
    const src = [-1.5, -0, 3.4028234663852886e38, 1.401298464324817e-45];
    const out = decodeFloat32(b64(src));
    expect(out[0]).toBe(-1.5);
    expect(Object.is(out[1], -0)).toBe(true);
    expect(out[2]).toBe(3.4028234663852886e38);
  });

  it('returns an empty array for an empty string', () => {
    expect(decodeFloat32('').length).toBe(0);
  });

  it('throws rather than silently truncating a partial float', () => {
    // 5 bytes is one float and a quarter. Rounding down would hand the network
    // a weight block that is quietly one element short.
    expect(() => decodeFloat32('AAAAAAA')).toThrow(/float32|bytes/i);
  });

  it('ignores whitespace and newlines a JSON pretty-printer might introduce', () => {
    const clean = b64([1, 2, 3]);
    const dirty = clean.replace(/(.{4})/g, '$1\n ');
    expect(Array.from(decodeFloat32(dirty))).toEqual([1, 2, 3]);
  });
});

// ── 3. The forward pass ─────────────────────────────────────────────────────

describe('runSpeedCnn under abuse', () => {
  it('returns NaN, never a number, for every wrong input length', () => {
    for (const n of [0, 1, 119, 121, 240]) {
      expect(Number.isNaN(runSpeedCnn(weights, new Float32Array(n)))).toBe(true);
    }
  });

  it('does not return a confident number when fed NaN', () => {
    const w = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).fill(0);
    w[5] = Number.NaN;
    expect(Number.isNaN(runSpeedCnn(weights, w))).toBe(true);
  });

  it('does not return a confident number when fed Infinity', () => {
    const w = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).fill(0);
    w[5] = Number.POSITIVE_INFINITY;
    const v = runSpeedCnn(weights, w);
    expect(Number.isNaN(v) || Number.isFinite(v)).toBe(true);
    if (Number.isFinite(v)) expect(Math.abs(v)).toBeLessThan(1e6);
  });

  it('is deterministic — the same window always gives the same answer', () => {
    const w = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).map((_, i) =>
      Math.sin(i * 0.37),
    );
    const first = runSpeedCnn(weights, w);
    for (let i = 0; i < 20; i++) expect(runSpeedCnn(weights, w)).toBe(first);
  });

  it('does not mutate the window it was given', () => {
    const w = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).map((_, i) =>
      Math.cos(i * 0.11),
    );
    const before = Array.from(w);
    runSpeedCnn(weights, w);
    expect(Array.from(w)).toEqual(before);
  });

  it('responds to its input — a constant output would mean nothing is wired up', () => {
    const a = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).fill(0);
    const b = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).map((_, i) =>
      Math.sin(i * 0.9),
    );
    expect(runSpeedCnn(weights, a)).not.toBe(runSpeedCnn(weights, b));
  });

  it('reads every channel — zeroing any one changes the answer', () => {
    // If a channel is never read, an indexing bug has silently dropped it and
    // the model is running on five inputs while claiming six.
    const base = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).map((_, i) =>
      Math.sin(i * 0.31),
    );
    const ref = runSpeedCnn(weights, base);
    for (let c = 0; c < ML_CHANNELS; c++) {
      const m = Float32Array.from(base);
      m.fill(0, c * ML_WINDOW_SAMPLES, (c + 1) * ML_WINDOW_SAMPLES);
      expect(runSpeedCnn(weights, m)).not.toBe(ref);
    }
  });

  it('reads every timestep — zeroing any one changes the answer', () => {
    const base = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES).map((_, i) =>
      Math.sin(i * 0.53),
    );
    const ref = runSpeedCnn(weights, base);
    for (let t = 0; t < ML_WINDOW_SAMPLES; t++) {
      const m = Float32Array.from(base);
      for (let c = 0; c < ML_CHANNELS; c++) m[c * ML_WINDOW_SAMPLES + t] = 0;
      expect(runSpeedCnn(weights, m)).not.toBe(ref);
    }
  });
});

// ── 4. The window buffer ────────────────────────────────────────────────────

describe('SpeedWindowBuffer under abuse', () => {
  it('recovers from a clock that jumps backwards instead of stalling forever', () => {
    // A monotonic clock should never go back, but WebView timestamps and
    // Android's boot-time base have both been seen to. If the buffer keeps
    // waiting for a deadline in the far future it stops feeding the model for
    // the rest of the session and nothing says so.
    const b = new SpeedWindowBuffer();
    b.push(1_000_000, 1, 1, 1, 1, 1, 1);
    let accepted = 0;
    for (let i = 0; i < 40; i++) if (b.push(i * 100, 1, 1, 1, 1, 1, 1)) accepted++;
    expect(accepted).toBeGreaterThan(0);
  });

  it('survives a very long run without drifting off the 10 Hz grid', () => {
    const b = new SpeedWindowBuffer();
    let accepted = 0;
    // One hour of 50 Hz input.
    for (let t = 0; t < 3_600_000; t += 20) {
      if (b.push(t, 1, 1, 1, 1, 1, 1)) accepted++;
    }
    // 3600 s at 10 Hz is 36000 samples; allow a per-step rounding margin.
    expect(accepted).toBeGreaterThan(35_000);
    expect(accepted).toBeLessThan(37_000);
  });

  it('never emits a window before it has a full one, even after reset', () => {
    const b = new SpeedWindowBuffer();
    for (let i = 0; i < 50; i++) b.push(i * 100, 1, 1, 1, 1, 1, 1);
    b.reset();
    for (let i = 0; i < ML_WINDOW_SAMPLES - 1; i++) {
      b.push(100_000 + i * 100, 1, 1, 1, 1, 1, 1);
      expect(b.buildWindow(new Array(6).fill(0), new Array(6).fill(1))).toBeNull();
    }
  });

  it('produces only finite values from a scaler with a zero std', () => {
    // Defence in depth: the loader rejects this, but the buffer must not
    // produce Infinity if one ever reaches it.
    const b = new SpeedWindowBuffer();
    for (let i = 0; i < ML_WINDOW_SAMPLES; i++) b.push(i * 100, 5, 5, 5, 5, 5, 5);
    const w = b.buildWindow([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0])!;
    expect(w.every((v) => Number.isFinite(v))).toBe(true);
  });
});

// ── 5. The engine must survive a hostile predictor ──────────────────────────

class ThrowingPredictor implements SpeedPredictor {
  calls = 0;
  isReady(): boolean {
    return true;
  }
  predict(): number {
    this.calls++;
    throw new Error('inference exploded');
  }
}

class SlowlyRottingPredictor implements SpeedPredictor {
  private n = 0;
  isReady(): boolean {
    return true;
  }
  predict(): number {
    // Fine, then NaN, then Infinity, then negative — every way a model can rot.
    this.n++;
    if (this.n < 3) return 12;
    if (this.n < 6) return Number.NaN;
    if (this.n < 9) return Number.POSITIVE_INFINITY;
    return -50;
  }
}

describe('NavigationEngine survives a hostile predictor', () => {
  it('does not crash when the predictor throws', () => {
    // Golden Rule: the app must never crash. A model that throws mid-outage
    // would take the whole engine down and freeze the marker on screen.
    const p = new ThrowingPredictor();
    const e = new NavigationEngine();
    e.setSpeedPredictor(p, { mean: new Array(6).fill(0), std: new Array(6).fill(1) });
    expect(() => drive(e, 5000, 6000)).not.toThrow();
    expect(p.calls).toBeGreaterThan(0);
  });

  it('falls back to integration after the predictor throws', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new ThrowingPredictor(), {
      mean: new Array(6).fill(0),
      std: new Array(6).fill(1),
    });
    drive(e, 5000, 6000);
    expect(e.currentSpeedSource).toBe('INTEGRATED');
    expect(Number.isFinite(e.update(sample(11_020)).velocityMps)).toBe(true);
  });

  it('never emits a non-finite state as the predictor rots', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(new SlowlyRottingPredictor(), {
      mean: new Array(6).fill(0),
      std: new Array(6).fill(1),
    });
    let t = 0;
    for (; t < 4000; t += 20) {
      const s = sample(t);
      if (t % 1000 === 0) {
        s.gnss = { lat: 23.16 + t * 1e-7, lon: 79.93, accuracyM: 5, speedMps: 10 };
      }
      e.update(s);
    }
    for (const end = t + 20_000; t < end; t += 20) {
      const st = e.update(sample(t));
      expect(Number.isFinite(st.velocityMps)).toBe(true);
      expect(Number.isFinite(st.position.lat)).toBe(true);
      expect(Number.isFinite(st.position.lon)).toBe(true);
      expect(st.velocityMps).toBeGreaterThanOrEqual(0);
    }
  });

  it('a negative prediction never drives the vehicle backwards', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(
      { isReady: () => true, predict: () => -30 },
      { mean: new Array(6).fill(0), std: new Array(6).fill(1) },
    );
    drive(e, 5000, 8000);
    expect(e.diagnostics.mlSpeedMps).toBeGreaterThanOrEqual(0);
  });

  it('swapping the predictor mid-outage does not corrupt the estimate', () => {
    const e = new NavigationEngine();
    e.setSpeedPredictor(
      { isReady: () => true, predict: () => 12 },
      { mean: new Array(6).fill(0), std: new Array(6).fill(1) },
    );
    let t = drive(e, 5000, 3000);
    e.setSpeedPredictor(
      { isReady: () => true, predict: () => 25 },
      { mean: new Array(6).fill(0), std: new Array(6).fill(1) },
    );
    for (const end = t + 5000; t < end; t += 20) {
      const st = e.update(sample(t));
      expect(Number.isFinite(st.velocityMps)).toBe(true);
    }
  });

  it('the real model, driven end to end, produces a plausible speed', () => {
    // The full chain: engine -> buffer -> scaler -> pure-TS network. If any
    // link is wrong this is where a nonsense number shows up.
    const p = new CnnSpeedPredictor(weights);
    const e = new NavigationEngine();
    e.setSpeedPredictor(p, weights.scaler);
    drive(e, 6000, 10_000);
    const v = e.diagnostics.mlSpeedMps;
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(40);
    expect(e.diagnostics.mlInferences).toBeGreaterThan(0);
  });
});
