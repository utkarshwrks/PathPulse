import { describe, expect, it } from 'vitest';
import { AttitudeEstimator } from '../src/index.js';

const G = 9.80665;

/**
 * Deep tests for the attitude reference.
 *
 * This class is the single point of failure for heading. If it is wrong,
 * everything downstream is wrong in a way no filter can recover, so it gets
 * tested against arbitrary orientations rather than the two or three that
 * happen to be convenient.
 */

/** Rotate a vector by roll (about X), then pitch (about Y). */
function tilt(v: [number, number, number], rollRad: number, pitchRad: number): [number, number, number] {
  const [x, y, z] = v;
  // Roll about X.
  const y1 = y * Math.cos(rollRad) - z * Math.sin(rollRad);
  const z1 = y * Math.sin(rollRad) + z * Math.cos(rollRad);
  // Pitch about Y.
  const x2 = x * Math.cos(pitchRad) + z1 * Math.sin(pitchRad);
  const z2 = -x * Math.sin(pitchRad) + z1 * Math.cos(pitchRad);
  return [x2, y1, z2];
}

/** Settle an estimator at a given mount orientation. */
function settled(rollRad: number, pitchRad: number): AttitudeEstimator {
  const att = new AttitudeEstimator();
  const a = tilt([0, 0, G], rollRad, pitchRad);
  for (let i = 0; i < 400; i++) att.push(a[0], a[1], a[2], 0, 0, 0, 20);
  return att;
}

describe('AttitudeEstimator — arbitrary mounting orientations', () => {
  const ORIENTATIONS: Array<[string, number, number]> = [
    ['flat on its back', 0, 0],
    ['tilted 30° back in a cradle', (30 * Math.PI) / 180, 0],
    ['tilted 60° back', (60 * Math.PI) / 180, 0],
    ['upright, 90°', (90 * Math.PI) / 180, 0],
    ['rolled 20° left', 0, (20 * Math.PI) / 180],
    ['tilted 45° and rolled 25°', (45 * Math.PI) / 180, (25 * Math.PI) / 180],
    ['nearly upside down', (170 * Math.PI) / 180, 0],
  ];

  it.each(ORIENTATIONS)('finds the vertical when %s', (_name, roll, pitch) => {
    const att = settled(roll, pitch);
    const expected = tilt([0, 0, 1], roll, pitch);
    const up = att.upVector;
    // Dot product of two unit vectors: 1 means identical.
    const dot = up[0] * expected[0] + up[1] * expected[1] + up[2] * expected[2];
    expect(dot).toBeGreaterThan(0.999);
  });

  it.each(ORIENTATIONS)('recovers a real yaw rate when %s', (_name, roll, pitch) => {
    const att = settled(roll, pitch);
    // A physical left turn at 0.2 rad/s is a rotation about the WORLD vertical.
    // Expressed in device axes that is 0.2 * up.
    const trueYawRate = 0.2;
    const up = tilt([0, 0, 1], roll, pitch);
    const gyro: [number, number, number] = [
      trueYawRate * up[0],
      trueYawRate * up[1],
      trueYawRate * up[2],
    ];
    // Compass sense is the negation of the right-hand rule about up.
    expect(att.yawRate(gyro[0], gyro[1], gyro[2])).toBeCloseTo(-trueYawRate, 3);
  });

  it('ignores rotation about a horizontal axis — that is pitch or roll, not yaw', () => {
    const att = settled(0, 0); // up is +Z
    // Rotation purely about device X is pitching, and must not change heading.
    expect(att.yawRate(0.5, 0, 0)).toBeCloseTo(0, 6);
    expect(att.yawRate(0, 0.5, 0)).toBeCloseTo(0, 6);
  });

  it('subtracts gyro bias before projecting', () => {
    const att = settled(0, 0);
    const bias: [number, number, number] = [0.001, -0.002, 0.01];
    // With the reading equal to the bias, the true rate is zero.
    expect(att.yawRate(bias[0], bias[1], bias[2], bias)).toBeCloseTo(0, 6);
  });
});

describe('AttitudeEstimator — the complementary filter must not eat acceleration', () => {
  it('holds the vertical through ten seconds of hard acceleration', () => {
    // ★ THIS IS FIELD DEFECT #6 ★
    // A low-pass "gravity" estimate follows a sustained acceleration and tilts
    // toward it, so subtracting it cancels the very signal being integrated.
    // Speed then never rebuilds after a stop. The gyro-propagated vertical must
    // stay put when the vehicle accelerates in a straight line.
    const att = settled(0, 0);
    const before = [...att.upVector];

    // 10 s of 2 m/s^2 along +Y, no rotation at all.
    for (let i = 0; i < 500; i++) att.push(0, 2, G, 0, 0, 0, 20);

    const after = att.upVector;
    const dot = before[0]! * after[0] + before[1]! * after[1] + before[2]! * after[2];
    const driftDeg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    // Measured values for this exact scenario, so the bound is a regression
    // guard rather than a fitted constant:
    //   0.25 Hz low-pass "gravity"        ~11.5 deg  (the original defect)
    //   complementary filter, no gate      3.15 deg
    //   complementary filter + mag gate    1.58 deg  (current)
    // 1.58 deg still injects 0.27 m/s^2 of false acceleration, which is why
    // ForwardBiasEstimator exists to mop up the steady part.
    expect(driftDeg).toBeLessThan(2);
  });

  it('still reports most of a sustained acceleration as forward acceleration', () => {
    const att = settled(0, 0);
    for (let i = 0; i < 500; i++) att.push(0, 2, G, 0, 0, 0, 20);
    const linear = att.removeGravity(0, 2, G);
    const h = att.toHorizontal(linear);
    // Some leakage is inevitable and acceptable; losing most of it is not.
    expect(h.forward).toBeGreaterThan(1.5);
  });

  it('still corrects a genuine long-term change in orientation', () => {
    // The filter must anchor to gravity eventually, or gyro bias would walk the
    // vertical away without limit over a long drive.
    const att = settled(0, 0);
    const tilted = tilt([0, 0, G], (20 * Math.PI) / 180, 0);
    // Five minutes at the new orientation, no gyro input at all.
    for (let i = 0; i < 15_000; i++) att.push(tilted[0], tilted[1], tilted[2], 0, 0, 0, 20);
    const expected = tilt([0, 0, 1], (20 * Math.PI) / 180, 0);
    const up = att.upVector;
    const dot = up[0] * expected[0] + up[1] * expected[1] + up[2] * expected[2];
    expect(dot).toBeGreaterThan(0.99);
  });

  it('tracks the vertical through a rotation using the gyro', () => {
    const att = settled(0, 0);
    // Physically pitch the phone 30 degrees back over 3 s, feeding both the
    // rotating accelerometer and the matching gyro rate.
    const totalRad = (30 * Math.PI) / 180;
    const steps = 150;
    // Sign convention, worked through: rotating the DEVICE by +w about its X
    // axis lifts the top edge, and a world-fixed vector therefore appears to
    // rotate by -w in device coordinates — so world-up moves toward +Y. Our
    // `tilt(+angle)` moves the up vector toward -Y, which is the device
    // rotating the other way. Hence the negative gyro rate here.
    const rate = -totalRad / 3; // rad/s about device X
    for (let i = 1; i <= steps; i++) {
      const angle = (totalRad * i) / steps;
      const a = tilt([0, 0, G], angle, 0);
      att.push(a[0], a[1], a[2], rate, 0, 0, 20);
    }
    const expected = tilt([0, 0, 1], totalRad, 0);
    const up = att.upVector;
    const dot = up[0] * expected[0] + up[1] * expected[1] + up[2] * expected[2];
    expect(dot).toBeGreaterThan(0.995);
  });
});

describe('AttitudeEstimator — robustness', () => {
  it('refuses to answer before it has settled', () => {
    const att = new AttitudeEstimator();
    expect(att.isSettled).toBe(false);
    expect(att.yawRate(0, 0, 1)).toBe(0);
    expect(att.toHorizontal([1, 1, 1])).toEqual({ forward: 0, lateral: 0, vertical: 0 });
  });

  it('survives free fall without producing infinities', () => {
    const att = settled(0, 0);
    const before = [...att.upVector];
    for (let i = 0; i < 50; i++) att.push(0, 0, 0, 0, 0, 0, 20);
    expect(att.upVector.every(Number.isFinite)).toBe(true);
    // Held the last good vertical rather than normalising by zero.
    expect(att.upVector[2]).toBeCloseTo(before[2]!, 6);
  });

  it('ignores non-finite input', () => {
    const att = settled(0, 0);
    att.push(NaN, 0, G, 0, 0, 0, 20);
    att.push(0, Infinity, G, 0, 0, 0, 20);
    expect(att.upVector.every(Number.isFinite)).toBe(true);
    expect(att.yawRate(NaN, 0, 0)).toBe(0);
  });

  it('ignores an implausible dt rather than integrating a clock jump', () => {
    const att = settled(0, 0);
    const before = [...att.upVector];
    att.push(0, 0, G, 1, 1, 1, 60_000); // a minute in one step
    const after = att.upVector;
    const dot = before[0]! * after[0] + before[1]! * after[1] + before[2]! * after[2];
    expect(dot).toBeGreaterThan(0.999);
  });

  it('keeps the up vector normalised over a long run', () => {
    const att = settled(0, 0);
    for (let i = 0; i < 5000; i++) {
      att.push(0.4 * Math.sin(i), 0.4 * Math.cos(i), G, 0.02, -0.01, 0.03, 20);
    }
    const m = Math.hypot(...att.upVector);
    expect(m).toBeCloseTo(1, 6);
  });

  it('resets cleanly', () => {
    const att = settled((45 * Math.PI) / 180, 0);
    att.reset();
    expect(att.isSettled).toBe(false);
    expect(att.upVector).toEqual([0, 0, 1]);
  });
});
