/**
 * Loads the trained speed model for the app (Phase 8B).
 *
 * All this does is fetch and parse. The network itself is evaluated by
 * `runSpeedCnn` in nav-core, in pure TypeScript — see the long note in
 * `packages/nav-core/src/ml/cnn.ts` for why there is no ONNX Runtime here.
 * Loading a file is a browser concern, so it lives in apps/web; the maths is
 * not, so it does not.
 */

import { CnnSpeedPredictor, parseSpeedCnnWeights } from '@pathpulse/nav-core';

export interface ModelInfo {
  loaded: boolean;
  /** Why it is not loaded, when it is not. Shown in the debug panel. */
  error: string | null;
  sizeBytes: number;
  latencyMs: number;
  inferences: number;
}

export const EMPTY_MODEL_INFO: ModelInfo = {
  loaded: false,
  error: null,
  sizeBytes: 0,
  latencyMs: NaN,
  inferences: 0,
};

const MODEL_URL = 'models/speed_model.json';

/**
 * Wraps nav-core's predictor with the timing and byte count the panel shows.
 *
 * Inference is synchronous and takes microseconds, so unlike an ONNX session
 * there is nothing async to hide: `predict()` really does answer from the
 * window it was given.
 */
export class WebSpeedPredictor {
  private inner: CnnSpeedPredictor | null = null;
  private latency = NaN;
  private count = 0;
  private failure: string | null = null;
  private bytes = 0;

  get lastLatencyMs(): number {
    return this.latency;
  }

  get info(): ModelInfo {
    return {
      loaded: this.inner !== null,
      error: this.failure,
      sizeBytes: this.bytes,
      latencyMs: this.latency,
      inferences: this.count,
    };
  }

  get scaler(): { mean: number[]; std: number[] } | null {
    return this.inner?.scaler ?? null;
  }

  /**
   * Fetch and parse the weights.
   *
   * Never throws. A missing or malformed model must leave the app running on
   * integrated speed with an honest line in the debug panel — the guide is
   * explicit that a failed model load may not take the demo down with it.
   */
  async load(basePath = ''): Promise<boolean> {
    try {
      const res = await fetch(`${basePath}${MODEL_URL}`);
      if (!res.ok) throw new Error(`speed_model.json: HTTP ${res.status}`);
      const text = await res.text();
      this.bytes = text.length;
      this.inner = new CnnSpeedPredictor(parseSpeedCnnWeights(JSON.parse(text)));
      this.failure = null;
      return true;
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
      this.inner = null;
      return false;
    }
  }

  isReady(): boolean {
    return this.inner !== null;
  }

  predict(samples: Float32Array): number {
    if (!this.inner) return NaN;
    const t0 = performance.now();
    const v = this.inner.predict(samples);
    this.latency = performance.now() - t0;
    this.count++;
    return v;
  }

  dispose(): void {
    this.inner = null;
  }
}
