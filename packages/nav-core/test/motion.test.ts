/**
 * Phase 13, Model 2 — the motion-state classifier.
 *
 * Two kinds of test here, and the second is the one that matters.
 *
 * The unit tests below check the gate, the softmax and the weight parser —
 * ordinary logic. The last block loads the ACTUAL EXPORTED WEIGHTS and runs
 * them, because every failure this file exists to prevent is a contract
 * failure between the Python that trained the model and the TypeScript that
 * runs it: a reordered class list, a window of the wrong length, a scaler with
 * the wrong number of channels. None of those throw. They all produce
 * confident, plausible, wrong answers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CnnMotionClassifier,
  DEFAULT_MOTION_GATE_CONFIG,
  MOTION_STATES,
  MOTION_WINDOW_SAMPLES,
  MotionGate,
  NullMotionClassifier,
  isStoppedState,
  isTurningState,
  parseMotionCnnWeights,
  softmax,
  type MotionPrediction,
  type MotionState,
} from '../src/ml/motionModel.js';

/** A base64 float32 block of `n` zeros, so the parser reaches the check under test. */
const zeros = (n: number): string =>
  Buffer.from(new Float32Array(n).buffer).toString('base64');

const p = (state: MotionState, confidence: number): MotionPrediction => ({
  state,
  confidence,
  probabilities: MOTION_STATES.map((s) => (s === state ? confidence : (1 - confidence) / 7)),
});

describe('softmax', () => {
  it('produces a distribution', () => {
    const out = softmax([1, 2, 3]);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(out[2]).toBeGreaterThan(out[0]!);
  });

  it('survives logits large enough to overflow a naive implementation', () => {
    // ★ THE REASON THE MAX IS SUBTRACTED ★ exp(800) is Infinity, and
    // Infinity/Infinity is NaN — the whole distribution, from one large logit.
    const out = softmax([800, 799, 0]);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('falls back to uniform rather than NaN on degenerate input', () => {
    const out = softmax([Number.NaN, Number.NaN]);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe('MotionGate', () => {
  it('does not act on a single frame', () => {
    // ★ THE ASYMMETRY IS THE POINT ★ At 10 Hz a one-frame misread of
    // STATIONARY zeroes a real velocity and teaches the bias estimators from a
    // moving vehicle, ten times a second. A missed stop costs one calibration.
    const gate = new MotionGate();
    expect(gate.push(p('IDLING', 0.99)).state).toBeNull();
    expect(gate.push(p('IDLING', 0.99)).state).toBeNull();
    expect(gate.push(p('IDLING', 0.99)).state).toBe('IDLING');
  });

  it('discards a frame it is not confident about', () => {
    const gate = new MotionGate();
    for (let i = 0; i < 5; i++) gate.push(p('BRAKING', 0.4));
    expect(gate.state).toBeNull();
  });

  it('keeps the accepted state through one unconfident frame', () => {
    // Losing confidence for a window is not evidence the vehicle did something
    // else, and revoking the state would make it flicker on every noisy frame.
    const gate = new MotionGate();
    for (let i = 0; i < 3; i++) gate.push(p('STRAIGHT', 0.9));
    expect(gate.push(p('STRAIGHT', 0.2)).state).toBe('STRAIGHT');
  });

  it('needs a new state to win three frames before it switches', () => {
    const gate = new MotionGate();
    for (let i = 0; i < 3; i++) gate.push(p('STRAIGHT', 0.9));
    gate.push(p('TURNING_LEFT', 0.9));
    gate.push(p('TURNING_LEFT', 0.9));
    expect(gate.state).toBe('STRAIGHT');
    expect(gate.push(p('TURNING_LEFT', 0.9)).state).toBe('TURNING_LEFT');
  });

  it('reports a pothole on the frame it happens', () => {
    // The opposite asymmetry, and deliberately so: a pothole IS a single-frame
    // event, requiring three in a row would mean never seeing one, and a false
    // positive costs one held IMU sample — which is nothing.
    const gate = new MotionGate();
    for (let i = 0; i < 3; i++) gate.push(p('STRAIGHT', 0.9));
    const v = gate.push(p('POTHOLE_EVENT', 0.8));
    expect(v.pothole).toBe(true);
    // And it does not become the vehicle's state: a pothole happens TO a
    // vehicle that is otherwise doing something else.
    expect(v.state).toBe('STRAIGHT');
  });

  it('holds a ZUPT to a higher bar than a status line', () => {
    // ★ THE THRESHOLD IS THE MEASURED PRECISION, NOT A TASTE ★
    // Held-out precision for IDLING is 0.70. Fine for a readout; not fine for
    // zeroing a velocity and teaching a bias estimator.
    const gate = new MotionGate();
    for (let i = 0; i < 3; i++) gate.push(p('IDLING', 0.7));
    expect(gate.state).toBe('IDLING');
    expect(gate.push(p('IDLING', 0.7)).stoppedConfidently).toBe(false);
    expect(gate.push(p('IDLING', 0.95)).stoppedConfidently).toBe(true);
  });

  it('never claims a confident stop while moving', () => {
    const gate = new MotionGate();
    for (let i = 0; i < 4; i++) gate.push(p('STRAIGHT', 0.99));
    expect(gate.push(p('STRAIGHT', 0.99)).stoppedConfidently).toBe(false);
  });

  it('forgets everything on reset', () => {
    const gate = new MotionGate();
    for (let i = 0; i < 3; i++) gate.push(p('BRAKING', 0.9));
    gate.reset();
    expect(gate.state).toBeNull();
  });
});

describe('state helpers', () => {
  it('knows which states mean the vehicle is not travelling', () => {
    expect(isStoppedState('STATIONARY')).toBe(true);
    expect(isStoppedState('IDLING')).toBe(true);
    expect(isStoppedState('STRAIGHT')).toBe(false);
    expect(isStoppedState(null)).toBe(false);
  });

  it('knows which states mean the vehicle is cornering', () => {
    expect(isTurningState('TURNING_LEFT')).toBe(true);
    expect(isTurningState('TURNING_RIGHT')).toBe(true);
    expect(isTurningState('BRAKING')).toBe(false);
  });
});

describe('NullMotionClassifier', () => {
  it('is never ready and never answers', () => {
    const c = new NullMotionClassifier();
    expect(c.isReady()).toBe(false);
    expect(c.predict()).toBeNull();
  });
});

describe('the exported weights', () => {
  const path = new URL('../../../apps/web/public/models/motion_model.json', import.meta.url);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    raw = null;
  }

  it.runIf(raw !== null)('load, and agree with this file about the classes', () => {
    // ★ THE CONTRACT TEST ★ A reordered class list is the failure that does
    // not throw: the model stays 90 % accurate and every answer it hands the
    // engine is wrong, because index 3 means TURNING_LEFT to one side and
    // something else to the other.
    const weights = parseMotionCnnWeights(raw);
    expect(weights.windowSamples).toBe(MOTION_WINDOW_SAMPLES);
    expect(weights.channels).toHaveLength(6);
    expect((raw as { classes: string[] }).classes).toEqual([...MOTION_STATES]);
  });

  it.runIf(raw !== null)('run, and produce a distribution over all eight classes', () => {
    const classifier = new CnnMotionClassifier(parseMotionCnnWeights(raw));
    expect(classifier.isReady()).toBe(true);

    const window = new Float32Array(6 * MOTION_WINDOW_SAMPLES);
    for (let i = 0; i < window.length; i++) window[i] = Math.sin(i * 0.7) * 0.5;

    const out = classifier.predict(window);
    expect(out).not.toBeNull();
    expect(out!.probabilities).toHaveLength(MOTION_STATES.length);
    expect(out!.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(MOTION_STATES).toContain(out!.state);
    expect(out!.confidence).toBeGreaterThan(0);
    expect(out!.confidence).toBeLessThanOrEqual(1);
  });

  it.runIf(raw !== null)('are deterministic', () => {
    const classifier = new CnnMotionClassifier(parseMotionCnnWeights(raw));
    const window = new Float32Array(6 * MOTION_WINDOW_SAMPLES).fill(0.25);
    expect(classifier.predict(window)).toEqual(classifier.predict(window));
  });

  it.runIf(raw !== null)('refuse a window of the wrong length', () => {
    const classifier = new CnnMotionClassifier(parseMotionCnnWeights(raw));
    expect(classifier.predict(new Float32Array(6 * (MOTION_WINDOW_SAMPLES + 1)))).toBeNull();
  });

  it('refuses a model whose class list disagrees with the engine', () => {
    const bad = {
      architecture: 'MotionCNN',
      encoding: 'base64-float32-le',
      windowSamples: MOTION_WINDOW_SAMPLES,
      sampleRateHz: 10,
      channels: ['a', 'b', 'c', 'd', 'e', 'f'],
      scaler: { mean: [0, 0, 0, 0, 0, 0], std: [1, 1, 1, 1, 1, 1] },
      classes: [...MOTION_STATES].reverse(),
      layers: [
        { type: 'linear', inFeatures: 6, outFeatures: 8, weight: zeros(48), bias: zeros(8) },
      ],
    };
    expect(() => parseMotionCnnWeights(bad)).toThrow();
  });

  it('refuses a model that emits the wrong number of classes', () => {
    const bad = {
      architecture: 'MotionCNN',
      encoding: 'base64-float32-le',
      windowSamples: MOTION_WINDOW_SAMPLES,
      sampleRateHz: 10,
      channels: ['a', 'b', 'c', 'd', 'e', 'f'],
      scaler: { mean: [0, 0, 0, 0, 0, 0], std: [1, 1, 1, 1, 1, 1] },
      layers: [
        { type: 'linear', inFeatures: 6, outFeatures: 3, weight: zeros(18), bias: zeros(3) },
      ],
    };
    expect(() => parseMotionCnnWeights(bad)).toThrow(/class mismatch/);
  });

  it('refuses the speed model, which is a different network entirely', () => {
    expect(() => parseMotionCnnWeights({ architecture: 'SpeedCNN' })).toThrow(/architecture/);
  });
});

describe('config', () => {
  it('exposes the thresholds rather than burying them', () => {
    expect(DEFAULT_MOTION_GATE_CONFIG.agreement).toBe(3);
    expect(DEFAULT_MOTION_GATE_CONFIG.stoppedMinConfidence).toBeGreaterThan(
      DEFAULT_MOTION_GATE_CONFIG.minConfidence,
    );
  });
});
