/**
 * Process- and measurement-noise settings for the error-state filter.
 *
 * ★ THE NOISE MODEL IS THE FILTER ★
 * Every line of ErrorStateKalmanFilter.ts is textbook and would be the same in
 * any implementation. What makes an estimate good or useless is the numbers in
 * this file: they are the filter's opinion about how much to believe the IMU
 * versus the GNSS versus the road, and a Kalman gain is nothing but that
 * opinion made arithmetic.
 *
 * The three IMU grades exist because the problem statement asks for a phone at
 * 10 Hz AND an edge engine reading an external FOG-grade unit at 200 Hz. Same
 * filter, same code path, one config object apart — which is the claim
 * packages/edge-engine makes, so it had better be true here.
 */

/** Continuous-time IMU noise, the numbers a datasheet gives you. */
export interface ImuNoise {
  /** Accelerometer white noise, m/s^2 per sqrt(Hz) (velocity random walk). */
  accelNoiseDensity: number;
  /** Gyroscope white noise, rad/s per sqrt(Hz) (angle random walk). */
  gyroNoiseDensity: number;
  /** Accelerometer bias random walk, m/s^3 per sqrt(Hz). */
  accelBiasRandomWalk: number;
  /** Gyroscope bias random walk, rad/s^2 per sqrt(Hz). */
  gyroBiasRandomWalk: number;
}

export type ImuGrade = 'PHONE_MEMS' | 'TACTICAL' | 'FOG';

/**
 * Grades, worst to best. Roughly three orders of magnitude separate the ends.
 *
 * PHONE_MEMS is measured from the handsets this runs on, not from a datasheet:
 * a phone accelerometer's bias moves with temperature and with how the case is
 * being squeezed, and its published noise density flatters it badly.
 *
 * FOG is not aspirational marketing — the problem statement names a
 * fibre-optic gyro for the edge deliverable, and the point of carrying the
 * grade in config is that the same estimator, told the truth about a better
 * sensor, trusts it more. Nobody has to buy one to demonstrate that.
 */
export const IMU_NOISE: Record<ImuGrade, ImuNoise> = {
  PHONE_MEMS: {
    accelNoiseDensity: 0.08,
    gyroNoiseDensity: 0.008,
    accelBiasRandomWalk: 0.004,
    gyroBiasRandomWalk: 4e-5,
  },
  TACTICAL: {
    accelNoiseDensity: 0.005,
    gyroNoiseDensity: 2e-4,
    accelBiasRandomWalk: 1e-4,
    gyroBiasRandomWalk: 1e-6,
  },
  FOG: {
    accelNoiseDensity: 5e-4,
    gyroNoiseDensity: 5e-6,
    accelBiasRandomWalk: 1e-5,
    gyroBiasRandomWalk: 2e-8,
  },
};

export interface EskfConfig {
  imu: ImuNoise;
  /** Gravity in the ENU nav frame, m/s^2. Up is +z, so this is negative. */
  gravityMps2: number;
  /**
   * Standard deviation of the NHC pseudo-measurement, m/s.
   *
   * ★ SMALL, BUT NEVER ZERO ★ "A car does not slide sideways" is true of a car
   * and false of the estimate of one: the body frame is only as good as the
   * alignment, a 2-degree mounting error turns 20 m/s of forward motion into
   * 0.7 m/s of apparent lateral motion, and asserting that as exactly zero
   * makes the filter certain of a lie and drives the covariance to nothing.
   * 0.15 m/s is tight enough to bound cross-track drift and loose enough to
   * absorb an imperfect mount.
   */
  nhcSigmaMps: number;
  /** ZUPT velocity sigma, m/s. A stopped vehicle is genuinely stopped. */
  zuptSigmaMps: number;
  /** ZARU angular-rate sigma, rad/s — this is what makes gyro bias observable. */
  zaruSigmaRadPerSec: number;
  /**
   * Cross-track sigma for a road-projection update, m.
   *
   * Half a lane. The measurement says "the vehicle is on this road", and the
   * uncertainty in that statement is which lane it is in.
   */
  roadCrossTrackSigmaM: number;
  /** Barometric altitude-change sigma, m. */
  baroSigmaM: number;
  /** Initial 1-sigma uncertainties used to seed P. */
  initial: {
    positionM: number;
    velocityMps: number;
    attitudeRad: number;
    accelBias: number;
    gyroBias: number;
  };
}

export const DEFAULT_ESKF_CONFIG: EskfConfig = {
  imu: IMU_NOISE.PHONE_MEMS,
  gravityMps2: 9.80665,
  nhcSigmaMps: 0.15,
  zuptSigmaMps: 0.02,
  zaruSigmaRadPerSec: 0.002,
  roadCrossTrackSigmaM: 1.75,
  baroSigmaM: 1.5,
  initial: {
    positionM: 5,
    velocityMps: 1,
    attitudeRad: 0.1,
    accelBias: 0.3,
    gyroBias: 0.02,
  },
};

export function eskfConfigForGrade(grade: ImuGrade, patch: Partial<EskfConfig> = {}): EskfConfig {
  return { ...DEFAULT_ESKF_CONFIG, imu: IMU_NOISE[grade], ...patch };
}
