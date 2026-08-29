/**
 * The SpeedCNN forward pass, in pure TypeScript (Phase 8B).
 *
 * ★ WHY NOT ONNX RUNTIME? ★
 * Because it costs 14 MB of WebAssembly to evaluate 26081 parameters. That
 * takes the APK from 5.4 MB to roughly 20 MB — for a model whose weights are
 * 104 KB — and onnxruntime-web additionally fails Next's Terser pass, so it
 * does not even build. Three convolutions and two dense layers do not need a
 * general-purpose graph runtime.
 *
 * Evaluating it here instead means:
 *   · no dependency, no WASM, no build-system fight
 *   · it runs in nav-core, so the Phase 16 edge engine and the eval harness get
 *     inference for free — the payoff of the purity rule, again
 *   · it is testable in Node against probe vectors captured from PyTorch
 *
 * The ONNX export still exists and is still verified against PyTorch. It is the
 * interoperable artefact, and `cnn.test.ts` checks THIS code against outputs
 * PyTorch produced, so the two cannot drift apart silently.
 *
 * BatchNorm does not appear below because `ml/export.py` folds it into the
 * preceding convolution's weights and bias — the whole affine part collapses,
 * which is exact and removes a layer that is easy to get wrong at inference.
 */

import { ML_CHANNELS, ML_SAMPLE_RATE_HZ, ML_WINDOW_SAMPLES } from './speedModel.js';

/** One layer of the exported network. Mirrors `export_folded_weights()`. */
export type SpeedCnnLayer =
  | {
      type: 'conv1d';
      inChannels: number;
      outChannels: number;
      kernel: number;
      padding: number;
      weight: Float32Array;
      bias: Float32Array;
    }
  | { type: 'relu' }
  | { type: 'maxpool1d'; size: number }
  | { type: 'globalAvgPool' }
  | {
      type: 'linear';
      inFeatures: number;
      outFeatures: number;
      weight: Float32Array;
      bias: Float32Array;
    };

export interface SpeedCnnWeights {
  architecture: string;
  windowSamples: number;
  sampleRateHz: number;
  channels: string[];
  scaler: { mean: number[]; std: number[] };
  layers: SpeedCnnLayer[];
}

/** A (channels, time) activation. Row-major, channel-major — as Conv1d wants. */
interface Activation {
  channels: number;
  length: number;
  data: Float32Array;
}

function conv1d(
  x: Activation,
  layer: Extract<SpeedCnnLayer, { type: 'conv1d' }>,
): Activation {
  const { inChannels, outChannels, kernel, padding, weight, bias } = layer;
  // 'same' padding with stride 1: output length equals input length when
  // padding == (kernel - 1) / 2, which is how the model was built.
  const outLen = x.length + 2 * padding - kernel + 1;
  const out = new Float32Array(outChannels * outLen);
  for (let oc = 0; oc < outChannels; oc++) {
    const bo = oc * outLen;
    const b = bias[oc] ?? 0;
    for (let t = 0; t < outLen; t++) {
      let acc = b;
      for (let ic = 0; ic < inChannels; ic++) {
        const wBase = (oc * inChannels + ic) * kernel;
        const xBase = ic * x.length;
        for (let k = 0; k < kernel; k++) {
          // The input index the kernel tap reads, in unpadded coordinates.
          // Outside the signal the padding is zero, so skip rather than read.
          const xi = t + k - padding;
          if (xi < 0 || xi >= x.length) continue;
          acc += weight[wBase + k]! * x.data[xBase + xi]!;
        }
      }
      out[bo + t] = acc;
    }
  }
  return { channels: outChannels, length: outLen, data: out };
}

function relu(x: Activation): Activation {
  const out = new Float32Array(x.data.length);
  for (let i = 0; i < x.data.length; i++) out[i] = Math.max(0, x.data[i]!);
  return { ...x, data: out };
}

function maxPool1d(x: Activation, size: number): Activation {
  // PyTorch's MaxPool1d floors: a trailing partial window is dropped, not
  // padded. Rounding up here would invent a value and shift every later layer.
  const outLen = Math.floor(x.length / size);
  const out = new Float32Array(x.channels * outLen);
  for (let c = 0; c < x.channels; c++) {
    for (let t = 0; t < outLen; t++) {
      let m = -Infinity;
      for (let k = 0; k < size; k++) {
        const v = x.data[c * x.length + t * size + k]!;
        if (v > m) m = v;
      }
      out[c * outLen + t] = m;
    }
  }
  return { channels: x.channels, length: outLen, data: out };
}

function globalAvgPool(x: Activation): Activation {
  const out = new Float32Array(x.channels);
  for (let c = 0; c < x.channels; c++) {
    let s = 0;
    for (let t = 0; t < x.length; t++) s += x.data[c * x.length + t]!;
    out[c] = s / x.length;
  }
  return { channels: x.channels, length: 1, data: out };
}

function linear(
  x: Activation,
  layer: Extract<SpeedCnnLayer, { type: 'linear' }>,
): Activation {
  const { inFeatures, outFeatures, weight, bias } = layer;
  const out = new Float32Array(outFeatures);
  for (let o = 0; o < outFeatures; o++) {
    let acc = bias[o] ?? 0;
    for (let i = 0; i < inFeatures; i++) acc += weight[o * inFeatures + i]! * x.data[i]!;
    out[o] = acc;
  }
  return { channels: outFeatures, length: 1, data: out };
}

/**
 * Evaluate the network.
 *
 * @param samples already scaler-normalised, (channel, time), channel-major —
 *                exactly what `SpeedWindowBuffer.buildWindow()` produces.
 * @returns speed in m/s, or NaN if the input is the wrong shape.
 */
export function runSpeedCnn(weights: SpeedCnnWeights, samples: Float32Array): number {
  const channels = weights.channels.length;
  if (samples.length !== channels * weights.windowSamples) return Number.NaN;

  let x: Activation = {
    channels,
    length: weights.windowSamples,
    data: samples,
  };

  for (const layer of weights.layers) {
    switch (layer.type) {
      case 'conv1d':
        x = conv1d(x, layer);
        break;
      case 'relu':
        x = relu(x);
        break;
      case 'maxpool1d':
        x = maxPool1d(x, layer.size);
        break;
      case 'globalAvgPool':
        x = globalAvgPool(x);
        break;
      case 'linear':
        x = linear(x, layer);
        break;
    }
  }

  const v = x.data[0];
  return v === undefined || !Number.isFinite(v) ? Number.NaN : v;
}

/** Decode one base64 little-endian float32 block. */
export function decodeFloat32(b64: string): Float32Array {
  // Deliberately not atob(): that is a browser global, and this package has to
  // run in Node too. Decoding 4 characters at a time into 3 bytes is a dozen
  // lines and keeps the purity rule intact.
  const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // The regex strips '=' along with everything else, so the padding count has
  // to come from the length that is left, NOT from the original string. Using
  // `clean.length * 3 / 4 - padding` double-counts it and asks for a buffer
  // whose byte length is not a multiple of four, which Float32Array rejects.
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    // A trailing group may be short. Missing characters contribute nothing,
    // and the bytes they would have produced fall outside `bytes`.
    const c0 = TABLE.indexOf(clean[i] ?? 'A');
    const c1 = TABLE.indexOf(clean[i + 1] ?? 'A');
    const c2 = TABLE.indexOf(clean[i + 2] ?? 'A');
    const c3 = TABLE.indexOf(clean[i + 3] ?? 'A');
    const n =
      (Math.max(0, c0) << 18) |
      (Math.max(0, c1) << 12) |
      (Math.max(0, c2) << 6) |
      Math.max(0, c3);
    if (p < bytes.length) bytes[p++] = (n >> 16) & 0xff;
    if (p < bytes.length) bytes[p++] = (n >> 8) & 0xff;
    if (p < bytes.length) bytes[p++] = n & 0xff;
  }
  if (bytes.length % 4 !== 0) {
    throw new Error(
      `base64 block is ${bytes.length} bytes, not a whole number of float32 — ` +
        'a truncated block would leave a weight array silently one element short',
    );
  }
  // Copy into an aligned buffer: byteOffset need not be a multiple of 4.
  return new Float32Array(bytes.buffer.slice(0));
}

/** Decode a block and insist it is the size the layer says it is. */
function block(b64: unknown, expected: number, what: string): Float32Array {
  const arr = decodeFloat32(String(b64));
  if (arr.length !== expected) {
    throw new Error(`${what}: expected ${expected} floats, got ${arr.length}`);
  }
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i]!)) {
      throw new Error(`${what}: non-finite weight at index ${i} (NaN or Infinity)`);
    }
  }
  return arr;
}

/**
 * Turn the JSON that `ml/export.py` writes into usable weights.
 *
 * ★ VALIDATES EVERYTHING, AND REFUSES RATHER THAN COPES. ★
 *
 * Every check here exists because the failure it prevents is SILENT. A weight
 * block one element short still decodes; the convolution then reads past its
 * end, JavaScript hands back `undefined`, and the network answers NaN forever
 * while the debug panel cheerfully reports "model loaded". A `windowSamples`
 * of 100 in a file trained at a different rate is worse still: the engine keeps
 * building 20-sample windows, `runSpeedCnn` rejects every one of them, and the
 * app silently runs on integrated speed while claiming the AI is live.
 *
 * A model that half-loads and answers plausible nonsense is far worse than one
 * that refuses to load at all — the second gets investigated.
 */
export function parseSpeedCnnWeights(raw: unknown): SpeedCnnWeights {
  const j = raw as Record<string, unknown>;
  if (j?.['architecture'] !== 'SpeedCNN') {
    throw new Error(`unexpected architecture "${String(j?.['architecture'])}"`);
  }
  if (j['encoding'] !== 'base64-float32-le') {
    throw new Error(`unexpected weight encoding "${String(j['encoding'])}"`);
  }
  // ── The contract with the engine ──────────────────────────────────────────
  // These three must match the constants the engine builds windows from, or
  // every prediction is silently discarded.
  const windowSamples = Number(j['windowSamples']);
  if (windowSamples !== ML_WINDOW_SAMPLES) {
    throw new Error(
      `window mismatch: model wants ${windowSamples} samples, engine builds ${ML_WINDOW_SAMPLES}`,
    );
  }
  const sampleRateHz = Number(j['sampleRateHz']);
  if (sampleRateHz !== ML_SAMPLE_RATE_HZ) {
    throw new Error(
      `rate mismatch: model wants ${sampleRateHz} Hz, engine decimates to ${ML_SAMPLE_RATE_HZ}`,
    );
  }
  const channels = j['channels'];
  if (!Array.isArray(channels) || channels.length !== ML_CHANNELS) {
    throw new Error(
      `channel mismatch: model has ${Array.isArray(channels) ? channels.length : '?'}, engine sends ${ML_CHANNELS}`,
    );
  }

  const layersRaw = j['layers'];
  if (!Array.isArray(layersRaw)) throw new Error('weights have no layers');
  if (layersRaw.length === 0) throw new Error('weights have an empty layer list');

  const layers: SpeedCnnLayer[] = layersRaw.map((l: Record<string, unknown>) => {
    switch (l['type']) {
      case 'conv1d': {
        const inChannels = Number(l['inChannels']);
        const outChannels = Number(l['outChannels']);
        const kernel = Number(l['kernel']);
        if (!(inChannels > 0 && outChannels > 0 && kernel > 0)) {
          throw new Error('conv1d has a non-positive dimension');
        }
        return {
          type: 'conv1d',
          inChannels,
          outChannels,
          kernel,
          padding: Number(l['padding']),
          weight: block(l['weight'], outChannels * inChannels * kernel, 'conv1d weight'),
          bias: block(l['bias'], outChannels, 'conv1d bias'),
        };
      }
      case 'linear': {
        const inFeatures = Number(l['inFeatures']);
        const outFeatures = Number(l['outFeatures']);
        if (!(inFeatures > 0 && outFeatures > 0)) {
          throw new Error('linear has a non-positive dimension');
        }
        return {
          type: 'linear',
          inFeatures,
          outFeatures,
          weight: block(l['weight'], outFeatures * inFeatures, 'linear weight'),
          bias: block(l['bias'], outFeatures, 'linear bias'),
        };
      }
      case 'relu':
        return { type: 'relu' };
      case 'maxpool1d':
        return { type: 'maxpool1d', size: Number(l['size']) };
      case 'globalAvgPool':
        return { type: 'globalAvgPool' };
      default:
        throw new Error(`unknown layer type "${String(l['type'])}"`);
    }
  });

  const scaler = j['scaler'] as { mean: number[]; std: number[] } | undefined;
  if (!Array.isArray(scaler?.mean) || !Array.isArray(scaler?.std)) {
    throw new Error('weights carry no scaler');
  }
  if (scaler.mean.length !== ML_CHANNELS || scaler.std.length !== ML_CHANNELS) {
    throw new Error(
      `scaler has ${scaler.mean.length}/${scaler.std.length} channels, expected ${ML_CHANNELS}`,
    );
  }
  for (let i = 0; i < ML_CHANNELS; i++) {
    if (!Number.isFinite(scaler.mean[i]!) || !Number.isFinite(scaler.std[i]!)) {
      throw new Error(`scaler channel ${i} is not finite`);
    }
    // A zero std divides the window to Infinity for that channel.
    if (scaler.std[i] === 0) throw new Error(`scaler std for channel ${i} is zero`);
  }

  return {
    architecture: 'SpeedCNN',
    windowSamples,
    sampleRateHz,
    channels: channels as string[],
    scaler,
    layers,
  };
}

/** A `SpeedPredictor` backed by the pure-TypeScript network above. */
export class CnnSpeedPredictor {
  private latencyMs = Number.NaN;

  constructor(private readonly weights: SpeedCnnWeights) {}

  get lastLatencyMs(): number {
    return this.latencyMs;
  }

  get scaler(): { mean: number[]; std: number[] } {
    return this.weights.scaler;
  }

  isReady(): boolean {
    return this.weights.layers.length > 0;
  }

  predict(samples: Float32Array): number {
    return runSpeedCnn(this.weights, samples);
  }
}
