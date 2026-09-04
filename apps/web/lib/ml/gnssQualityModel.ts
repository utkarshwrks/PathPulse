/**
 * Loads the GNSS quality classifier for the app (Phase 13, Model 4).
 *
 * Fetch and parse only, exactly like the other three. The network is evaluated
 * by nav-core in pure TypeScript.
 */
import {
  MlpGnssQualityClassifier,
  parseGnssQualityWeights,
  type GnssQualityClassifier,
  type GnssQualityPrediction,
} from '@pathpulse/nav-core';
import type { ModelInfo } from './speedModel';

const MODEL_URL = 'models/gnss_quality_model.json';

/**
 * ★ A FAILED LOAD MUST NEVER TAKE THE APP DOWN ★
 * The fourth model with the fourth independent loader. One broken network must
 * not disable the three that work, and a model that is quietly not consulted
 * is indistinguishable from one that is broken — so the reason is reported.
 */
export class WebGnssQualityClassifier implements GnssQualityClassifier {
  private inner: MlpGnssQualityClassifier | null = null;
  private failure: string | null = null;
  private bytes = 0;
  private count = 0;
  private latency = NaN;

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
    return this.inner?.scaler ?? { mean: [], std: [] };
  }

  async load(basePath = ''): Promise<boolean> {
    try {
      const res = await fetch(`${basePath}${MODEL_URL}`);
      if (!res.ok) throw new Error(`gnss_quality_model.json: HTTP ${res.status}`);
      const text = await res.text();
      this.bytes = text.length;
      this.inner = new MlpGnssQualityClassifier(parseGnssQualityWeights(JSON.parse(text)));
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

  predict(features: Float32Array): GnssQualityPrediction | null {
    if (!this.inner) return null;
    const t0 = performance.now();
    const out = this.inner.predict(features);
    this.latency = performance.now() - t0;
    this.count++;
    return out;
  }

  dispose(): void {
    this.inner = null;
  }
}
