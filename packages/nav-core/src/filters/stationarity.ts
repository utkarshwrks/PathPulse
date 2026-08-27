export interface StationarityConfig {
  /** Samples held in the decision window. 50 samples at 50 Hz = 1 second. */
  windowSize: number;
  /** Variance of accelerometer magnitude below which the vehicle looks still. */
  accelVarianceThreshold: number;
  /** Mean gyroscope magnitude below which the vehicle looks still, rad/s. */
  gyroMeanThreshold: number;
  /**
   * Consecutive in-threshold samples required before declaring a stop.
   * Leaving is immediate — see the asymmetry note below.
   */
  enterHoldSamples: number;
}

export const DEFAULT_STATIONARITY_CONFIG: StationarityConfig = {
  windowSize: 50,
  // ★ MEASURED, NOT GUESSED ★
  // The original 0.05 was a guess, and it sat ABOVE almost the entire
  // moving-vehicle distribution. Measuring the simulator's own accelerometer
  // against its ground-truth speed over a full city route gives:
  //
  //   moving  (>3 m/s):  p05 0.0296   p50 0.0346   p95 0.1224
  //   stopped (<0.1 m/s): p05 0.0052   p50 0.0065   p95 0.0342
  //
  // So 0.05 declared a cruising vehicle "stationary" almost continuously —
  // ZUPT then zeroed a real 13.8 m/s and the marker stopped dead inside the
  // tunnel. 0.015 sits in the gap: below the moving p05, above the stopped p50.
  accelVarianceThreshold: 0.015,
  gyroMeanThreshold: 0.02,
  enterHoldSamples: 25,
};

export interface StationarityResult {
  isStationary: boolean;
  /** 0..1 — how far inside the thresholds we are. Drives ZUPT weighting later. */
  confidence: number;
  accelVariance: number;
  gyroMean: number;
}

/**
 * Detects when the vehicle is genuinely stopped.
 *
 * This is quietly one of the highest-value components in the project. Every
 * red light is a chance to reset the error budget: if we know the vehicle is
 * still, velocity is exactly zero and whatever the gyroscope is reporting is
 * pure bias. Phase 6's ZUPT and ZARU both hang off this signal.
 *
 * It keys on the *variance* of accelerometer magnitude rather than its value,
 * because magnitude alone is ~9.81 whether parked or cruising at constant
 * speed. Variance is what actually distinguishes stillness from motion.
 */
export class StationarityDetector {
  private readonly accelMags: number[] = [];
  private readonly gyroMags: number[] = [];
  private readonly config: StationarityConfig;
  private consecutiveInThreshold = 0;

  constructor(config: Partial<StationarityConfig> = {}) {
    this.config = { ...DEFAULT_STATIONARITY_CONFIG, ...config };
  }

  push(ax: number, ay: number, az: number, gx: number, gy: number, gz: number): StationarityResult {
    const accelMag = Math.hypot(ax, ay, az);
    const gyroMag = Math.hypot(gx, gy, gz);

    if (Number.isFinite(accelMag)) this.accelMags.push(accelMag);
    if (Number.isFinite(gyroMag)) this.gyroMags.push(gyroMag);
    if (this.accelMags.length > this.config.windowSize) this.accelMags.shift();
    if (this.gyroMags.length > this.config.windowSize) this.gyroMags.shift();

    return this.evaluate();
  }

  evaluate(): StationarityResult {
    // Refuse to answer until the window is full. Declaring "stationary" from
    // three samples would fire ZUPT mid-drive and zero a real velocity.
    if (this.accelMags.length < this.config.windowSize) {
      return { isStationary: false, confidence: 0, accelVariance: NaN, gyroMean: NaN };
    }

    const aMean = this.accelMags.reduce((s, v) => s + v, 0) / this.accelMags.length;
    const accelVariance =
      this.accelMags.reduce((s, v) => s + (v - aMean) ** 2, 0) / this.accelMags.length;
    const gyroMean = this.gyroMags.reduce((s, v) => s + v, 0) / this.gyroMags.length;

    const accelOk = accelVariance < this.config.accelVarianceThreshold;
    const gyroOk = gyroMean < this.config.gyroMeanThreshold;
    const inThreshold = accelOk && gyroOk;

    // ★ DELIBERATELY ASYMMETRIC ★
    // Entering "stationary" needs sustained confirmation; leaving it needs one
    // sample. The two errors are not equally costly: a missed ZUPT at a red
    // light forfeits a calibration opportunity, while a false ZUPT mid-drive
    // zeroes a real velocity and teaches the bias estimators from a moving
    // vehicle. The stopped and moving variance distributions overlap at the
    // tails, so without this the overlap alone produces false stops.
    if (inThreshold) {
      this.consecutiveInThreshold++;
    } else {
      this.consecutiveInThreshold = 0;
    }
    const isStationary = this.consecutiveInThreshold >= this.config.enterHoldSamples;

    // Confidence is the worse of the two margins — a signal is only as
    // trustworthy as its weakest axis.
    const accelMargin = 1 - accelVariance / this.config.accelVarianceThreshold;
    const gyroMargin = 1 - gyroMean / this.config.gyroMeanThreshold;
    const confidence = isStationary
      ? Math.max(0, Math.min(1, Math.min(accelMargin, gyroMargin)))
      : 0;

    return { isStationary, confidence, accelVariance, gyroMean };
  }

  reset(): void {
    this.accelMags.length = 0;
    this.gyroMags.length = 0;
    this.consecutiveInThreshold = 0;
  }
}
