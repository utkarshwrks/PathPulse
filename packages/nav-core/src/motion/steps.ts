/**
 * Pedestrian dead reckoning: speed from footsteps.
 *
 * ★ WHY THIS HAD TO EXIST ★
 *
 * Holding the vehicle-trained speed model back on foot was correct and it left
 * a hole. During a GNSS outage a walker had no speed source at all: the model
 * declines, integration is arrested by ZUPT and the coasting decay, and the
 * HUD read `DEAD RECKONING · ON FOOT · 0 km/h` with the marker sitting still
 * while the person kept walking. Recoveries measured 210 m over 564 m — 37 %
 * — and essentially all of that was the estimate having stopped rather than
 * having drifted. An engine whose entire claim is navigation without GNSS
 * cannot freeze the moment GNSS goes.
 *
 * ★ THE SIGNAL WAS NEVER NOISE ★
 *
 * The same accelerometer swing that makes a car model saturate is a clean,
 * almost periodic signal at one to three hertz, and it is not interference —
 * it is the measurement. Each peak is a foot landing. Speed is then step rate
 * times stride length, which is the classical PDR result and holds up far
 * better at walking pace than anything integration can do: cadence is measured
 * directly and never accumulates error, so unlike an integrated velocity this
 * estimate does not get worse the longer the outage lasts.
 *
 * Stride length is the only unknown, it varies by maybe 30 % between people,
 * and we can watch it: while GNSS is up we know the speed and we know the
 * cadence, so we learn the ratio and keep it for when GNSS is not.
 */

export interface StepDetectorConfig {
  /**
   * How far above the running mean a peak must reach to be a footstep,
   * m/s^2. A walk with the handset in a hand swings 3-5; the residual on a
   * still phone is under 0.1.
   */
  peakThresholdMps2: number;
  /** Minimum gap between two steps, ms. 250 ms is four steps a second. */
  refractoryMs: number;
  /** No step within this and the cadence is zero again, ms. */
  stepTimeoutMs: number;
  /** Step intervals kept for the cadence median. */
  intervalWindow: number;
  /** Time constant of the tracker that follows gravity plus the slow mean, ms. */
  dcTauMs: number;
  /** Cadence outside this band is not walking, Hz. */
  minCadenceHz: number;
  maxCadenceHz: number;
}

export const DEFAULT_STEP_CONFIG: StepDetectorConfig = {
  peakThresholdMps2: 1.2,
  refractoryMs: 250,
  stepTimeoutMs: 1600,
  intervalWindow: 7,
  dcTauMs: 1500,
  minCadenceHz: 0.6,
  maxCadenceHz: 3.5,
};

/**
 * Counts footsteps in accelerometer magnitude.
 *
 * Magnitude rather than any single axis, deliberately: a phone in a hand, in a
 * pocket and in a bag have three different axes pointing down, and magnitude
 * is the same signal in all three. It costs the direction of the step, which
 * we do not use.
 */
export class StepDetector {
  private readonly config: StepDetectorConfig;
  private dc = 0;
  private hasDc = false;
  private armed = true;
  private lastStepT: number | null = null;
  private readonly intervals: number[] = [];
  private stepCount = 0;

  constructor(config: Partial<StepDetectorConfig> = {}) {
    this.config = { ...DEFAULT_STEP_CONFIG, ...config };
  }

  get steps(): number {
    return this.stepCount;
  }

  /**
   * @param accelMagnitude |a|, gravity included, m/s^2
   * @returns true on the sample a step is declared
   */
  push(tMs: number, accelMagnitude: number, dtMs: number): boolean {
    if (!Number.isFinite(accelMagnitude) || !Number.isFinite(dtMs) || dtMs <= 0) return false;

    // Follow gravity plus the slow mean, so the residual is the step signal and
    // nothing has to know which way is down.
    const alpha = Math.min(1, dtMs / this.config.dcTauMs);
    this.dc = this.hasDc ? this.dc + alpha * (accelMagnitude - this.dc) : accelMagnitude;
    this.hasDc = true;
    const residual = accelMagnitude - this.dc;

    // ★ ARM ON THE WAY DOWN, FIRE ON THE WAY UP ★
    // A single footstep is not a single sample above the threshold — it is a
    // burst of them, plus the ringing that follows. Requiring the signal to
    // fall back through zero before another step can be declared turns that
    // burst into one event, and the refractory window catches the rest.
    if (residual < 0) this.armed = true;

    if (
      this.armed &&
      residual > this.config.peakThresholdMps2 &&
      (this.lastStepT === null || tMs - this.lastStepT >= this.config.refractoryMs)
    ) {
      if (this.lastStepT !== null) {
        this.intervals.push(tMs - this.lastStepT);
        if (this.intervals.length > this.config.intervalWindow) this.intervals.shift();
      }
      this.lastStepT = tMs;
      this.armed = false;
      this.stepCount++;
      return true;
    }
    return false;
  }

  /**
   * Steps per second, or 0 when the carrier is not walking.
   *
   * A median of recent intervals, not a mean: one missed step doubles an
   * interval, and a mean would report half the true cadence for the next
   * several samples while a median does not notice.
   */
  cadenceHz(tMs: number): number {
    if (this.lastStepT === null) return 0;
    if (tMs - this.lastStepT > this.config.stepTimeoutMs) return 0;
    if (this.intervals.length < 3) return 0;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)]!;
    if (!(medianMs > 0)) return 0;
    const hz = 1000 / medianMs;
    if (hz < this.config.minCadenceHz || hz > this.config.maxCadenceHz) return 0;
    return hz;
  }

  reset(): void {
    this.dc = 0;
    this.hasDc = false;
    this.armed = true;
    this.lastStepT = null;
    this.intervals.length = 0;
    this.stepCount = 0;
  }
}

export interface StrideModelConfig {
  /** Starting stride length, metres per step, before anything is learned. */
  defaultStrideM: number;
  /** Bounds on a plausible stride, m. Outside this it is not a person walking. */
  minStrideM: number;
  maxStrideM: number;
  /** Weight given to each new observation. */
  learningRate: number;
  /** Observations below this cadence are too sparse to learn from, Hz. */
  minLearningCadenceHz: number;
}

export const DEFAULT_STRIDE_CONFIG: StrideModelConfig = {
  // 0.72 m is a common adult walking figure and only ever a starting point:
  // one GNSS observation replaces most of it.
  defaultStrideM: 0.72,
  minStrideM: 0.35,
  maxStrideM: 1.1,
  learningRate: 0.15,
  minLearningCadenceHz: 1.0,
};

/**
 * Stride length, learned from GNSS while GNSS is available.
 *
 * ★ THE CALIBRATION IS THE WHOLE POINT ★
 * A fixed 0.72 m stride is a guess that is wrong by up to a third for a short
 * or a tall person, and being wrong by a third is exactly the error dead
 * reckoning exists to avoid. Every second of good GNSS is a free measurement
 * of this one number — speed divided by cadence — so by the time an outage
 * arrives it is not a guess any more. It is the same trick ZUPT plays with
 * accelerometer bias, applied to the person instead of the sensor.
 */
export class StrideModel {
  private readonly config: StrideModelConfig;
  private stride: number;
  private observations = 0;

  constructor(config: Partial<StrideModelConfig> = {}) {
    this.config = { ...DEFAULT_STRIDE_CONFIG, ...config };
    this.stride = this.config.defaultStrideM;
  }

  get strideM(): number {
    return this.stride;
  }

  get observationCount(): number {
    return this.observations;
  }

  /** True once GNSS has actually taught us something about this carrier. */
  get isCalibrated(): boolean {
    return this.observations > 0;
  }

  /** Learn from a moment when both the speed and the cadence are known. */
  observe(gnssSpeedMps: number, cadenceHz: number): void {
    if (!Number.isFinite(gnssSpeedMps) || !Number.isFinite(cadenceHz)) return;
    if (cadenceHz < this.config.minLearningCadenceHz) return;
    const observed = gnssSpeedMps / cadenceHz;
    if (observed < this.config.minStrideM || observed > this.config.maxStrideM) return;
    // First observation replaces the default outright — the default is a
    // population average and the first measurement is about this person.
    const rate = this.observations === 0 ? 1 : this.config.learningRate;
    this.stride = this.stride + rate * (observed - this.stride);
    this.observations++;
  }

  /** Speed from cadence, m/s. Zero when not walking. */
  speedMps(cadenceHz: number): number {
    if (!Number.isFinite(cadenceHz) || cadenceHz <= 0) return 0;
    return this.stride * cadenceHz;
  }

  reset(): void {
    this.stride = this.config.defaultStrideM;
    this.observations = 0;
  }
}
