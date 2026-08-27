import type { Vec3 } from '@pathpulse/nav-core';
import type { VehicleState } from './vehicle.js';

export const GRAVITY_MPS2 = 9.80665;

export interface ImuNoiseConfig {
  /** Accelerometer white noise, 1-sigma, m/s^2. */
  accelSigma: number;
  /** Gyroscope white noise, 1-sigma, rad/s. */
  gyroSigma: number;
  /** Constant accelerometer bias, m/s^2 — typical consumer MEMS. */
  accelBias: Vec3;
  /** Constant gyroscope bias, rad/s. */
  gyroBias: Vec3;
  /** Engine/road vibration amplitude in the vertical axis, m/s^2. */
  vibrationAmplitude: number;
  /** Vibration frequency, Hz. Real engine harmonics sit around 15-25 Hz. */
  vibrationHz: number;
}

/**
 * Defaults model a phone-grade MEMS IMU on a dashboard mount.
 *
 * The bias terms matter more than the noise. White noise averages out; a
 * constant 0.02 m/s^2 bias double-integrates into ~36 m of position error
 * after one minute. Simulating without bias would make dead reckoning look
 * far better than it is and every downstream number a lie.
 */
export const PHONE_MEMS_NOISE: ImuNoiseConfig = {
  accelSigma: 0.05,
  gyroSigma: 0.002,
  accelBias: [0.02, -0.015, 0.01],
  gyroBias: [0.001, -0.0008, 0.0012],
  vibrationAmplitude: 0.25,
  vibrationHz: 20,
};

/** A perfect IMU. Useful for isolating algorithm error from sensor error. */
export const IDEAL_NOISE: ImuNoiseConfig = {
  accelSigma: 0,
  gyroSigma: 0,
  accelBias: [0, 0, 0],
  gyroBias: [0, 0, 0],
  vibrationAmplitude: 0,
  vibrationHz: 0,
};

export interface ImuReading {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
}

/**
 * Synthesise one IMU sample in the vehicle body frame.
 *
 * Body frame: +X right, +Y forward, +Z up. The phone is assumed flat on a
 * dashboard and aligned with the vehicle; Phase 12 handles arbitrary mounting.
 *
 * The accelerometer measures *specific force*, not acceleration — so a
 * stationary device reads +9.81 on the up axis, not 0. Getting this sign wrong
 * is the classic dead-reckoning bug: it makes the estimator think the vehicle
 * is permanently accelerating upward.
 */
export function synthesizeImu(
  state: Readonly<VehicleState>,
  tMs: number,
  noise: ImuNoiseConfig,
  gaussian: () => number,
): ImuReading {
  // Centripetal acceleration points left/right depending on turn direction.
  const lateral = state.speedMps * state.yawRateRadPerSec;

  const vibration =
    noise.vibrationAmplitude > 0
      ? noise.vibrationAmplitude *
        Math.sin(2 * Math.PI * noise.vibrationHz * (tMs / 1000)) *
        // Idle still shakes, but a moving vehicle shakes more.
        (state.isStopped ? 0.35 : 1)
      : 0;

  return {
    ax: lateral + noise.accelBias[0] + noise.accelSigma * gaussian(),
    ay: state.accelMps2 + noise.accelBias[1] + noise.accelSigma * gaussian(),
    az: GRAVITY_MPS2 + vibration + noise.accelBias[2] + noise.accelSigma * gaussian(),
    gx: noise.gyroBias[0] + noise.gyroSigma * gaussian(),
    gy: noise.gyroBias[1] + noise.gyroSigma * gaussian(),
    // ★ RIGHT-HAND RULE, LIKE THE REAL HARDWARE ★
    //
    // `yawRateRadPerSec` is d(compass heading)/dt, so it is positive when the
    // vehicle turns right. A real accelerometer/gyro package — and
    // DeviceMotionEvent.rotationRate.alpha, which is what both the browser and
    // Capacitor sources hand us — follows the right-hand rule about device +Z,
    // pointing out of the screen. Viewed from above, a right turn is clockwise,
    // which is NEGATIVE under that rule.
    //
    // The simulator used to emit the compass sense directly. That made it
    // disagree with every real device by a sign, so the engine could be tuned
    // to look perfect in simulation while turning the wrong way on a phone —
    // precisely the class of lie that makes a simulator worse than useless.
    gz: -state.yawRateRadPerSec + noise.gyroBias[2] + noise.gyroSigma * gaussian(),
  };
}
