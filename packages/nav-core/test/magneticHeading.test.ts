import { describe, expect, it } from 'vitest';
import { MagneticHeading } from '../src/index.js';

/**
 * The compass, on its own.
 *
 * pedestrian-corners.test.ts measures what it is worth inside the engine. This
 * checks the arithmetic it rests on — levelling, the grip offset, and the four
 * ways it is required to answer "I cannot say".
 */

/** Earth's field at roughly Jabalpur: 47 µT, 42° down. */
const F = 47;
const INC = (42 * Math.PI) / 180;
const H = F * Math.cos(INC);
const D = F * Math.sin(INC);

/**
 * The field and gravity a phone would read, given how it is held.
 *
 * `yawDeg` is the compass bearing of the device's +y axis; `pitchDeg` tips the
 * phone up out of flat, which is how anybody actually looks at a screen.
 */
function reading(yawDeg: number, pitchDeg = 0) {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  // World -> device, flat and yawed: north lands on (-sin y, cos y, 0).
  const flatMag = { x: H * -Math.sin(y), y: H * Math.cos(y), z: -D };
  const flatUp = { x: 0, y: 0, z: 9.81 };
  // Then tip about the device's x axis.
  const tip = (v: { x: number; y: number; z: number }) => ({
    x: v.x,
    y: Math.cos(p) * v.y - Math.sin(p) * v.z,
    z: Math.sin(p) * v.y + Math.cos(p) * v.z,
  });
  return { mag: tip(flatMag), up: tip(flatUp) };
}

/** Smallest signed difference, degrees. */
function diff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

describe('MagneticHeading — the bearing', () => {
  it('reads the bearing of the device, flat', () => {
    for (const yaw of [0, 45, 90, 180, 270, 355]) {
      const m = new MagneticHeading();
      const { mag, up } = reading(yaw);
      m.push(mag, up);
      expect(Math.abs(diff(m.state.deviceBearingDeg!, yaw))).toBeLessThan(0.5);
    }
  });

  it('★ reads the same bearing with the phone tipped up, which is how it is held', () => {
    // The whole point of levelling. Without it, a phone held at 60° reports a
    // bearing that is a function of how far it is tipped — the same mistake the
    // speed model was making with its raw channels.
    for (const pitch of [0, 20, 45, 60, 75]) {
      const m = new MagneticHeading();
      const { mag, up } = reading(130, pitch);
      m.push(mag, up);
      expect(Math.abs(diff(m.state.deviceBearingDeg!, 130))).toBeLessThan(1);
    }
  });
});

describe('MagneticHeading — the grip', () => {
  /** Feed enough course observations to satisfy minObservations. */
  function learn(m: MagneticHeading, deviceYaw: number, course: number, n = 8) {
    for (let i = 0; i < n; i++) {
      const { mag, up } = reading(deviceYaw);
      m.push(mag, up);
      m.observeCourse(i * 1000, course);
    }
  }

  it('★ learns that the phone is not pointing where the carrier is going', () => {
    const m = new MagneticHeading();
    // Phone points east, carrier walks north: a 90° grip.
    learn(m, 90, 0);
    expect(Math.abs(diff(m.state.offsetDeg!, -90))).toBeLessThan(5);
    expect(Math.abs(diff(m.headingDeg(8000)!, 0))).toBeLessThan(5);
  });

  it('★ carries the turn: the phone rotates with the carrier and the heading follows', () => {
    const m = new MagneticHeading();
    learn(m, 90, 0);
    // The carrier turns right onto east. The grip is unchanged, so the device
    // now reads 180 and the heading must come out at 90.
    const { mag, up } = reading(180);
    m.push(mag, up);
    expect(Math.abs(diff(m.headingDeg(9000)!, 90))).toBeLessThan(5);
  });

  it('averages the offset the short way round', () => {
    // 359 and 1 average to 0, not to 180 — which would point the carrier
    // backwards down the lane.
    const m = new MagneticHeading();
    for (let i = 0; i < 20; i++) {
      const { mag, up } = reading(0);
      m.push(mag, up);
      m.observeCourse(i * 1000, i % 2 === 0 ? 359 : 1);
    }
    expect(Math.abs(diff(m.state.offsetDeg!, 0))).toBeLessThan(10);
  });
});

describe('MagneticHeading — the four ways it says "I cannot"', () => {
  it('refuses a field that is not the Earth\'s', () => {
    const m = new MagneticHeading();
    const { up } = reading(0);
    // A car door, a transformer, a speaker magnet.
    m.push({ x: 300, y: 0, z: 0 }, up);
    expect(m.state.deviceBearingDeg).toBeNull();
    expect(m.state.reason).toContain('µT');
  });

  it('refuses before the grip has been observed enough times', () => {
    const m = new MagneticHeading();
    const { mag, up } = reading(90);
    m.push(mag, up);
    expect(m.headingDeg(0)).toBeNull();
    m.observeCourse(0, 0);
    // One observation is a coincidence, not a grip.
    expect(m.headingDeg(0)).toBeNull();
  });

  it('★ abandons a grip too old to describe the hand holding the phone', () => {
    const m = new MagneticHeading();
    for (let i = 0; i < 8; i++) {
      const { mag, up } = reading(90);
      m.push(mag, up);
      m.observeCourse(i * 1000, 0);
    }
    expect(m.headingDeg(8000)).not.toBeNull();
    // Four minutes later that hand has put the phone in a pocket.
    expect(m.headingDeg(8000 + 240_000)).toBeNull();
  });

  it('refuses a vertical field and a free-falling handset', () => {
    const m = new MagneticHeading();
    m.push({ x: 0, y: 0, z: 47 }, { x: 0, y: 0, z: 9.81 });
    expect(m.state.deviceBearingDeg).toBeNull();
    const m2 = new MagneticHeading();
    const { mag } = reading(0);
    m2.push(mag, { x: 0, y: 0, z: 0 });
    expect(m2.state.deviceBearingDeg).toBeNull();
  });
});

describe('MagneticHeading — steering', () => {
  it('★ is a rate, in the compass sense the estimator integrates', () => {
    // AttitudeEstimator has already converted from the gyroscope's right-hand
    // rule by the time the engine has a value to pass on, so a RIGHT turn —
    // increasing bearing — must be positive here.
    const m = new MagneticHeading();
    for (let i = 0; i < 8; i++) {
      const { mag, up } = reading(0);
      m.push(mag, up);
      m.observeCourse(i * 1000, 0);
    }
    const { mag, up } = reading(30);
    m.push(mag, up);
    const rate = m.yawRateToward(9000, 0, 100)!;
    expect(rate).toBeGreaterThan(0);
  });

  it('slews rather than snaps', () => {
    const m = new MagneticHeading();
    for (let i = 0; i < 8; i++) {
      const { mag, up } = reading(0);
      m.push(mag, up);
      m.observeCourse(i * 1000, 0);
    }
    const { mag, up } = reading(170);
    m.push(mag, up);
    // 170° in 100 ms would be 30 rad/s. Bounded to a sharp human pivot.
    expect(Math.abs(m.yawRateToward(9000, 0, 100)!)).toBeLessThanOrEqual(2);
  });

  it('has no opinion when it has no heading', () => {
    const m = new MagneticHeading();
    expect(m.yawRateToward(0, 90, 100)).toBeNull();
  });
});
