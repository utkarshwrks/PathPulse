export interface ForwardBiasConfig {
  /** EMA weight per accepted observation. Low, because GNSS speed is noisy. */
  alpha: number;
  /**
   * Below this speed the speed reference is too noisy to differentiate, m/s.
   *
   * 3 m/s excluded walking entirely, so on foot the estimator never received a
   * single observation and the acceleration runaway went uncorrected. The
   * caller now only supplies a derived speed when the displacement clearly
   * exceeds the fix accuracy, so quality is guarded there and this can sit at
   * a brisk walk instead.
   */
  minSpeedMps: number;
  /** Reject observations with an implausible implied acceleration, m/s^2. */
  maxObservedAccelMps2: number;
  /**
   * Largest correction we are willing to apply, m/s^2.
   *
   * 0.35 is sin(2 deg) x 9.81: two degrees of mount tilt. That is a real
   * physical bound on how far a phone in a cradle can be off, not a fitted
   * constant, and it keeps a runaway estimate from injecting acceleration the
   * vehicle never had.
   */
  maxBiasMps2: number;
  /**
   * Discard a single observation whose implied error exceeds this, m/s^2.
   * Deliberately independent of maxBiasMps2 — see the note in pushGnssSpeed.
   */
  maxObservationErrorMps2: number;
  /** Ignore GNSS speed pairs further apart than this, ms. */
  maxIntervalMs: number;
}

export const DEFAULT_FORWARD_BIAS_CONFIG: ForwardBiasConfig = {
  alpha: 0.02,
  minSpeedMps: 1.5,
  maxObservedAccelMps2: 4,
  maxBiasMps2: 0.35,
  maxObservationErrorMps2: 2,
  maxIntervalMs: 3000,
};

/**
 * Learns the residual error in forward acceleration while GNSS is available,
 * so it can be cancelled during the outage that follows.
 *
 * ★ WHY THIS IS THE HIGHEST-VALUE REMAINING CORRECTION ★
 *
 * After the attitude and constraint fixes, the dominant remaining error was
 * along-track: over a 60 s simulated outage the estimate reported 7.5 m/s
 * while the vehicle was actually doing 13.8 m/s, and that speed deficit
 * integrated into most of the final position error.
 *
 * The cause is the project's own headline number. A one-degree error in the
 * estimated vertical injects sin(1 deg) x 9.81 = 0.171 m/s^2 of false
 * acceleration. Two degrees of mount tilt is a steady 0.34 m/s^2 of phantom
 * braking, which is exactly the shortfall observed. Accelerometer bias adds to
 * the same term and is indistinguishable from it.
 *
 * The important insight is that this error is OBSERVABLE while GNSS is up.
 * GNSS Doppler speed is independent of the accelerometer, so differentiating it
 * gives a truth signal for longitudinal acceleration. The mean disagreement
 * between that and what we computed is the combined tilt-plus-bias error — and
 * because a mounted phone does not change orientation, it is very nearly
 * constant across the outage that follows.
 *
 * So: measure it continuously in the open, apply it in the tunnel. No extra
 * sensor, no model, no training data.
 *
 * Deliberately not merged into the ZUPT accelerometer bias: that one is
 * estimated at a standstill in the device frame and captures sensor offset,
 * while this one is estimated in motion along the vehicle's forward axis and
 * captures mount tilt and alignment error too. They correct different things
 * and disagreeing with each other is informative.
 */
export class ForwardBiasEstimator {
  private readonly config: ForwardBiasConfig;
  private bias = 0;
  private initialised = false;
  private observations = 0;

  private lastGnssSpeedMps: number | null = null;
  private lastGnssT: number | null = null;
  /** Forward acceleration accumulated since the previous GNSS speed reading. */
  private accelSum = 0;
  private accelCount = 0;

  constructor(config: Partial<ForwardBiasConfig> = {}) {
    this.config = { ...DEFAULT_FORWARD_BIAS_CONFIG, ...config };
  }

  /** Correction to ADD to measured forward acceleration, m/s^2. */
  get correctionMps2(): number {
    return this.initialised ? -this.bias : 0;
  }

  get estimateMps2(): number {
    return this.bias;
  }

  get hasEstimate(): boolean {
    return this.initialised;
  }

  get observationCount(): number {
    return this.observations;
  }

  /** Feed every sample's forward acceleration, corrected or not. */
  pushAccel(forwardAccelMps2: number): void {
    if (!Number.isFinite(forwardAccelMps2)) return;
    this.accelSum += forwardAccelMps2;
    this.accelCount++;
  }

  /**
   * Feed a trusted GNSS speed. Returns true when an observation was accepted.
   *
   * Call this only while the fix is good — a multipath speed would be learned
   * as bias and then applied for the whole of the next outage.
   */
  pushGnssSpeed(tMs: number, speedMps: number): boolean {
    if (!Number.isFinite(speedMps) || !Number.isFinite(tMs)) return false;

    const prevSpeed = this.lastGnssSpeedMps;
    const prevT = this.lastGnssT;
    const count = this.accelCount;
    const mean = count > 0 ? this.accelSum / count : 0;

    this.lastGnssSpeedMps = speedMps;
    this.lastGnssT = tMs;
    this.accelSum = 0;
    this.accelCount = 0;

    if (prevSpeed === null || prevT === null || count === 0) return false;

    const dtMs = tMs - prevT;
    if (dtMs <= 0 || dtMs > this.config.maxIntervalMs) return false;

    // Both endpoints must be fast enough for Doppler to mean anything. Near
    // standstill the reported speed is mostly noise, and differentiating noise
    // would inject a large fictitious acceleration into the estimate.
    if (prevSpeed < this.config.minSpeedMps || speedMps < this.config.minSpeedMps) return false;

    const observedAccel = (speedMps - prevSpeed) / (dtMs / 1000);
    if (Math.abs(observedAccel) > this.config.maxObservedAccelMps2) return false;

    // Positive error means we over-reported acceleration relative to truth.
    const error = mean - observedAccel;
    if (!Number.isFinite(error)) return false;

    // Reject only a wild single observation; clamp the running estimate.
    //
    // The first version rejected any estimate exceeding the cap outright. That
    // deadlocked the whole mechanism: the first observation is adopted whole,
    // so a large initial error meant rejection, which left `initialised` false,
    // which meant the next observation was also adopted whole and also
    // rejected. It never learned anything — measured as obs=0 for an entire
    // drive — and the failure was silent, because a bias of zero looks exactly
    // like a well-calibrated sensor.
    //
    // The outlier gate is also kept INDEPENDENT of maxBiasMps2. Deriving it
    // from the cap coupled the two: lowering the cap to tighten the correction
    // also tightened the gate below the typical observation, which silently
    // switched the estimator off again rather than merely limiting it.
    if (Math.abs(error) > this.config.maxObservationErrorMps2) return false;

    const blended = this.initialised
      ? this.bias * (1 - this.config.alpha) + error * this.config.alpha
      : error;
    this.bias = Math.max(-this.config.maxBiasMps2, Math.min(this.config.maxBiasMps2, blended));
    this.initialised = true;
    this.observations++;
    return true;
  }

  reset(): void {
    this.bias = 0;
    this.initialised = false;
    this.observations = 0;
    this.lastGnssSpeedMps = null;
    this.lastGnssT = null;
    this.accelSum = 0;
    this.accelCount = 0;
  }
}
