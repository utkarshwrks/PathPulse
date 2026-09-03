/**
 * Loads the trained motion-state classifier for the app (Phase 13, Model 2).
 *
 * Fetch and parse, nothing else. The network is evaluated by nav-core in pure
 * TypeScript — see the note in `packages/nav-core/src/ml/cnn.ts` for why there
 * is no ONNX Runtime here. Loading a file is a browser concern and lives in
 * apps/web; the maths is not, and does not.
 */

import {
  CnnMotionClassifier,
  parseMotionCnnWeights,
  type MotionClassifier,
  type MotionPrediction,
} from '@pathpulse/nav-core';
import type { ModelInfo } from './speedModel';

export { EMPTY_MODEL_INFO } from './speedModel';

const MODEL_URL = 'models/motion_model.json';

/**
 * Wraps nav-core's classifier with the timing and byte count the panel shows.
 *
 * ★ A FAILED LOAD MUST NEVER TAKE THE APP DOWN ★
 * The same contract as the speed model, and for the same reason: the engine
 * ran on thresholds before this model existed and still does when it is
 * absent. What is not allowed is failing silently — the debug panel reports
 * the reason, because a model that is quietly not consulted is
 * indistinguishable from one that is broken.
 */
export class WebMotionClassifier implements MotionClassifier {
  private inner: CnnMotionClassifier | null = null;
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

  get scaler(): { mean: number[]; std: number[] } {
    return this.inner?.scaler ?? { mean: [0, 0, 0, 0, 0, 0], std: [1, 1, 1, 1, 1, 1] };
  }

  async load(basePath = ''): Promise<boolean> {
    try {
      const res = await fetch(`${basePath}${MODEL_URL}`);
      if (!res.ok) throw new Error(`motion_model.json: HTTP ${res.status}`);
      const text = await res.text();
      this.bytes = text.length;
      this.inner = new CnnMotionClassifier(parseMotionCnnWeights(JSON.parse(text)));
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

  predict(samples: Float32Array): MotionPrediction | null {
    if (!this.inner) return null;
    const t0 = performance.now();
    const out = this.inner.predict(samples);
    this.latency = performance.now() - t0;
    this.count++;
    return out;
  }

  dispose(): void {
    this.inner = null;
  }
}
