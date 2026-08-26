import type { EnuPoint, Vec3 } from '../types.js';
import { normalizeAngle360, normalizeRadians } from '../geo/angles.js';

export interface DeadReckoningConfig {
  /** Plausible vehicle speed ceiling, m/s. 40 m/s = 144 km/h. */
  maxSpeedMps: number;
  /** Sign applied to gyro-Z before integrating. See the convention note below. */
  gyroZSign: 1 | -1;
  /** Fixes averaged to build the pre-outage seed state. */
  smoothingFixCount: number;
}

export const DEFAULT_DR_CONFIG: DeadReckoningConfig = {
  maxSpeedMps: 40,
  gyroZSign: 1,
  smoothingFixCount: 5,
};

/** A GNSS fix trusted enough to seed or reset dead reckoning. */
export interface TrustedFix {
  t: number;
  enu: EnuPoint;
  speedMps: number;
  headingDeg: number;
  accuracyM: number;
}

export interface DeadReckoningState {
  enu: EnuPoint;
  speedMps: number;
  headingDeg: number;
  distanceTravelledM: number;
  biases: { accel: Vec3; gyro: Vec3 };
}

/**
 * Propagates position from inertial data alone.
 *
 * ★ SIGN CONVENTION ★ Heading here is a compass bearing: degrees clockwise
 * from north, so turning right increases it. Gyroscope Z is expected in the
 * same sense. Android's raw gyroscope uses the right-hand rule with +Z out of
 * the screen, which is the opposite sense — sensor sources are responsible for
 * negating it before nav-core ever sees it. Getting this backwards makes the
 * vehicle turn left when it turned right, and no amount of downstream
 * filtering will recover it.
 */
export class DeadReckoningEngine {
  private state: DeadReckoningState = {
    enu: { e: 0, n: 0 },
    speedMps: 0,
    headingDeg: 0,
    distanceTravelledM: 0,
    biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
  };

  private readonly config: DeadReckoningConfig;
  /** Rolling window of recent good fixes, newest last. */
  private recentFixes: TrustedFix[] = [];
  private lastTrustedSpeed = 0;
  private initialised = false;

  constructor(config: Partial<DeadReckoningConfig> = {}) {
    this.config = { ...DEFAULT_DR_CONFIG, ...config };
  }

  get current(): Readonly<DeadReckoningState> {
    return this.state;
  }

  get isInitialised(): boolean {
    return this.initialised;
  }

  /** Record a fix good enough to trust. Keeps the smoothing window fed. */
  pushFix(fix: TrustedFix): void {
    this.recentFixes.push(fix);
    if (this.recentFixes.length > this.config.smoothingFixCount) this.recentFixes.shift();
    this.lastTrustedSpeed = fix.speedMps;
  }

  /**
   * Snap dead reckoning onto a GNSS fix. Called continuously while GNSS is
   * healthy — this is shadow mode: the engine is always running and always
   * corrected, so when GNSS disappears there is no start-up cost.
   */
  resetTo(fix: TrustedFix): void {
    this.state.enu = { ...fix.enu };
    this.state.speedMps = fix.speedMps;
    this.state.headingDeg = fix.headingDeg;
    this.initialised = true;
  }

  /**
   * Seed the outage from a *smoothed* view of the recent past.
   *
   * The literal last fix before a tunnel is usually the worst one in the whole
   * drive: the vehicle is already under the overpass, satellites are grazing
   * concrete, and multipath has set in. Anchoring an entire outage to that
   * sample bakes its error into every metre that follows.
   *
   * So: reject a final fix whose accuracy is an outlier, and take speed and
   * heading from the median of the window rather than a single reading.
   */
  initializeFromRecentFixes(): boolean {
    if (this.recentFixes.length === 0) return false;

    const fixes = [...this.recentFixes];
    if (fixes.length >= 3) {
      const accuracies = fixes.map((f) => f.accuracyM).sort((a, b) => a - b);
      const medianAccuracy = accuracies[Math.floor(accuracies.length / 2)]!;
      const newest = fixes[fixes.length - 1]!;
      // A last fix twice as uncertain as the window median is multipath.
      if (newest.accuracyM > medianAccuracy * 2 && fixes.length > 1) fixes.pop();
    }

    const anchor = fixes[fixes.length - 1]!;
    const speeds = fixes.map((f) => f.speedMps).sort((a, b) => a - b);
    const medianSpeed = speeds[Math.floor(speeds.length / 2)]!;

    this.state.enu = { ...anchor.enu };
    this.state.speedMps = medianSpeed;
    this.state.headingDeg = circularMedianDeg(fixes.map((f) => f.headingDeg));
    this.initialised = true;
    return true;
  }

  /**
   * Advance the estimate by one IMU step.
   *
   * @param forwardAccelMps2 longitudinal acceleration, gravity already removed
   * @param gyroZRadPerSec   yaw rate in the compass sense (see class note)
   * @param dtMs             elapsed time
   * @param gnssSpeedMps     GNSS speed when it is trustworthy, else undefined
   */
  propagate(
    forwardAccelMps2: number,
    gyroZRadPerSec: number,
    dtMs: number,
    gnssSpeedMps?: number,
  ): Readonly<DeadReckoningState> {
    const dt = dtMs / 1000;
    if (dt <= 0 || dt > 1) return this.state; // clock jump or duplicate sample

    // --- heading -----------------------------------------------------------
    const yawRate = this.config.gyroZSign * (gyroZRadPerSec - this.state.biases.gyro[2]);
    const headingRad = normalizeRadians(
      (this.state.headingDeg * Math.PI) / 180 + yawRate * dt,
    );
    this.state.headingDeg = normalizeAngle360((headingRad * 180) / Math.PI);

    // --- speed, in order of how much we trust the source --------------------
    const accel = Number.isFinite(forwardAccelMps2) ? forwardAccelMps2 : 0;
    let speed: number;
    if (gnssSpeedMps !== undefined && Number.isFinite(gnssSpeedMps)) {
      // 1. GNSS Doppler speed. Independent of position error and far more
      //    accurate than anything we can integrate.
      speed = gnssSpeedMps;
      this.lastTrustedSpeed = gnssSpeedMps;
    } else {
      // 2. Last trusted speed carried forward with accelerometer integration.
      //    (Phase 8 inserts the ML speed model above this fallback.)
      speed = this.state.speedMps + accel * dt;
    }

    // Plausibility clamp. A car does not reverse at 40 m/s or exceed 144 km/h;
    // anything outside that is integrated sensor error, not motion.
    speed = Math.max(0, Math.min(this.config.maxSpeedMps, speed));

    // --- position -----------------------------------------------------------
    // ds uses the trapezoid term so constant acceleration is integrated
    // exactly rather than accumulating a systematic shortfall each step.
    const ds = speed * dt + 0.5 * accel * dt * dt;
    const travelled = Math.max(0, ds);
    const hRad = (this.state.headingDeg * Math.PI) / 180;

    // Compass bearing: east is sin, north is cos. Swapping these is the
    // classic bug that mirrors the whole trajectory about the diagonal.
    this.state.enu = {
      e: this.state.enu.e + travelled * Math.sin(hRad),
      n: this.state.enu.n + travelled * Math.cos(hRad),
    };
    this.state.speedMps = speed;
    this.state.distanceTravelledM += travelled;

    return this.state;
  }

  /** Force velocity to zero — used by Phase 6's ZUPT when the vehicle stops. */
  applyZeroVelocity(): void {
    this.state.speedMps = 0;
    this.lastTrustedSpeed = 0;
  }

  setGyroBias(bias: Vec3): void {
    this.state.biases.gyro = bias;
  }

  setAccelBias(bias: Vec3): void {
    this.state.biases.accel = bias;
  }

  get lastTrustedSpeedMps(): number {
    return this.lastTrustedSpeed;
  }

  resetDistance(): void {
    this.state.distanceTravelledM = 0;
  }

  reset(): void {
    this.state = {
      enu: { e: 0, n: 0 },
      speedMps: 0,
      headingDeg: 0,
      distanceTravelledM: 0,
      biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
    };
    this.recentFixes = [];
    this.lastTrustedSpeed = 0;
    this.initialised = false;
  }
}

/** Median of compass bearings, taken through unit vectors so 359 and 1 average to 0. */
function circularMedianDeg(headings: number[]): number {
  if (headings.length === 0) return 0;
  let sumSin = 0;
  let sumCos = 0;
  for (const h of headings) {
    const r = (h * Math.PI) / 180;
    sumSin += Math.sin(r);
    sumCos += Math.cos(r);
  }
  return normalizeAngle360((Math.atan2(sumSin, sumCos) * 180) / Math.PI);
}
