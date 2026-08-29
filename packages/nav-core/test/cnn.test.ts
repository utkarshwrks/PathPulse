import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeFloat32,
  ML_CHANNELS,
  ML_WINDOW_SAMPLES,
  parseSpeedCnnWeights,
  runSpeedCnn,
  CnnSpeedPredictor,
} from '../src/index.js';

/**
 * ★ THE TEST THAT MAKES THE PURE-TS NETWORK TRUSTWORTHY ★
 *
 * `probes.json` holds real windows and the outputs PyTorch produced for them,
 * written by ml/export.py. If the TypeScript forward pass and the trained model
 * ever disagree, this fails — which is the only thing standing between "we
 * reimplemented the network" and "we reimplemented the network correctly".
 */
const HERE = new URL('.', import.meta.url).pathname;
const weights = parseSpeedCnnWeights(
  JSON.parse(readFileSync(join(HERE, '../../../apps/web/public/models/speed_model.json'), 'utf8')),
);
const probes = JSON.parse(readFileSync(join(HERE, 'probes.json'), 'utf8')) as {
  inputs: number[][];
  expected: number[];
  labels: number[];
  torchMaeMps: number;
};

describe('decodeFloat32', () => {
  it('round-trips values a Float32Array can hold exactly', () => {
    // 0.5, 1, 2 are exact in binary floating point, so this isolates the
    // decoder from any rounding question.
    const src = new Float32Array([0.5, 1, 2, -0.5]);
    const b64 = Buffer.from(src.buffer).toString('base64');
    expect(Array.from(decodeFloat32(b64))).toEqual([0.5, 1, 2, -0.5]);
  });

  it('handles a length needing base64 padding', () => {
    const src = new Float32Array([1.5, -2.25, 3.75]);
    expect(Array.from(decodeFloat32(Buffer.from(src.buffer).toString('base64')))).toEqual([
      1.5, -2.25, 3.75,
    ]);
  });
});

describe('SpeedCNN weights', () => {
  it('loads with the shape the engine expects', () => {
    expect(weights.windowSamples).toBe(ML_WINDOW_SAMPLES);
    expect(weights.channels).toHaveLength(ML_CHANNELS);
    expect(weights.sampleRateHz).toBe(10);
    expect(weights.scaler.mean).toHaveLength(ML_CHANNELS);
  });

  it('has the architecture the guide specifies: 3 convs, 2 pools, 2 dense', () => {
    const kinds = weights.layers.map((l) => l.type);
    expect(kinds.filter((k) => k === 'conv1d')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'maxpool1d')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'linear')).toHaveLength(2);
    expect(kinds).toContain('globalAvgPool');
  });

  it('carries no BatchNorm — it is folded into the convolutions', () => {
    expect(weights.layers.map((l) => l.type)).not.toContain('batchnorm');
  });

  it('refuses a foreign architecture rather than answering nonsense', () => {
    expect(() => parseSpeedCnnWeights({ architecture: 'ResNet50' })).toThrow(/architecture/);
  });

  it('refuses an unknown weight encoding', () => {
    expect(() =>
      parseSpeedCnnWeights({ architecture: 'SpeedCNN', encoding: 'plain-json' }),
    ).toThrow(/encoding/);
  });
});

describe('runSpeedCnn vs PyTorch', () => {
  it('reproduces every probe to within 1e-3 m/s', () => {
    expect(probes.inputs.length).toBeGreaterThan(0);
    let worst = 0;
    probes.inputs.forEach((flat, i) => {
      const got = runSpeedCnn(weights, new Float32Array(flat));
      const want = probes.expected[i]!;
      worst = Math.max(worst, Math.abs(got - want));
      expect(got).toBeCloseTo(want, 3);
    });
    // Float32 accumulation order differs from PyTorch's; 1e-3 m/s is 3.6 mm/h.
    expect(worst).toBeLessThan(1e-3);
  });

  it('★ achieves the accuracy we publish, on real labelled windows', () => {
    // The agreement test above proves the TypeScript matches PyTorch. It does
    // NOT prove either of them is any good — if export.py wrote the wrong
    // weights, both would agree on the same wrong answer.
    //
    // So: score the shipped TypeScript against the REAL held-out labels and
    // require it to reach the MAE the README quotes. This is the test that
    // fails if the published number ever stops being true.
    let sum = 0;
    probes.inputs.forEach((flat, i) => {
      const pred = Math.max(0, runSpeedCnn(weights, new Float32Array(flat)));
      sum += Math.abs(pred - probes.labels[i]!);
    });
    const mae = sum / probes.inputs.length;

    // Must match PyTorch's own score on the same windows, closely.
    expect(mae).toBeCloseTo(probes.torchMaeMps, 2);
    // And must stay in the band the documentation claims. Loose enough to
    // survive a retrain, tight enough that a broken export cannot pass: the
    // ridge baseline scores 4.29 and answering with the mean scores 7.24.
    expect(mae).toBeLessThan(4.0);
  });

  it('beats the constant-speed baseline by the margin we claim', () => {
    // If the network were silently returning a constant, the MAE above could
    // still look acceptable on a favourable slice. This cannot be faked: a
    // constant predictor has zero variance.
    const preds = probes.inputs.map((f) => runSpeedCnn(weights, new Float32Array(f)));
    const mean = preds.reduce((a, b) => a + b, 0) / preds.length;
    const variance = preds.reduce((a, b) => a + (b - mean) ** 2, 0) / preds.length;
    expect(Math.sqrt(variance)).toBeGreaterThan(2);

    const constMae =
      probes.labels.reduce((a, y) => a + Math.abs(mean - y), 0) / probes.labels.length;
    const modelMae =
      preds.reduce((a, p, i) => a + Math.abs(Math.max(0, p) - probes.labels[i]!), 0) /
      preds.length;
    expect(modelMae).toBeLessThan(constMae * 0.75);
  });

  it('returns NaN for a wrongly shaped input instead of guessing', () => {
    expect(Number.isNaN(runSpeedCnn(weights, new Float32Array(7)))).toBe(true);
  });

  it('produces a finite answer for an all-zero window', () => {
    const z = new Float32Array(ML_CHANNELS * ML_WINDOW_SAMPLES);
    expect(Number.isFinite(runSpeedCnn(weights, z))).toBe(true);
  });
});

describe('CnnSpeedPredictor', () => {
  it('satisfies the SpeedPredictor contract', () => {
    const p = new CnnSpeedPredictor(weights);
    expect(p.isReady()).toBe(true);
    expect(p.scaler.mean).toHaveLength(ML_CHANNELS);
    expect(Number.isFinite(p.predict(new Float32Array(probes.inputs[0]!)))).toBe(true);
  });

  it('is fast enough to run inside the 10 Hz loop', () => {
    const p = new CnnSpeedPredictor(weights);
    const w = new Float32Array(probes.inputs[0]!);
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) p.predict(w);
    const perCall = (Date.now() - t0) / 200;
    // The budget the guide sets for inference is 20 ms. This should be orders
    // below it — if it ever is not, the ONNX decision deserves revisiting.
    expect(perCall).toBeLessThan(5);
  });
});
