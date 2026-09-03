/**
 * The speed model's contract with the engine (Phase 8B).
 *
 * PURITY RULE: this file is pure TypeScript, like everything in nav-core. It
 * defines the INTERFACE and the windowing maths; it never loads a model. ONNX
 * lives in `apps/web/lib/ml/onnxSpeedPredictor.ts`, because loading a file is a
 * browser concern and nav-core has to keep running in Node, in tests, and in
 * the Phase 16 edge engine.
 */

/**
 * Constants shared with the Python side. These are a CONTRACT: they must match
 * `ml/config.py` and the `scaler.json` shipped beside the weights, or the
 * network silently receives windows shaped like nothing it ever trained on.
 * `OnnxSpeedPredictor` checks the scaler against these at load time.
 */
export const ML_SAMPLE_RATE_HZ = 10;
export const ML_WINDOW_SAMPLES = 20; // 2 seconds at 10 Hz
export const ML_CHANNELS = 6; // ax ay az gx gy gz

/** Predicts vehicle speed from a window of conditioned IMU samples. */
export interface SpeedPredictor {
  /**
   * Speed in m/s for the supplied window.
   *
   * ★ May return the most recent COMPLETED inference rather than one computed
   * from this exact window. ONNX Runtime's web API is asynchronous, and the
   * engine runs at 10 Hz on the UI thread — blocking it for even 12 ms per
   * sample to keep the signature honest would cost more than the staleness
   * does. A window is 2 s of history and predictions are held for 1 s anyway,
   * so one extra frame of lag is immaterial.
   */
  predict(samples: Float32Array): number;
  isReady(): boolean;
  /**
   * Wall-clock cost of the last inference, ms, if the implementation can
   * measure it. nav-core cannot: `performance.now()` is a browser API and the
   * purity rule forbids it, so the number has to come from whoever owns a
   * clock. Optional, because MockSpeedPredictor has nothing to report.
   */
  readonly lastLatencyMs?: number;
}

/** A predictor that is never ready. The engine's default, and its fallback. */
export class NullSpeedPredictor implements SpeedPredictor {
  predict(): number {
    return Number.NaN;
  }
  isReady(): boolean {
    return false;
  }
}

/**
 * A deterministic stand-in for tests: returns whatever it is told to.
 *
 * Exists so the engine's ML branch can be exercised without ONNX, a model
 * file, or a browser — which is the whole point of keeping the interface here
 * and the implementation somewhere else.
 */
export class MockSpeedPredictor implements SpeedPredictor {
  private value: number;
  private ready: boolean;
  /** Every window it was asked about, for assertions. */
  readonly seen: Float32Array[] = [];

  constructor(value = 0, ready = true) {
    this.value = value;
    this.ready = ready;
  }

  setValue(v: number): void {
    this.value = v;
  }

  setReady(r: boolean): void {
    this.ready = r;
  }

  predict(samples: Float32Array): number {
    this.seen.push(samples);
    return this.value;
  }

  isReady(): boolean {
    return this.ready;
  }
}

/**
 * Collects the live IMU stream into the fixed-size windows the model expects.
 *
 * ★ DECIMATES TO 10 Hz. ★ The model was trained on IO-VNBD, which logs its
 * smartphone at 10 Hz, and a network fed 50 Hz data would see two seconds of
 * training compressed into 0.4 s of input — a completely different signal.
 * Handsets deliver anywhere from 14 to 60 Hz and the rate wanders, so the
 * buffer accepts a sample only once `1000 / ML_SAMPLE_RATE_HZ` ms of
 * monotonic time has passed, rather than counting samples.
 */
export class SpeedWindowBuffer {
  private readonly buf: Float32Array;
  private count = 0;
  private head = 0;
  private nextAcceptT: number | null = null;
  private lastT: number | null = null;
  private readonly periodMs = 1000 / ML_SAMPLE_RATE_HZ;

  /**
   * @param windowSamples how many 10 Hz samples the model wants.
   *
   * A parameter rather than a constant because Phase 13's motion classifier
   * reads one second where the speed regressor reads two. The decimation, the
   * clock-jump handling and the channel ordering are identical and hard-won,
   * and were not worth writing twice.
   */
  constructor(private readonly windowSamples: number = ML_WINDOW_SAMPLES) {
    this.buf = new Float32Array(windowSamples * ML_CHANNELS);
  }

  /** True when the sample was taken (i.e. it landed on the 10 Hz grid). */
  push(
    t: number,
    ax: number,
    ay: number,
    az: number,
    gx: number,
    gy: number,
    gz: number,
  ): boolean {
    if (!Number.isFinite(t)) return false;
    // ★ A CLOCK THAT RUNS BACKWARDS MUST NOT STALL THE MODEL FOREVER. ★
    //
    // The accept deadline lives in the future. If the clock jumps back — an
    // Android boot-time base changing, a WebView timestamp resetting, a replay
    // restarting — the deadline stays where it was and every subsequent sample
    // is rejected for as long as it takes real time to catch up. On a jump of
    // any size that is the rest of the session, with nothing on screen to say
    // the model has quietly stopped being fed.
    //
    // Going backwards is not a sample to skip, it is a new timeline. Re-base.
    if (this.lastT !== null && t < this.lastT) {
      this.nextAcceptT = null;
    }
    this.lastT = t;
    if (this.nextAcceptT !== null && t < this.nextAcceptT) return false;
    // Re-base rather than accumulate: after a pause (a backgrounded tab, a
    // stalled sensor) advancing by one period at a time would accept a burst
    // of consecutive samples to "catch up" and pack them into the window at
    // the wrong rate.
    this.nextAcceptT = t + this.periodMs;

    const v = [ax, ay, az, gx, gy, gz];
    for (let i = 0; i < ML_CHANNELS; i++) {
      const x = v[i]!;
      this.buf[this.head * ML_CHANNELS + i] = Number.isFinite(x) ? x : 0;
    }
    this.head = (this.head + 1) % this.windowSamples;
    if (this.count < this.windowSamples) this.count++;
    return true;
  }

  get isFull(): boolean {
    return this.count >= this.windowSamples;
  }

  /**
   * The window in (channel, time) order — what Conv1d wants — normalised by
   * the supplied scaler. Oldest sample first; `head` is the next slot to
   * write, which is also the oldest entry once the ring is full.
   */
  buildWindow(mean: readonly number[], std: readonly number[]): Float32Array | null {
    if (!this.isFull) return null;
    const n = this.windowSamples;
    const out = new Float32Array(ML_CHANNELS * n);
    for (let t = 0; t < n; t++) {
      const src = (this.head + t) % n;
      for (let c = 0; c < ML_CHANNELS; c++) {
        const s = std[c] ?? 1;
        out[c * n + t] =
          (this.buf[src * ML_CHANNELS + c]! - (mean[c] ?? 0)) / (s === 0 ? 1 : s);
      }
    }
    return out;
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.nextAcceptT = null;
    this.lastT = null;
    this.buf.fill(0);
  }
}

/**
 * Smooths successive predictions with a moving average.
 *
 * Measured on the held-out sequence: raw per-window predictions give 3.65 m/s
 * MAE, a 5 s mean gives 3.32 m/s. Windows overlap by half, so consecutive
 * predictions share half their input but their errors are still largely
 * independent — which is exactly the condition under which averaging helps.
 */
/**
 * The same ring buffer, named for what it actually is.
 *
 * `SpeedWindowBuffer` is kept as the export Phase 8 uses so nothing has to
 * change; this alias is what Phase 13 imports, because a motion classifier
 * holding something called a speed buffer reads as a mistake.
 */
export { SpeedWindowBuffer as ImuWindowBuffer };

export class SpeedSmoother {
  private readonly ring: number[] = [];

  constructor(private readonly size = 5) {}

  push(v: number): number {
    if (!Number.isFinite(v)) return this.value;
    this.ring.push(v);
    if (this.ring.length > this.size) this.ring.shift();
    return this.value;
  }

  get value(): number {
    if (this.ring.length === 0) return Number.NaN;
    let s = 0;
    for (const v of this.ring) s += v;
    return s / this.ring.length;
  }

  get count(): number {
    return this.ring.length;
  }

  reset(): void {
    this.ring.length = 0;
  }
}
