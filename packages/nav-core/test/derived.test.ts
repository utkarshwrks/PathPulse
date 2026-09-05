import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ML_DERIVED_CHANNEL_NAMES,
  ML_MODEL_CHANNELS,
  ML_RAW_CHANNELS,
  ML_WINDOW_SAMPLES,
  appendDerivedChannels,
} from '../src/index.js';

/**
 * The mount-invariant channels, checked against the Python that trained on them.
 *
 * ★ THE GAP THIS FILE EXISTS TO CLOSE ★
 *
 * `probes.json` holds windows that have already been derived AND scaled, so it
 * checks the forward pass and nothing before it. The six derived channels are
 * computed twice in this project — in `ml/derived.py`, which produced every
 * weight in the model, and here, which is what runs on the phone. Nothing in
 * the other tests can tell those two apart: if they disagreed, the network
 * would be fed channels it had never trained on, at inference, on a device,
 * while the entire suite stayed green. The model would not crash. It would
 * just be wrong, quietly, in the one place nobody was looking.
 *
 * So `export.py` writes raw windows and the exact arrays `derived.py` produced
 * from them, and this replays them through the TypeScript. Unscaled on purpose:
 * the scaler is a separate step with its own check, and folding it in would let
 * a scaling bug hide a derivation bug.
 */

const HERE = new URL('.', import.meta.url).pathname;
const fixture = JSON.parse(
  readFileSync(join(HERE, 'derived_probes.json'), 'utf8'),
) as {
  channels: string[];
  windowSamples: number;
  raw: number[][];
  derived: number[][];
};

describe('appendDerivedChannels — agreement with the Python', () => {
  it('the fixture describes the contract this code implements', () => {
    expect(fixture.windowSamples).toBe(ML_WINDOW_SAMPLES);
    expect(fixture.channels).toHaveLength(ML_MODEL_CHANNELS);
    // Order is the contract. A reordered list still runs and reads yaw rate as
    // an acceleration.
    expect(fixture.channels.slice(ML_RAW_CHANNELS)).toEqual([...ML_DERIVED_CHANNEL_NAMES]);
  });

  it('★ reproduces every derived channel to within float32 rounding', () => {
    expect(fixture.raw.length).toBeGreaterThan(0);
    const n = ML_WINDOW_SAMPLES;
    fixture.raw.forEach((flatRaw, w) => {
      const out = new Float32Array(ML_MODEL_CHANNELS * n);
      out.set(flatRaw);
      appendDerivedChannels(out, n, out);
      const want = fixture.derived[w]!;
      for (let c = 0; c < ML_MODEL_CHANNELS; c++) {
        for (let t = 0; t < n; t++) {
          const i = c * n + t;
          // The fixture is rounded to six places and these are metres per
          // second squared, so 1e-4 is comfortably tighter than anything that
          // could change a prediction and looser than the rounding.
          expect(out[i]).toBeCloseTo(want[i]!, 4);
        }
      }
    });
  });

  it('leaves the raw channels exactly as they arrived', () => {
    // The derived channels are appended, never written over the inputs. Getting
    // this wrong would corrupt the six channels the model reads first.
    const n = ML_WINDOW_SAMPLES;
    const flatRaw = fixture.raw[0]!;
    const out = new Float32Array(ML_MODEL_CHANNELS * n);
    out.set(flatRaw);
    appendDerivedChannels(out, n, out);
    for (let i = 0; i < ML_RAW_CHANNELS * n; i++) {
      expect(out[i]).toBe(new Float32Array([flatRaw[i]!])[0]);
    }
  });
});

describe('appendDerivedChannels — the properties it exists for', () => {
  /** A window of constant acceleration and rotation, in some device frame. */
  function windowOf(a: [number, number, number], w: [number, number, number]) {
    const n = ML_WINDOW_SAMPLES;
    const out = new Float32Array(ML_MODEL_CHANNELS * n);
    for (let t = 0; t < n; t++) {
      out[t] = a[0];
      out[n + t] = a[1];
      out[2 * n + t] = a[2];
      out[3 * n + t] = w[0];
      out[4 * n + t] = w[1];
      out[5 * n + t] = w[2];
    }
    appendDerivedChannels(out, n, out);
    const n_ = ML_WINDOW_SAMPLES;
    return {
      aMag: out[6 * n_]!,
      aVert: out[7 * n_]!,
      aHoriz: out[8 * n_]!,
      wMag: out[9 * n_]!,
      wVert: out[10 * n_]!,
      wHoriz: out[11 * n_]!,
    };
  }

  /** Rotate a vector about the Z axis — a phone turned in its cradle. */
  function yaw(v: [number, number, number], deg: number): [number, number, number] {
    const r = (deg * Math.PI) / 180;
    return [v[0] * Math.cos(r) - v[1] * Math.sin(r), v[0] * Math.sin(r) + v[1] * Math.cos(r), v[2]];
  }

  it('★ is invariant to how the phone is mounted, which is the whole point', () => {
    // The same vehicle motion, with the handset rotated. Every derived channel
    // must read the same — that invariance is the information the raw channels
    // do not carry and the model was previously made to infer from examples.
    const a: [number, number, number] = [0.4, -0.9, 9.6];
    const w: [number, number, number] = [0.02, -0.01, 0.15];
    const base = windowOf(a, w);
    for (const deg of [37, 90, 180, 271]) {
      const turned = windowOf(yaw(a, deg), yaw(w, deg));
      expect(turned.aMag).toBeCloseTo(base.aMag, 4);
      expect(turned.aVert).toBeCloseTo(base.aVert, 4);
      expect(turned.aHoriz).toBeCloseTo(base.aHoriz, 4);
      expect(turned.wMag).toBeCloseTo(base.wMag, 4);
      expect(turned.wVert).toBeCloseTo(base.wVert, 4);
      expect(turned.wHoriz).toBeCloseTo(base.wHoriz, 4);
    }
  });

  it('reads a level phone at rest as ~1 g straight down and nothing sideways', () => {
    const d = windowOf([0, 0, 9.81], [0, 0, 0]);
    expect(d.aMag).toBeCloseTo(9.81, 3);
    expect(d.aVert).toBeCloseTo(9.81, 3);
    expect(d.aHoriz).toBeCloseTo(0, 4);
  });

  it('★ puts a yaw rate in w_vert whatever axis the sensor reported it on', () => {
    // The turn signal. On a level phone it is gz; tilt the handset ninety
    // degrees and the same turn appears on gy instead — which is exactly what
    // the raw channels cannot tell the model, and why turning is the thing
    // these channels most improve.
    const level = windowOf([0, 0, 9.81], [0, 0, 0.2]);
    const onItsSide = windowOf([0, 9.81, 0], [0, 0.2, 0]);
    expect(level.wVert).toBeCloseTo(0.2, 4);
    expect(onItsSide.wVert).toBeCloseTo(0.2, 4);
    expect(level.wHoriz).toBeCloseTo(0, 4);
    expect(onItsSide.wHoriz).toBeCloseTo(0, 4);
  });

  it('survives a window whose mean acceleration is zero', () => {
    // Impossible for a phone on Earth, possible for a synthetic vector, and a
    // divide by that zero would fill all six channels with NaN.
    const d = windowOf([0, 0, 0], [0, 0, 0.1]);
    expect(Number.isFinite(d.aMag)).toBe(true);
    expect(Number.isFinite(d.wVert)).toBe(true);
  });

  it('keeps the Pythagorean identity between the magnitude and its parts', () => {
    // |a|^2 = vertical^2 + horizontal^2. Not a restatement of the code: it is
    // what fails if the projection is taken against an unnormalised gravity.
    const d = windowOf([1.2, -3.4, 9.1], [0.05, 0.02, -0.11]);
    expect(Math.hypot(d.aVert, d.aHoriz)).toBeCloseTo(d.aMag, 4);
    expect(Math.hypot(d.wVert, d.wHoriz)).toBeCloseTo(d.wMag, 4);
  });
});
