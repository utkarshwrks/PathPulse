/**
 * Core data contracts for the PathPulse navigation engine.
 *
 * PURITY RULE: this file (and every file in @pathpulse/nav-core) is pure
 * TypeScript. No browser or Node APIs. See package.json for the full rule.
 */

/** Operating mode of the navigation state machine. */
export type NavMode =
  | 'INITIALIZING'
  | 'GNSS'
  | 'GNSS_DEGRADED'
  | 'DEAD_RECKONING'
  | 'RECOVERING'
  | 'ERROR';

/** A quaternion as [w, x, y, z]. */
export type Quaternion = [number, number, number, number];

/** A 3-axis reading as [x, y, z]. */
export type Vec3 = [number, number, number];

/** One raw sample from any SensorSource. GNSS may be absent; IMU should not be. */
export interface SensorSample {
  /** Monotonic milliseconds. NOT wall-clock — must never jump backwards. */
  t: number;
  gnss?: {
    lat: number;
    lon: number;
    /** Horizontal accuracy, 1-sigma, in metres. */
    accuracyM: number;
    speedMps?: number;
    headingDeg?: number;
    satCount?: number;
    /** Mean carrier-to-noise density, dB-Hz. Low values imply multipath. */
    meanCn0?: number;
  };
  imu?: {
    /** Specific force, m/s^2, device frame. Includes gravity. */
    ax: number;
    ay: number;
    az: number;
    /**
     * Angular rate, rad/s, device frame, RIGHT-HAND RULE — the convention the
     * hardware itself uses (DeviceMotionEvent.rotationRate, Android's
     * SensorManager). Viewed from above with +Z out of the screen, a right
     * turn is clockwise and therefore NEGATIVE.
     *
     * Sources must NOT pre-convert this to a compass sense. nav-core resolves
     * yaw by projecting the gyro vector onto measured gravity, which needs the
     * raw axes; converting early also assumes the phone is lying flat.
     */
    gx: number;
    gy: number;
    gz: number;
    /** Rotation vector, if the device exposes one. */
    quat?: Quaternion;
  };
  baro?: {
    pressureHpa: number;
  };
}

/** Everything the UI needs, emitted at 10 Hz. */
export interface NavigationState {
  t: number;
  mode: NavMode;
  position: { lat: number; lon: number };
  velocityMps: number;
  headingDeg: number;
  /**
   * Uncertainty, decomposed relative to the direction of travel.
   * Kept as along/cross (not a single radius) because road snapping bounds
   * cross-track error while along-track error keeps growing — that asymmetry
   * is the whole story, and it is why the UI draws an ellipse, not a circle.
   */
  covariance: { alongM: number; crossM: number; headingDeg: number };
  /** 0..1 */
  confidence: number;
  distanceTravelledM: number;
  timeSinceGnssMs: number;
  estimatedDriftM: number;
  matchedRoad?: { wayId: string; arcLengthM: number; name?: string };
  biases: { accel: Vec3; gyro: Vec3 };
}

/** Local tangent-plane coordinates in metres. */
export interface EnuPoint {
  e: number;
  n: number;
  u?: number;
}

/** Geodetic coordinates, degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}
