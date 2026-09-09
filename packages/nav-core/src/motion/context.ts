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
  /**
   * How long cadence-backed walking evidence must hold CONTINUOUSLY before a
   * vehicle is allowed to become a pedestrian, ms.
   *
   * ★ THE LATCH THAT FROZE AN ENTIRE OUTAGE ★
   *
   * Field video, a rigidly-mounted phone on a vehicle in city traffic. While
   * GNSS was still healthy the badge read `ON FOOT` at 5 km/h. Then the fixes
   * stopped, and for the next forty seconds the HUD read:
   *
   *     DEAD RECKONING  [ON FOOT]   0 km/h  [STEPS]
   *     distance 704 m -> 707 m -> 708 m
   *
   * The estimate advanced 23 m while the vehicle covered 174 m. Recovery error
   * went from 4.58 % to 20.74 %.
   *
   * Every one of the three PEDESTRIAN conditions was satisfied, and none of
   * them was wrong on its own. A scooter over broken surface shakes the
   * handset past `pedestrianVarianceThreshold`. Potholes, speed bumps and
   * engine harmonics land inside `StepDetector`'s 0.6-3.5 Hz band, so a
   * cadence is reported. And crawling in traffic at 1.4 m/s is inside
   * `pedestrianMaxSpeedMps`. Three plausible signals, one absurd conclusion.
   *
   * ★ WHAT SEPARATES THEM IS NOT THE INSTANT, IT IS THE DURATION ★
   *
   * A vehicle satisfies all three for a few seconds, at a red light on a bad
   * road. A person walking satisfies them continuously, because walking is
   * what they are doing. So leaving VEHICLE now costs five seconds of
   * uninterrupted evidence — about nine steps at a normal cadence, which is
   * what the brief asked for and what the signal can actually support.
   *
   * Deliberately one-directional. Entering PEDESTRIAN from UNKNOWN or
   * STATIONARY is unchanged: somebody opening the app and walking should be
   * recognised at once, and there is no vehicle verdict to protect.
   */
  vehicleToPedestrianConfirmMs: number;
  /**
   * How long after a measured vehicle speed the carrier still counts as one, ms.
   *
   * ★ DURATION WAS NOT ENOUGH, BECAUSE THE VIBRATION NEVER STOPS ★
   *
   * The first attempt at this asked for five seconds of uninterrupted
   * cadence-backed evidence before a vehicle could become a pedestrian. It did
   * not work, and the reason is the whole problem: a mounted handset on a bad
   * road produces that signal CONTINUOUSLY. Twenty seconds of crawling in
   * traffic satisfies a five-second timer, and a sixty-second one, and any
   * timer at all — there is no duration that a jammed-up scooter cannot
   * outlast.
   *
   * Variance and cadence cannot separate these two cases. They are, from the
   * IMU alone, the same signal.
   *
   * ★ WHAT CAN SEPARATE THEM IS A MEASUREMENT ★
   *
   * A person walking at 1.4 m/s was not doing 12 m/s a moment ago. A vehicle
   * crawling at 1.4 m/s was. So the discriminator is not how the handset is
   * shaking, it is whether the receiver has recently measured a speed no
   * pedestrian reaches — which is exactly the evidence `vehicleSpeedMps`
   * already treats as decisive, remembered instead of discarded.
   *
   * Sixty seconds. A rider who genuinely parks and walks away is called a
   * pedestrian a minute later, which costs a minute of a vehicle-tuned
   * heading rule on somebody strolling. A vehicle in traffic is never called a
   * pedestrian at all, which is the failure that froze an outage.
   */
  vehicleMemoryMs: number;
}

export const DEFAULT_MOTION_CONTEXT_CONFIG: MotionContextConfig = {
  pedestrianVarianceThreshold: 0.35,
  varianceWindow: 120,
  vehicleSpeedMps: 8,
  pedestrianMaxSpeedMps: 4,
  stationarySpeedMps: 0.6,
  gnssEvidenceMs: 12_000,
  holdSamples: 30,
  vehicleToPedestrianConfirmMs: 5000,
  vehicleMemoryMs: 60_000,
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
  /**
   * When the current run of cadence-backed walking evidence began, or null.
   * See `vehicleToPedestrianConfirmMs`.
   */
  private walkingSinceMs: number | null = null;
  /** When GNSS last measured a speed no pedestrian reaches. See `vehicleMemoryMs`. */
  private lastVehicleSpeedT: number | null = null;
  /**
   * The context in force when GNSS was last lost, held for the outage.
   *
   * ★ NOBODY GETS OUT OF THE CAR IN A TUNNEL, AND THE HOLD HAS TO BE EXPLICIT ★
   *
   * `gnssBacked` was already doing this implicitly, and implicitly was not good
   * enough: it is written whenever GNSS backs a verdict, so one wrong reading
   * in slow traffic — see `vehicleToPedestrianConfirmMs` — became the held
   * value for an entire outage with nothing on screen to say so.
   *
   * A latch that is named, timestamped and rendered can be seen to be wrong.
   * One that lives inside a private field cannot.
   */
  private latchedContext: MotionContext | null = null;
  private latchedAtMs: number | null = null;
  private gnssHealthy = true;

  constructor(config: Partial<MotionContextConfig> = {}) {
    this.config = { ...DEFAULT_MOTION_CONTEXT_CONFIG, ...config };
  }

  get current(): MotionContext {
    return this.accepted;
  }

  get reason(): string {
    return this.lastReason;
  }

  /** True while an outage is holding the context it entered with. */
  get latched(): boolean {
    return this.latchedContext !== null;
  }

  get latchedAt(): number | null {
    return this.latchedAtMs;
  }

  /**
   * True when GNSS established VEHICLE and nothing has since PROVEN otherwise.
   *
   * ★ THE GUARD ON THE STEP MODEL ★ A rigidly mounted handset has no step
   * cadence to measure, so the pedestrian speed path resolves to zero and the
   * estimate stops advancing — which is the field failure exactly. The step
   * model must not be offered to a carrier the receiver last saw driving.
   */
  get vehicleEstablished(): boolean {
    return this.latchedContext === 'VEHICLE' || (!this.latched && this.gnssBacked === 'VEHICLE');
  }

  /**
   * Tell the classifier whether the receiver is currently fixing.
   *
   * Called by the engine on every sample. The transition is what matters: on
   * the edge into an outage the context is latched, and on the edge out of one
   * it is released and GNSS resumes deciding.
   */
  setGnssHealthy(healthy: boolean, tMs: number): void {
    if (healthy === this.gnssHealthy) return;
    this.gnssHealthy = healthy;
    if (!healthy) {
      this.latchedContext = this.accepted === 'UNKNOWN' ? null : this.accepted;
      this.latchedAtMs = this.latchedContext === null ? null : tMs;
    } else {
      this.latchedContext = null;
      this.latchedAtMs = null;
    }
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
    this.walkingSinceMs = null;
    this.lastVehicleSpeedT = null;
    this.latchedContext = null;
    this.latchedAtMs = null;
    this.gnssHealthy = true;
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

    // How long cadence-backed walking evidence has held without a break. See
    // `vehicleToPedestrianConfirmMs`: a vehicle produces this for a few
    // seconds on a bad road, a person produces it continuously.
    if (onFoot && walking) {
      if (this.walkingSinceMs === null) this.walkingSinceMs = input.t;
    } else {
      this.walkingSinceMs = null;
    }
    const walkingHeldMs =
      this.walkingSinceMs === null ? 0 : Math.max(0, input.t - this.walkingSinceMs);
    // Leaving an established VEHICLE costs sustained evidence. Arriving at
    // PEDESTRIAN from anything else does not — there is no verdict to protect.
    const vehicleMemoryMs =
      this.lastVehicleSpeedT === null
        ? Number.POSITIVE_INFINITY
        : input.t - this.lastVehicleSpeedT;
    const mayLeaveVehicle =
      this.gnssBacked !== 'VEHICLE' ||
      (walkingHeldMs >= this.config.vehicleToPedestrianConfirmMs &&
        vehicleMemoryMs >= this.config.vehicleMemoryMs);

    if (this.isRecentGnss(input)) {
      const s = input.gnssSpeedMps!;

      // 1. A measured speed no pedestrian reaches. Nothing outranks it.
      if (s >= this.config.vehicleSpeedMps) {
        this.gnssBacked = 'VEHICLE';
        this.lastVehicleSpeedT = input.t;
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
        if (!mayLeaveVehicle) {
          // ★ A VEHICLE CRAWLING ON A BAD ROAD LOOKS EXACTLY LIKE THIS ★
          // Held rather than flipped, and the reason says how much longer the
          // evidence has to last — which is the line a rider reads on the
          // Device screen when the badge does not say what they expect.
          const leftMs = Math.max(
            this.config.vehicleToPedestrianConfirmMs - walkingHeldMs,
            this.config.vehicleMemoryMs - vehicleMemoryMs,
          );
          return {
            context: 'VEHICLE',
            reason: `looks like walking, but gnss measured a vehicle ${(vehicleMemoryMs / 1000).toFixed(0)}s ago — ${(leftMs / 1000).toFixed(0)}s more`,
          };
        }
        this.gnssBacked = 'PEDESTRIAN';
        return {
          context: 'PEDESTRIAN',
          reason: `${cadence.toFixed(1)} steps/s at ${s.toFixed(1)} m/s for ${(walkingHeldMs / 1000).toFixed(1)}s`,
        };
      }
      // ★ STOPPING IS NOT GETTING INTO A CAR ★
      //
      // Falling through to VEHICLE here is right when the evidence is a speed
      // and a shake that do not look like walking. It is badly wrong for the
      // one case that produced it most often: a walker who STOPS.
      //
      // Cadence goes to zero 1.6 s after the last footfall, while the last
      // Doppler speed is still a walking 1.4 m/s and stays "recent" for
      // several seconds more. So `walking` is false, `s` is mid-band, and this
      // branch declared VEHICLE — and, worse, wrote it into `gnssBacked`,
      // which the hold below then preserves for the WHOLE outage. Measured on
      // the walk-then-stop fixture in pedestrian.test.ts: the context flipped
      // to VEHICLE within five seconds of stopping and never came back, which
      // re-enabled the vehicle speed model, disabled the pedestrian heading
      // rule, and left the chain integrating hand tremor. 74.9 m of travel
      // invented while standing still.
      //
      // Inside the pedestrian speed band, the absence of a cadence is not
      // evidence of a vehicle — it is the absence of evidence. Hold whatever
      // GNSS last established rather than inventing a new answer from a
      // missing signal. Above the band the original reasoning is untouched: a
      // speed no pedestrian reaches is decisive however quiet the handset.
      if (s <= this.config.pedestrianMaxSpeedMps && this.gnssBacked !== null) {
        return {
          context: this.gnssBacked,
          reason: `held ${this.gnssBacked.toLowerCase()} — no cadence at ${s.toFixed(1)} m/s`,
        };
      }

      // ★ AND THE SAME REASONING, WHEN THERE IS NOTHING TO HOLD ★
      //
      // The branch above declines to invent a verdict from a missing cadence —
      // but only once GNSS has already established one. With `gnssBacked` still
      // null it fell through to here, and here asserts VEHICLE.
      //
      // At the START of a session that is the common case, not the rare one.
      // Open the app and start walking: the variance window needs twenty
      // samples before it will answer, the step detector needs a rhythm before
      // it reports a cadence, and the first fix arrives before either. So
      // `hasV` is false, `walking` is false, the speed is a walking 1.4 m/s —
      // and the reason string this produced was, literally, `var n/a at
      // 1.4 m/s`. No variance, no cadence, and a speed no vehicle sustains,
      // and from that it concluded VEHICLE and WROTE IT DOWN. Once written,
      // the hold above preserves it and the outage branch preserves it again:
      // one wrong verdict in the first second, kept for the session, enabling
      // a vehicle-trained speed model on a pedestrian for the rest of it.
      //
      // Narrowly: only while the variance window has NOT filled. Once it has,
      // the existing rule stands and is deliberate — a loud handset with no
      // footfall is the scooter on a bad road, and calling that a pedestrian
      // froze the heading of a vehicle doing 25 km/h. Variance never says
      // "somebody is walking"; what it says here is "something is moving and
      // it is not stepping", and inside the band that is a vehicle.
      //
      // What it cannot say is anything at all before it has twenty samples,
      // and that is the only case being changed. UNKNOWN is a SAFE answer: it
      // enables neither the vehicle speed model nor the pedestrian heading
      // rule, and it costs nothing here because this branch only runs when a
      // recent GNSS speed exists — which is what the estimator is using
      // anyway. It resolves within a second or two, on evidence.
      //
      // Above the band nothing changes: a speed no pedestrian reaches is
      // decisive however quiet the handset, and that is the branch at the top.
      if (!hasV && s <= this.config.pedestrianMaxSpeedMps) {
        return {
          context: 'UNKNOWN',
          reason: `no cadence and no variance yet at ${s.toFixed(1)} m/s — not enough to call it`,
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
    // ★ THE LATCH, AND THE ONE THING THAT MAY RELEASE IT ★
    //
    // Absence of evidence releases nothing. A mounted handset has no cadence
    // to measure, and reading that silence as "not a vehicle any more" is what
    // put [STEPS] and 0 km/h on the screen for forty seconds while the vehicle
    // covered 174 m.
    //
    // A stop is different: `isStationary` is a raw-sensor decision the IMU can
    // make on its own, it is already trusted everywhere else in this engine to
    // arm ZUPT, and a vehicle that has stopped really is stationary. That one
    // transition is allowed. Every other release waits for GNSS.
    if (this.latchedContext !== null) {
      if (input.isStationary) {
        return { context: 'STATIONARY', reason: 'imu still — the one release the latch allows' };
      }
      // ★ AND THE SAME DOOR HAS TO OPEN OUTWARDS ★
      //
      // Measured on the first Tier F ride, and it is a bug this latch
      // introduced. A window that began at a red light latched STATIONARY,
      // and then held it for sixty seconds while the vehicle drove 216 m —
      // the estimate advanced 15. A stopped vehicle that pulls away had no way
      // out, because the only release named was the one that got it in.
      //
      // `isStationary` going FALSE is the same class of evidence as it going
      // true: a raw-sensor decision the IMU makes on its own, already trusted
      // to arm and disarm ZUPT. Refusing to act on it in one direction while
      // acting on it in the other is not caution, it is an asymmetry with no
      // argument behind it.
      //
      // It returns to whatever GNSS last established rather than guessing:
      // this vehicle was a VEHICLE before it stopped, and stopping is not
      // evidence that it became something else.
      if (this.latchedContext === 'STATIONARY' && !input.isStationary) {
        const resumed = this.gnssBacked ?? 'VEHICLE';
        this.latchedContext = resumed;
        return { context: resumed, reason: 'imu moving again — stationary latch released' };
      }
      // ★ AND NO AMOUNT OF CADENCE RELEASES A VEHICLE MID-OUTAGE ★
      //
      // The brief asked for release on sustained detected cadence. It cannot
      // work, and the reason is the same one that killed the timer above: a
      // mounted handset on a bad road produces sustained cadence indefinitely.
      // Without GNSS there is no signal that tells a crawling vehicle from a
      // walker, so there is no honest basis for the transition, and asserting
      // one costs a frozen estimate. The latch waits for the receiver.
      return {
        context: this.latchedContext,
        reason: `latched ${this.latchedContext.toLowerCase()} at outage entry`,
      };
    }

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
