/**
 * IMU grades, and what changes between them.
 *
 * ★ THE POINT OF THE EDGE ENGINE, IN ONE FILE ★
 * The problem statement asks for the models to work with "any other external
 * IMU sensors data", not only a handset's. The honest way to demonstrate that
 * is not to claim it — it is to make sensor grade a *configuration* and show
 * the same navigation core consuming all three.
 *
 * What actually differs between a phone and a fibre-optic gyro is noise and
 * bias, by orders of magnitude, and the rate they can be read at. Nothing in
 * the estimator changes. That is the claim, and this file is what makes it
 * checkable rather than rhetorical.
 *
 * ★ WE DO NOT OWN A FOG IMU, AND SAY SO ★
 * A fibre-optic gyro costs several lakh rupees. The requirement is to support
 * that class of data, not to possess the hardware, so FOG figures here come
 * from published datasheet ranges for navigation-grade units and drive the
 * simulator in `sources/FogSimulatorSource.ts`. Any number produced from them
 * is a simulation result and must be reported as one — the same rule the rest
 * of this project already applies to its simulated drives.
 */

/** Which class of inertial sensor is feeding the engine. */
export type ImuGrade = 'PHONE_MEMS' | 'TACTICAL' | 'FOG';

export interface GradeProfile {
  grade: ImuGrade;
  /** Human label for the console and the report. */
  label: string;
  /** Rate this class of sensor is normally read at, Hz. */
  nominalRateHz: number;
  /** Gyro white noise, rad/s, 1-sigma per sample. */
  gyroNoiseRadS: number;
  /** Constant gyro bias, rad/s. This is what dominates heading drift. */
  gyroBiasRadS: number;
  /** Accelerometer white noise, m/s^2, 1-sigma per sample. */
  accelNoiseMps2: number;
  /** Constant accelerometer bias, m/s^2. This is what double-integrates. */
  accelBiasMps2: number;
  /** One-line justification, printed by `--list-grades` so nothing is magic. */
  note: string;
}

/**
 * Bias is quoted in rad/s because that is what the estimator consumes, but the
 * figure people recognise for a gyroscope is degrees per hour. The conversion
 * is kept here so the two can be checked against each other:
 *   1 deg/hr = (pi / 180) / 3600 rad/s = 4.848e-6 rad/s
 */
export const RAD_S_PER_DEG_HR = Math.PI / 180 / 3600;

export const GRADES: Record<ImuGrade, GradeProfile> = {
  PHONE_MEMS: {
    grade: 'PHONE_MEMS',
    label: 'Phone MEMS',
    // What a WebView actually delivers, not what the chip can do. The handset
    // build measures ~50-60 Hz and PROJECT_STATUS records the reasons.
    nominalRateHz: 50,
    gyroNoiseRadS: 0.002,
    // ~206 deg/hr. This is the number that makes unaided heading hopeless
    // after a couple of minutes, and it is why the phone build leans so hard
    // on ZARU to re-measure it at every stop.
    gyroBiasRadS: 0.001,
    accelNoiseMps2: 0.05,
    accelBiasMps2: 0.02,
    note: 'consumer handset; matches the simulator the mobile app is tuned against',
  },
  TACTICAL: {
    grade: 'TACTICAL',
    label: 'Tactical',
    nominalRateHz: 100,
    gyroNoiseRadS: 2e-4,
    // ~2 deg/hr — two orders of magnitude better than the handset.
    gyroBiasRadS: 1e-5,
    accelNoiseMps2: 5e-3,
    accelBiasMps2: 1e-3,
    note: 'MEMS/FOG hybrid class, ~2 deg/hr bias',
  },
  FOG: {
    grade: 'FOG',
    label: 'Fibre-optic gyro',
    // The rate the problem statement names for the edge engine.
    nominalRateHz: 200,
    gyroNoiseRadS: 1e-5,
    // 0.001 deg/hr, the figure the build guide quotes for navigation-grade.
    gyroBiasRadS: 0.001 * RAD_S_PER_DEG_HR,
    accelNoiseMps2: 1e-4,
    accelBiasMps2: 1e-5,
    note: '0.001 deg/hr navigation grade; simulated, we do not own the hardware',
  },
};

export function isImuGrade(v: string): v is ImuGrade {
  return v === 'PHONE_MEMS' || v === 'TACTICAL' || v === 'FOG';
}

/** Parse a grade name, case-insensitively, or throw with the valid options. */
export function parseGrade(v: string): ImuGrade {
  const up = v.toUpperCase().replace(/-/g, '_');
  if (!isImuGrade(up)) {
    throw new Error(`unknown IMU grade "${v}" — expected one of ${Object.keys(GRADES).join(', ')}`);
  }
  return up;
}

/** Gyro bias expressed the way a datasheet would, for display only. */
export function gyroBiasDegPerHour(p: GradeProfile): number {
  return p.gyroBiasRadS / RAD_S_PER_DEG_HR;
}
