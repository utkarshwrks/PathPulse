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
  /**
   * Learn what "stopped" sounds like on THIS vehicle, from GNSS-labelled
   * samples, and spend it when GNSS is gone.
   *
   * ★ THE THRESHOLDS BELOW WERE MEASURED ON A CAR, AND A SCOOTER IS NOT ONE ★
   *
   * Field report: "if i stop during dead reckoning then also it appear to be
   * moving". The chain is only ever arrested by ZUPT, ZUPT is only ever armed
   * by this detector, and this detector's gate is a car's engine-off variance
   * distribution. A running two-wheeler idling at a light shakes the handset
   * well past 0.015 — so `isStationary` never went true, ZUPT never fired, and
   * the speed model went on asserting a speed at a machine that was standing
   * still. The estimate then drove off down the map on its own, which is
   * exactly the failure ZUPT was written to prevent, reintroduced by a
   * threshold that does not describe this vehicle.
   *
   * ★ THE SAME TRICK THE REST OF THIS PROJECT ALREADY PLAYS ★
   *
   * `StrideModel` learns metres-per-step from GNSS while it is free.
   * `MagneticHeading` learns the grip offset the same way. Both are an unknown
   * constant of the CARRIER, unobservable from the IMU alone, measured against
   * GNSS while it costs nothing and spent during the outage. The idle
   * signature of the vehicle you happen to be on is exactly that shape.
   *
   * ★ AND UNLIKE THE SPEED CALIBRATOR, IT CANNOT BE CONFIDENTLY WRONG ★
   *
   * `MlSpeedCalibrator` is a kept negative result because a fitted multiplier
   * feeds straight into an integrated quantity: get it wrong and the error
   * accumulates for the whole outage. This fits nothing and multiplies
   * nothing. It moves a CLASSIFICATION boundary, and it is only allowed to
   * move it into a gap that the data has demonstrated is there — see
   * `learnSeparationFactor`. Where the two distributions overlap on this
   * vehicle, it declines and the configured value stands.
   */
  adaptive: boolean;
  /** Labelled samples kept per class. At 50 Hz this is six seconds of each. */
  learnWindow: number;
  /** Samples of BOTH classes required before the learned gate is used. */
  learnMinObservations: number;
  /** Headroom above the stopped quantile, so an unseen idle still lands inside. */
  learnMargin: number;
  /**
   * Which quantile of the STOPPED distribution the gate is built from.
   *
   * ★ p90 WAS THE WRONG END, AND IT MADE THE MECHANISM DECLINE FOREVER ★
   *
   * Measured on the first Tier F ride, over 256-sample windows labelled by the
   * nearest fix — a two-wheeler in Jabalpur, engine running at every stop:
   *
   *   stopped   p50 0.302   p75 1.378   p90 4.343
   *   moving    p05 1.002   p10 1.076   p25 1.831
   *
   * Read the two middle columns together. The stopped p90 is 4.34 and the
   * moving p05 is 1.00, so a gate built on p90 is ABOVE most of the moving
   * distribution — `learnSeparationFactor` correctly refused it, every time,
   * and the adaptive gate never engaged on the one vehicle it was written for.
   *
   * The stopped p50 is 0.302 against a moving p05 of 1.002. That is a clean
   * gap, and a gate at 0.45 sits inside it. The cost of the lower quantile is
   * that only about half of stopped windows clear it, so ZUPT arms at some
   * stops rather than at all of them — which is the correct trade, because a
   * missed stop forfeits a calibration and a false one zeroes a real velocity.
   */
  learnStoppedQuantile: number;
  /** And which quantile of the MOVING distribution bounds it. See above. */
  learnMovingQuantile: number;
  /**
   * The learned gate must sit this far below the moving p10.
   *
   * ★ THIS IS THE WHOLE SAFETY ARGUMENT ★ A false stop is far more expensive
   * than a missed one: it zeroes a real velocity mid-drive and teaches the
   * bias estimators from a moving vehicle. So the gate is never raised on the
   * strength of the stopped samples alone — it is raised into a gap that the
   * MOVING samples have independently confirmed is empty. If this vehicle's
   * idle is as loud as its cruise, there is no gap, and the answer is to
   * decline rather than to guess.
   */
  learnSeparationFactor: number;
  /** Hard ceiling on the learned gate, as a multiple of the configured one. */
  learnMaxRatio: number;
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
  adaptive: true,
  learnWindow: 300,
  learnMinObservations: 100,
  learnMargin: 1.5,
  learnStoppedQuantile: 0.5,
  learnMovingQuantile: 0.05,
  learnSeparationFactor: 0.7,
  // ★ THE REAL BOUND IS THE MOVING DISTRIBUTION, NOT A MULTIPLE OF A CONSTANT ★
  //
  // This was 8, which caps the gate at 0.12 — and the vehicle that needs it
  // sits at 0.302 when stopped, so the cap alone would have blocked the gate
  // even once the quantile was right. A number pulled from nowhere was
  // overruling one measured from the data.
  //
  // It stays, high, as a guard against a degenerate learned distribution
  // rather than as the operative limit. What actually decides is
  // `learnSeparationFactor` against the moving quantile, which is a bound with
  // an argument behind it: the gate may not rise into the range where this
  // vehicle has been observed to move.
  learnMaxRatio: 64,
};

export interface StationarityResult {
  isStationary: boolean;
  /** 0..1 — how far inside the thresholds we are. Drives ZUPT weighting later. */
  confidence: number;
  accelVariance: number;
  gyroMean: number;
}

/** The gate actually in force, and whether it was learned. See `adaptive`. */
export interface StationarityThresholds {
  accelVariance: number;
  gyroMean: number;
  learned: boolean;
  stoppedObservations: number;
  movingObservations: number;
}

/** p-quantile of an unsorted sample, nearest-rank. */
function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i] ?? Number.NaN;
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
  /** GNSS-labelled samples, for the learned gate. See `adaptive`. */
  private readonly stoppedAccelVar: number[] = [];
  private readonly stoppedGyroMean: number[] = [];
  private readonly movingAccelVar: number[] = [];
  private readonly movingGyroMean: number[] = [];

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

  /**
   * One GNSS-labelled sample of what this vehicle sounds like.
   *
   * @param moving whether the receiver reported the vehicle in motion
   *
   * Called by the engine only while GNSS is healthy and only from a fix it
   * trusts — a multipath speed labelling a stop as motion would teach exactly
   * the wrong gap. Fed the SAME statistics `evaluate` gates on, so the learned
   * threshold and the live measurement are the same quantity.
   */
  observeLabelled(moving: boolean, accelVariance: number, gyroMean: number): void {
    if (!this.config.adaptive) return;
    if (!Number.isFinite(accelVariance) || !Number.isFinite(gyroMean)) return;
    const vars = moving ? this.movingAccelVar : this.stoppedAccelVar;
    const gyros = moving ? this.movingGyroMean : this.stoppedGyroMean;
    vars.push(accelVariance);
    gyros.push(gyroMean);
    if (vars.length > this.config.learnWindow) vars.shift();
    if (gyros.length > this.config.learnWindow) gyros.shift();
  }

  /**
   * The gate in force right now.
   *
   * Raised into the gap between this vehicle's stopped and moving
   * distributions when there demonstrably is one, and left at the configured
   * value when there is not. Only ever RAISED: a learned gate tighter than the
   * measured default would be a claim about the sensor rather than about the
   * vehicle, and the default already carries that.
   */
  get thresholds(): StationarityThresholds {
    const base = {
      accelVariance: this.config.accelVarianceThreshold,
      gyroMean: this.config.gyroMeanThreshold,
      learned: false,
      stoppedObservations: this.stoppedAccelVar.length,
      movingObservations: this.movingAccelVar.length,
    };
    if (!this.config.adaptive) return base;
    if (
      this.stoppedAccelVar.length < this.config.learnMinObservations ||
      this.movingAccelVar.length < this.config.learnMinObservations
    ) {
      return base;
    }
    const accel = this.learnedGate(
      this.stoppedAccelVar,
      this.movingAccelVar,
      this.config.accelVarianceThreshold,
    );
    const gyro = this.learnedGate(
      this.stoppedGyroMean,
      this.movingGyroMean,
      this.config.gyroMeanThreshold,
    );
    if (accel === null && gyro === null) return base;
    return {
      accelVariance: accel ?? base.accelVariance,
      gyroMean: gyro ?? base.gyroMean,
      learned: true,
      stoppedObservations: base.stoppedObservations,
      movingObservations: base.movingObservations,
    };
  }

  /** null when the two distributions do not separate. See `learnSeparationFactor`. */
  private learnedGate(
    stopped: readonly number[],
    moving: readonly number[],
    configured: number,
  ): number | null {
    const stoppedHigh =
      quantile(stopped, this.config.learnStoppedQuantile) * this.config.learnMargin;
    const movingLow =
      quantile(moving, this.config.learnMovingQuantile) * this.config.learnSeparationFactor;
    if (!Number.isFinite(stoppedHigh) || !Number.isFinite(movingLow)) return null;
    // No gap on this vehicle: its idle is as loud as its cruise, and moving the
    // gate would buy a missed stop with a false one. Decline.
    if (!(stoppedHigh < movingLow)) return null;
    const gate = Math.min(stoppedHigh, configured * this.config.learnMaxRatio);
    // Raised only. See `thresholds`.
    return gate > configured ? gate : null;
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

    const gate = this.thresholds;
    const accelOk = accelVariance < gate.accelVariance;
    const gyroOk = gyroMean < gate.gyroMean;
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
    const accelMargin = 1 - accelVariance / gate.accelVariance;
    const gyroMargin = 1 - gyroMean / gate.gyroMean;
    const confidence = isStationary
      ? Math.max(0, Math.min(1, Math.min(accelMargin, gyroMargin)))
      : 0;

    return { isStationary, confidence, accelVariance, gyroMean };
  }

  reset(): void {
    this.accelMags.length = 0;
    this.gyroMags.length = 0;
    this.consecutiveInThreshold = 0;
    this.stoppedAccelVar.length = 0;
    this.stoppedGyroMean.length = 0;
    this.movingAccelVar.length = 0;
    this.movingGyroMean.length = 0;
  }
}
