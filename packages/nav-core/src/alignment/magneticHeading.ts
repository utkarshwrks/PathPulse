/**
 * Heading from the magnetometer, for the one carrier the gyroscope cannot help.
 *
 * ★ THE HOLE THIS FILLS ★
 *
 * On foot the engine refuses to integrate device yaw, and it is right to: a
 * hand is not a chassis, arm swing peaks near 1 rad/s, the phone turns slowly
 * in the grip, and the uncorrected gyro bias ZARU can never remove on foot
 * integrates without bound. Measured on the field handset, integrating that
 * walked the heading around the compass — 102°, then 86°, then 281°, then 16°,
 * along a straight footpath. So `pedestrianHeadingFromGnss` freezes device yaw
 * and takes the bearing from the GNSS course instead.
 *
 * That is correct while GNSS is up, and it leaves NOTHING for the case the
 * whole project exists for. During an outage there is no course, the heading is
 * frozen at whatever it last was, and the estimate walks in a straight line
 * however many corners the carrier turns. Field report: "dead reckoning only
 * works on straight road — street and gali, this appears to just go straight."
 * Reproduced in pedestrian-corners.test.ts: a four-leg walk through a street
 * grid ends 172 m from the carrier with the heading stuck 90° out.
 *
 * ★ WHY THE MAGNETOMETER, WHICH THIS PROJECT DELIBERATELY IGNORES ★
 *
 * `SensorLoopService` reads it at 10 Hz and says why nothing consumes it: "a
 * vehicle is a steel box, its own body distorts the field by tens of degrees,
 * and the distortion changes with heading." That is a sound argument and it is
 * a VEHICLE argument. A person walking down a lane is not inside a steel box,
 * and is exactly the carrier whose gyro cannot be integrated. The two
 * exclusions are complementary, not overlapping — which is why this is enabled
 * for PEDESTRIAN only, and why a vehicle's heading path is untouched.
 *
 * ★ WHAT IT ACTUALLY MEASURES, AND WHAT IT DOES NOT ★
 *
 * Not the direction of travel. It measures the bearing of the DEVICE, and the
 * device points wherever the hand does. What makes that useful is that the
 * offset between the two is observable: while GNSS is up it reports a course,
 * and the difference between that course and the device's magnetic bearing IS
 * the grip. Learn it there, hold it through the outage, and the magnetometer
 * carries the turns.
 *
 * So the error is bounded by how much the phone rotates in the hand during the
 * outage, and — this is the whole point — it is BOUNDED. A gyro bias of
 * 0.012 rad/s is 41° of heading error per minute and it never comes back. A
 * hand that wanders 30° and returns costs 30° while it is wandering and nothing
 * afterwards. Over the minutes an outage lasts those are not the same failure.
 *
 * Deliberately NOT a filter with memory of the field itself: no hard-iron
 * calibration, no soft-iron ellipsoid fit. Both need the user to wave the phone
 * in a figure of eight, and a calibration nobody performs is a constant this
 * code would be pretending to know.
 */

/** A 3-vector in the device frame. */
interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface MagneticHeadingConfig {
  /**
   * Field magnitude band that counts as the Earth's, microtesla.
   *
   * The Earth's field runs 25-65 µT depending on latitude. Anything outside
   * that is a car door, a transformer, a steel gate or a speaker magnet, and
   * the bearing derived from it is not a bearing. This is the same disturbance
   * test SensorLoopService already documents as the magnetometer's honest use.
   */
  minFieldUt: number;
  maxFieldUt: number;
  /**
   * Time constant for learning the grip offset, ms.
   *
   * Slow. The offset is a property of how somebody is holding a phone, which
   * changes over tens of seconds, while the course it is measured against
   * carries GNSS noise on every fix. Too fast and the offset absorbs the noise
   * and there is nothing left to hold.
   */
  offsetTauMs: number;
  /**
   * Course observations required before the offset may be used.
   *
   * One observation is a coincidence. Until there are enough, this reports
   * nothing and the caller keeps the old frozen-heading behaviour — which is
   * wrong in a knowable way rather than wrong in an unknowable one.
   */
  minObservations: number;
  /**
   * How stale a learned offset may be before it is abandoned, ms.
   *
   * A grip learned four minutes ago describes a hand that has since put the
   * phone in a pocket. Past this the estimator goes quiet rather than assert a
   * heading built on it.
   */
  offsetMaxAgeMs: number;
  /**
   * The fastest a walking person's heading may be steered, rad/s.
   *
   * 2 rad/s is 115°/s — a sharp pivot, and far above rounding a corner. The
   * limit exists so a magnetic glitch (walking past a parked car) slews the
   * estimate instead of snapping it, which is Golden Rule #6 applied to
   * heading rather than to position.
   */
  maxSlewRadPerSec: number;
}

export const DEFAULT_MAGNETIC_HEADING_CONFIG: MagneticHeadingConfig = {
  minFieldUt: 25,
  maxFieldUt: 65,
  offsetTauMs: 8_000,
  minObservations: 5,
  offsetMaxAgeMs: 180_000,
  maxSlewRadPerSec: 2,
};

function normalise360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Signed smallest difference a - b, in (-180, 180]. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export interface MagneticHeadingState {
  /** Bearing of the device's +y axis relative to magnetic north, or null. */
  deviceBearingDeg: number | null;
  /** Learned grip: travel course minus device bearing, degrees, or null. */
  offsetDeg: number | null;
  /** Course observations folded into the offset so far. */
  observations: number;
  /** Why there is no usable heading, when there is none. */
  reason: string;
}

/**
 * Tilt-compensated magnetic bearing, plus the grip offset that turns it into a
 * direction of travel.
 */
export class MagneticHeading {
  private readonly config: MagneticHeadingConfig;
  private bearingDeg: number | null = null;
  private offsetDeg: number | null = null;
  private observations = 0;
  private lastObservationT: number | null = null;
  private reason = 'no magnetometer sample yet';

  constructor(config: Partial<MagneticHeadingConfig> = {}) {
    this.config = { ...DEFAULT_MAGNETIC_HEADING_CONFIG, ...config };
  }

  get state(): MagneticHeadingState {
    return {
      deviceBearingDeg: this.bearingDeg,
      offsetDeg: this.offsetDeg,
      observations: this.observations,
      reason: this.reason,
    };
  }

  /**
   * Feed one sample.
   *
   * `up` is the measured specific force — the accelerometer vector, which at
   * rest points along the local vertical. The caller already has it; taking it
   * rather than re-deriving gravity here keeps this file's idea of "down" and
   * the estimator's identical, the same rule `appendDerivedChannels` follows.
   */
  push(mag: V3, up: V3): void {
    const field = Math.hypot(mag.x, mag.y, mag.z);
    if (!Number.isFinite(field) || field < this.config.minFieldUt || field > this.config.maxFieldUt) {
      this.bearingDeg = null;
      this.reason = Number.isFinite(field)
        ? `field ${field.toFixed(0)} µT is not the Earth's — something magnetic is nearby`
        : 'magnetometer reported a non-finite field';
      return;
    }
    const upNorm = Math.hypot(up.x, up.y, up.z);
    if (!(upNorm > 1e-6)) {
      this.bearingDeg = null;
      this.reason = 'no usable vertical — cannot level the compass';
      return;
    }
    const ux = up.x / upNorm;
    const uy = up.y / upNorm;
    const uz = up.z / upNorm;

    // ★ LEVEL IT FIRST ★ The horizontal component of the field points at
    // magnetic north. Reading a bearing off the raw axes instead assumes the
    // phone is flat, and a phone held up to be looked at is 60° from flat —
    // which is the same mistake the speed model was making with its raw
    // channels, in a different file.
    const mDotU = mag.x * ux + mag.y * uy + mag.z * uz;
    const nx = mag.x - mDotU * ux;
    const ny = mag.y - mDotU * uy;
    const nz = mag.z - mDotU * uz;
    const nNorm = Math.hypot(nx, ny, nz);
    // Straight up a field line — over a magnet, or at the magnetic pole. There
    // is no horizontal component to take a bearing from.
    if (!(nNorm > 1e-6)) {
      this.bearingDeg = null;
      this.reason = 'field is vertical — no horizontal component to bear on';
      return;
    }
    const hnx = nx / nNorm;
    const hny = ny / nNorm;
    const hnz = nz / nNorm;

    // East completes the right-handed level frame: east = north × up.
    const hex = hny * uz - hnz * uy;
    const hey = hnz * ux - hnx * uz;
    const hez = hnx * uy - hny * ux;

    // Bearing of the device's +y axis. Which axis is arbitrary — all that
    // matters is that it is fixed in the device, so the grip offset is
    // meaningful. +y is the phone's long axis, which is the one a person points
    // where they are going.
    const fy = 1 - uy * uy;
    const fx = -uy * ux;
    const fz = -uy * uz;
    const east = fx * hex + fy * hey + fz * hez;
    const north = fx * hnx + fy * hny + fz * hnz;
    if (Math.abs(east) < 1e-9 && Math.abs(north) < 1e-9) {
      // The phone is edge-on: +y is straight up, so it has no bearing at all.
      this.bearingDeg = null;
      this.reason = 'device axis is vertical — no bearing to read';
      return;
    }
    this.bearingDeg = normalise360((Math.atan2(east, north) * 180) / Math.PI);
    this.reason = 'ok';
  }

  /**
   * Fold in a measured course over ground — the only thing that can say which
   * way the carrier is actually travelling.
   */
  observeCourse(tMs: number, courseDeg: number): void {
    if (this.bearingDeg === null || !Number.isFinite(courseDeg)) return;
    const observed = angleDiff(courseDeg, this.bearingDeg);
    if (this.offsetDeg === null) {
      this.offsetDeg = observed;
      this.observations = 1;
    } else {
      const dtMs = this.lastObservationT === null ? 0 : tMs - this.lastObservationT;
      // Exponential, in the shortest-arc sense — averaging 359° and 1° the
      // naive way gives 180°, which points the carrier backwards.
      const a = dtMs > 0 ? Math.min(1, dtMs / this.config.offsetTauMs) : 0.2;
      this.offsetDeg = normalise360(this.offsetDeg + a * angleDiff(observed, this.offsetDeg));
      this.observations++;
    }
    this.lastObservationT = tMs;
  }

  /**
   * The carrier's heading, or null if it cannot be asserted.
   *
   * Null is a real answer here and the caller must have a behaviour for it: no
   * magnetometer on this handset, a disturbed field, or a grip never learned
   * because the outage began before GNSS ever reported a course.
   */
  headingDeg(tMs: number): number | null {
    if (this.bearingDeg === null || this.offsetDeg === null) return null;
    if (this.observations < this.config.minObservations) return null;
    if (
      this.lastObservationT !== null &&
      tMs - this.lastObservationT > this.config.offsetMaxAgeMs
    ) {
      return null;
    }
    return normalise360(this.bearingDeg + this.offsetDeg);
  }

  /**
   * A yaw rate that steers `fromHeadingDeg` toward the magnetic answer.
   *
   * ★ A RATE, NOT A SET ★ Everything downstream — the turn detector, the ESKF,
   * the particle filter — reads the yaw rate the estimate integrates, and the
   * engine's own note says a detected turn must be "by construction the turn
   * the engine believes it made". Writing the heading directly would leave all
   * three reading a rate of zero through a corner the marker visibly took.
   * Expressed as a rate, a turn on foot becomes a turn everywhere.
   *
   * ★ COMPASS SENSE, CLOCKWISE POSITIVE ★ Not the gyroscope's right-hand rule.
   * `AttitudeEstimator.yawRate` has already negated by the time the engine has
   * a value to pass on — it returns "yaw rate about the true vertical, in the
   * compass sense", which is the convention DeadReckoningEngine integrates in.
   * This stands in for THAT value, so it takes that sign: a RIGHT turn, which
   * increases the compass bearing, is positive.
   */
  yawRateToward(
    tMs: number,
    fromHeadingDeg: number,
    dtMs: number,
    tauMs = 0,
  ): number | null {
    const target = this.headingDeg(tMs);
    if (target === null || !(dtMs > 0)) return null;
    const errRad = (angleDiff(target, fromHeadingDeg) * Math.PI) / 180;
    // ★ CLOSE THE ERROR IN tau SECONDS, NOT IN ONE SAMPLE ★
    //
    // `errRad / dt` is the rate that lands exactly on the target THIS sample —
    // a set dressed as a rate. On foot that is what is wanted, because the
    // magnetometer is the only heading there is and the gyro is not to be
    // trusted at all. In a vehicle it is wrong in shape: the gyro is the
    // better instrument over a corner and the compass is the better one over a
    // minute, and a pull that saturates its own clamp for any error above
    // 0.008° fights the gyro through every turn at full authority instead of
    // letting the turn happen and taking the offset out afterwards.
    //
    // With a time constant the pull is PROPORTIONAL: at the 5 s the engine
    // ships, a 9° residual — the median this compass actually shows on a
    // mounted handset — asks for 1.8°/s and is invisible against a corner's
    // 30°/s, while a 90° blunder asks for 18°/s and is gone in seconds. That is
    // the classic complementary split — gyro on the short term, magnetometer
    // on the long — expressed as the one thing this engine integrates.
    //
    // The caller still clamps. See `vehicleHeadingAidDegPerSec`: this sets the
    // gain, that catches a field disturbance asking for something absurd.
    const rate = tauMs > 0 ? errRad / (tauMs / 1000) : errRad / (dtMs / 1000);
    const limit = this.config.maxSlewRadPerSec;
    return Math.max(-limit, Math.min(limit, rate));
  }

  reset(): void {
    this.bearingDeg = null;
    this.offsetDeg = null;
    this.observations = 0;
    this.lastObservationT = null;
    this.reason = 'no magnetometer sample yet';
  }
}
