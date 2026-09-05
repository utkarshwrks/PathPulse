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

/**
 * Channels the ring buffer stores: the raw device frame, as the sensor gives
 * it. Also the stride of `SpeedWindowBuffer`'s backing array.
 */
export const ML_RAW_CHANNELS = 6; // ax ay az gx gy gz

/**
 * Channels the network reads: the six raw, then six derived from them.
 *
 * ★ THE MODEL WAS SOLVING A PROBLEM THE ENGINE HAD ALREADY SOLVED ★
 *
 * The network used to read only the raw device frame, and the only thing
 * telling it that a phone flat in a cup holder and a phone in a cradle are the
 * same vehicle was the mounting augmentation in training. It had to LEARN
 * rotation invariance from examples, spending capacity on a geometry problem
 * with a closed-form answer — while `AttitudeEstimator`, four files away,
 * computes that answer every sample because dead reckoning cannot work
 * without it.
 *
 * So the answer is handed over instead. Measured on the committed
 * sequence-disjoint split (ml/experiments):
 *
 *   arm                             test MAE      r2    stopped-window MAE
 *   raw, 2 s window (was)           2.909 m/s   0.788        1.513 m/s
 *   raw + derived, 2 s              2.909       0.787        1.327
 *   raw + derived, 6 s              2.758       0.814        —
 *   raw only,      6 s              2.994       0.781        —
 *
 * Two findings there, not one. The derived channels alone barely move the
 * headline MAE but cut error on STOPPED windows by 12 % — the case that
 * matters most, because a phantom 5 m/s at a red light integrates into a
 * hundred metres of invented travel. And the longer window only pays WITH
 * them: at 6 s the raw-only model is worse than it was at 2 s, because more
 * of a signal it cannot align is not more information.
 */
export const ML_MODEL_CHANNELS = 12;

/**
 * @deprecated Ambiguous now that the ring and the network disagree. Kept
 * pointing at the ring's width, which is what every existing caller meant.
 */
export const ML_CHANNELS = ML_RAW_CHANNELS;

/** 6 seconds at 10 Hz. See ML_MODEL_CHANNELS for why it grew from 2 s. */
export const ML_WINDOW_SAMPLES = 60;

/** Names of the six derived channels, in order. Matches ml/experiments/channels.py. */
export const ML_DERIVED_CHANNEL_NAMES = [
  'a_mag',
  'a_vert',
  'a_horiz',
  'w_mag',
  'w_vert',
  'w_horiz',
] as const;

/**
 * Append the mount-invariant channels to a raw window, in place.
 *
 * `raw` is (6, n) channel-major — a_x a_y a_z g_x g_y g_z — and `out` is
 * (12, n) in the same layout, whose first six rows are `raw`. Every derived
 * channel is invariant to how the phone is held:
 *
 *   |a|      total specific force
 *   a . ĝ    the component along gravity: vertical, whatever vertical means
 *            for this handset. Roughly 9.81 plus road bumps.
 *   |a_h|    what is left in the horizontal plane once gravity is removed —
 *            braking, cornering, and the vehicle's own vibration
 *   |ω|      total angular rate
 *   ω . ĝ    yaw rate about the TRUE vertical. This is the turn signal, and in
 *            the raw channels it is smeared across gx, gy and gz by whatever
 *            angle the phone happens to sit at.
 *   |ω_h|    pitch and roll rate: suspension, not steering.
 *
 * ★ GRAVITY IS THE WINDOW MEAN, WHICH IS WHAT THE ENGINE ALREADY ASSUMES ★
 * One estimate per window, from the mean specific force — the same thing the
 * gravity split does. Over six seconds that is dominated by gravity even under
 * braking, and whatever bias it carries is the bias the engine carries too, so
 * the model is fed at inference exactly the signal it was trained on.
 *
 * Deliberately stateless and filter-free: anything with memory would have to be
 * kept identical between here and the Python that trained the weights, and
 * two implementations of a filter is two implementations to drift apart.
 */
export function appendDerivedChannels(raw: Float32Array, n: number, out: Float32Array): void {
  // Gravity direction, from the mean specific force over the whole window.
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let t = 0; t < n; t++) {
    mx += raw[t]!;
    my += raw[n + t]!;
    mz += raw[2 * n + t]!;
  }
  mx /= n;
  my /= n;
  mz /= n;
  let norm = Math.hypot(mx, my, mz);
  // A window whose mean acceleration is zero has no usable vertical. It cannot
  // happen to a phone on Earth, but it can happen to a synthetic test vector,
  // and dividing by it would poison every derived channel with NaN.
  if (!(norm > 1e-6)) norm = 1;
  const ux = mx / norm;
  const uy = my / norm;
  const uz = mz / norm;

  for (let t = 0; t < n; t++) {
    const ax = raw[t]!;
    const ay = raw[n + t]!;
    const az = raw[2 * n + t]!;
    const wx = raw[3 * n + t]!;
    const wy = raw[4 * n + t]!;
    const wz = raw[5 * n + t]!;

    const aVert = ax * ux + ay * uy + az * uz;
    const wVert = wx * ux + wy * uy + wz * uz;

    out[6 * n + t] = Math.hypot(ax, ay, az);
    out[7 * n + t] = aVert;
    out[8 * n + t] = Math.hypot(ax - aVert * ux, ay - aVert * uy, az - aVert * uz);
    out[9 * n + t] = Math.hypot(wx, wy, wz);
    out[10 * n + t] = wVert;
    out[11 * n + t] = Math.hypot(wx - wVert * ux, wy - wVert * uy, wz - wVert * uz);
  }
}

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
    this.buf = new Float32Array(windowSamples * ML_RAW_CHANNELS);
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
    for (let i = 0; i < ML_RAW_CHANNELS; i++) {
      const x = v[i]!;
      this.buf[this.head * ML_RAW_CHANNELS + i] = Number.isFinite(x) ? x : 0;
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
    const channels = mean.length >= ML_MODEL_CHANNELS ? ML_MODEL_CHANNELS : ML_RAW_CHANNELS;
    const out = new Float32Array(channels * n);

    // ★ DERIVE BEFORE SCALING, NOT AFTER ★
    // The derived channels are non-linear functions of the raw ones — norms
    // and dot products — so computing them from already-standardised inputs
    // gives a different quantity entirely, and one the network never saw. The
    // Python does the same thing in the same order; `probes.json` is what
    // stops the two drifting apart.
    for (let t = 0; t < n; t++) {
      const src = (this.head + t) % n;
      for (let c = 0; c < ML_RAW_CHANNELS; c++) {
        out[c * n + t] = this.buf[src * ML_RAW_CHANNELS + c]!;
      }
    }
    if (channels === ML_MODEL_CHANNELS) appendDerivedChannels(out, n, out);

    for (let c = 0; c < channels; c++) {
      const m = mean[c] ?? 0;
      const s = std[c] ?? 1;
      const d = s === 0 ? 1 : s;
      for (let t = 0; t < n; t++) out[c * n + t] = (out[c * n + t]! - m) / d;
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
