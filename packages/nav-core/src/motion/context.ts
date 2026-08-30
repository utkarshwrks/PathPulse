/**
 * What kind of motion the carrier is actually in.
 *
 * ★ WHY THIS EXISTS ★
 *
 * Almost everything else in this engine was written for a phone bolted into a
 * car. Three of those assumptions are false the moment somebody picks the
 * handset up and walks:
 *
 *   1. The speed model is an IO-VNBD network. IO-VNBD is a *vehicle* dataset.
 *      Handheld walking swings the accelerometer by several m/s^2 twice a
 *      second, which to a car model looks like sustained hard acceleration —
 *      it saturated the plausibility ceiling and stayed there, so the HUD read
 *      a flat 11 km/h whether the phone was moving or lying on a table.
 *   2. The non-holonomic constraint says a vehicle cannot slide sideways, so
 *      the direction of travel is the direction the device points. A phone in
 *      a hand points wherever the hand does; over a five-second GNSS interval
 *      the integrated yaw wandered through most of the compass, which is what
 *      drew the star-shaped trail out of a walk down a straight footpath.
 *   3. Stationarity is judged from accelerometer variance and gyro magnitude.
 *      A person standing still holding a phone breaches both thresholds
 *      continuously, so ZUPT — the one thing that can stop an unaided estimate
 *      running away — could never fire on foot.
 *
 * A model that knows the edge of its own training set and says so is worth
 * more than one that answers confidently everywhere. This classifier is what
 * lets the engine say so.
 *
 * It is deliberately cheap: variance and a speed, no spectral analysis. The
 * signal separating a person from a car is not subtle.
 */

export type MotionContext = 'STATIONARY' | 'PEDESTRIAN' | 'VEHICLE' | 'UNKNOWN';

export interface MotionContextConfig {
  /**
   * Median accelerometer-magnitude variance above which the carrier is on
   * foot, (m/s^2)^2.
   *
   * ★ MEASURED, AND WEAKER EVIDENCE THAN IT LOOKS ★ Against the same
   * magnitude series the stationarity detector already computes:
   *
   *   parked / on a desk       p50 ~0.006
   *   car, ordinary road       p50  0.035   p90 0.13
   *   phone in hand, walking   p50  0.6 - 6
   *
   * The medians separate cleanly. The tails do not: over broken surface the
   * highway log spikes past 279, two orders of magnitude above a walk. So
   * this is applied to a *median over a window*, never to a single sample,
   * and it is only ever consulted as a tie-break — see classify().
   */
  pedestrianVarianceThreshold: number;
  /** Samples the variance median is taken over. 120 at 60 Hz is two seconds. */
  varianceWindow: number;
  /** A speed no pedestrian reaches, m/s. 8 m/s is 28.8 km/h. */
  vehicleSpeedMps: number;
  /**
   * The fastest a person travels on their own legs, m/s. 4 m/s is 14.4 km/h —
   * a run, not a walk, and comfortably above anything sustained.
   *
   * ★ VIBRATION IS NOT EVIDENCE OF LEGS ★ A scooter or a bicycle over broken
   * surface shakes a handset as hard as walking does, and the field device
   * duly showed ON FOOT at 11 and 25 km/h. Variance says "something is
   * shaking"; it never said "somebody is walking".
   */
  pedestrianMaxSpeedMps: number;
  /** A speed that is not travel at all, m/s. */
  stationarySpeedMps: number;
  /** How long a GNSS speed stays admissible as evidence, ms. */
  gnssEvidenceMs: number;
  /**
   * Consecutive samples a new verdict must hold before it is adopted.
   *
   * Without hysteresis the verdict flaps every time a footstep lands inside
   * the threshold, and each flip switches the speed model and the heading
   * source — which would be visible on the map as a stutter.
   */
  holdSamples: number;
}

export const DEFAULT_MOTION_CONTEXT_CONFIG: MotionContextConfig = {
  pedestrianVarianceThreshold: 0.35,
  varianceWindow: 120,
  vehicleSpeedMps: 8,
  pedestrianMaxSpeedMps: 4,
  stationarySpeedMps: 0.6,
  gnssEvidenceMs: 12_000,
  holdSamples: 30,
};

export interface MotionContextInput {
  t: number;
  /** Variance of accelerometer magnitude, from the stationarity detector. */
  accelVariance: number;
  /** The stationarity detector's own verdict. */
  isStationary: boolean;
  /**
   * Steps per second from the step detector, 0 when no plausible step rhythm
   * is present.
   *
   * ★ THE CORROBORATION THAT VARIANCE CANNOT GIVE ★ Walking is not merely
   * loud, it is *periodic* at one to three hertz, and nothing else a carrier
   * does looks like that. Requiring a real cadence before declaring PEDESTRIAN
   * is what separates a person from a bicycle on a bad road — the two have
   * indistinguishable variance and completely different footfall.
   */
  cadenceHz?: number;
  /** Most recent trusted GNSS speed, m/s, or undefined if there is none. */
  gnssSpeedMps?: number;
  /** When that speed was measured, ms. */
  gnssSpeedT?: number;
}

export interface MotionContextResult {
  context: MotionContext;
  /** What decided it, for the debug panel. Never a mystery on screen. */
  reason: string;
  /** True while the classifier is still filling its hold window. */
  settling: boolean;
}

/**
 * Classifies motion into the three regimes the engine treats differently.
 *
 * Evidence is ranked, strongest first, because the sources are not equally
 * good. A GNSS speed is measured; a variance threshold is inferred.
 */
export class MotionContextDetector {
  private readonly config: MotionContextConfig;
  private accepted: MotionContext = 'UNKNOWN';
  private candidate: MotionContext = 'UNKNOWN';
  private candidateCount = 0;
  private lastReason = 'no samples yet';
  private readonly variances: number[] = [];
  /** The last verdict a GNSS speed actually backed, or null if there has been none. */
  private gnssBacked: MotionContext | null = null;

  constructor(config: Partial<MotionContextConfig> = {}) {
    this.config = { ...DEFAULT_MOTION_CONTEXT_CONFIG, ...config };
  }

  get current(): MotionContext {
    return this.accepted;
  }

  get reason(): string {
    return this.lastReason;
  }

  push(input: MotionContextInput): MotionContextResult {
    if (Number.isFinite(input.accelVariance)) {
      this.variances.push(input.accelVariance);
      if (this.variances.length > this.config.varianceWindow) this.variances.shift();
    }
    const { context: raw, reason } = this.classify(input);

    if (raw === this.candidate) {
      this.candidateCount++;
    } else {
      this.candidate = raw;
      this.candidateCount = 1;
    }

    // ★ ONE EXCEPTION TO THE HOLD ★
    // A GNSS speed above the pedestrian ceiling is not a borderline reading
    // that might settle back — nobody walks at 29 km/h. Adopting VEHICLE
    // immediately means driving away from a standstill re-enables the speed
    // model on the first fix rather than half a second later.
    const decisive = raw === 'VEHICLE' && this.isRecentGnss(input) &&
      (input.gnssSpeedMps ?? 0) >= this.config.vehicleSpeedMps;

    if (decisive || this.candidateCount >= this.config.holdSamples) {
      this.accepted = raw;
    }

    this.lastReason = reason;
    return {
      context: this.accepted,
      reason,
      settling: this.accepted === 'UNKNOWN',
    };
  }

  reset(): void {
    this.accepted = 'UNKNOWN';
    this.candidate = 'UNKNOWN';
    this.candidateCount = 0;
    this.lastReason = 'no samples yet';
    this.variances.length = 0;
    this.gnssBacked = null;
  }

  /**
   * Median of the variance window.
   *
   * A median rather than a mean because the distribution's tail is where the
   * trouble is: one pothole reaching 279 drags a mean over the pedestrian
   * threshold for the whole window, and a median does not notice it at all.
   */
  private medianVariance(): number {
    if (this.variances.length < Math.min(20, this.config.varianceWindow)) return Number.NaN;
    const sorted = [...this.variances].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  private isRecentGnss(input: MotionContextInput): boolean {
    return (
      input.gnssSpeedMps !== undefined &&
      Number.isFinite(input.gnssSpeedMps) &&
      input.gnssSpeedT !== undefined &&
      input.t - input.gnssSpeedT <= this.config.gnssEvidenceMs
    );
  }

  private classify(input: MotionContextInput): { context: MotionContext; reason: string } {
    const v = this.medianVariance();
    const hasV = Number.isFinite(v);
    const onFoot = hasV && v > this.config.pedestrianVarianceThreshold;
    const cadence = input.cadenceHz ?? 0;
    const walking = Number.isFinite(cadence) && cadence > 0;

    if (this.isRecentGnss(input)) {
      const s = input.gnssSpeedMps!;

      // 1. A measured speed no pedestrian reaches. Nothing outranks it.
      if (s >= this.config.vehicleSpeedMps) {
        this.gnssBacked = 'VEHICLE';
        return { context: 'VEHICLE', reason: `gnss ${s.toFixed(1)} m/s` };
      }

      // 2. A measured near-zero speed. Asserted even when the accelerometer is
      //    loud: a person standing still shaking a phone is stationary, and
      //    that is precisely the case the IMU can never call.
      if (s < this.config.stationarySpeedMps) {
        return { context: 'STATIONARY', reason: `gnss ${s.toFixed(2)} m/s` };
      }

      // 3. Between the two, speed alone cannot separate a walk from a car in
      //    traffic. Three things must agree before we call it a walk: the
      //    handset is being shaken (median variance, not a single sample), it
      //    is being shaken *rhythmically* at a human step rate, and the speed
      //    is one a person can produce with their legs. Variance alone put
      //    ON FOOT on the screen at 25 km/h.
      if (onFoot && walking && s <= this.config.pedestrianMaxSpeedMps) {
        this.gnssBacked = 'PEDESTRIAN';
        return {
          context: 'PEDESTRIAN',
          reason: `${cadence.toFixed(1)} steps/s at ${s.toFixed(1)} m/s`,
        };
      }
      this.gnssBacked = 'VEHICLE';
      return {
        context: 'VEHICLE',
        reason: `var ${hasV ? v.toFixed(2) : 'n/a'} at ${s.toFixed(1)} m/s`,
      };
    }

    // ★ NOBODY GETS OUT OF THE CAR IN A TUNNEL ★
    //
    // Losing GNSS is not evidence that the kind of motion changed, and the
    // accelerometer cannot supply that evidence on its own: over broken
    // surface the highway log's variance spikes past 279 (m/s^2)^2, two orders
    // of magnitude above a walk. Re-deriving from variance mid-outage flipped
    // a car doing 30 m/s to PEDESTRIAN for a few hundred samples, which froze
    // the heading through a curve and took the published mean drift from 10.0%
    // to 34.8% — the whole headline number, lost to a classifier answering a
    // question it had no evidence for.
    //
    // So once GNSS has told us what this is, hold that until GNSS speaks
    // again. Variance only gets to decide before the first fix has ever
    // arrived, when holding nothing is the alternative.
    if (this.gnssBacked !== null) {
      return { context: this.gnssBacked, reason: 'held — no gnss speed to re-check' };
    }

    if (onFoot && walking) {
      return { context: 'PEDESTRIAN', reason: `${cadence.toFixed(1)} steps/s, no gnss speed` };
    }
    if (input.isStationary) return { context: 'STATIONARY', reason: 'imu still, no gnss speed' };
    if (!hasV) return { context: 'UNKNOWN', reason: 'variance window not full' };
    return { context: 'VEHICLE', reason: `var ${v.toFixed(2)}, no gnss speed` };
  }
}
