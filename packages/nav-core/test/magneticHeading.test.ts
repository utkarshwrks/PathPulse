import { describe, expect, it } from 'vitest';
import { MagneticHeading, NavigationEngine, type SensorSample } from '../src/index.js';

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

  /**
   * ★ THE SHAPE OF THE PULL, WHICH IS WHAT WAS WRONG ★
   *
   * Without a time constant the rate asked for is `error / dt`, so at 125 Hz a
   * 2 deg residual and a 90 deg blunder both ask for tens of rad/s and both
   * come out of the engine's clamp at exactly the ceiling. That is a bang-bang
   * controller wearing a proportional one's clothes, and it is why the aid had
   * to be detuned to 1 deg/s to avoid fighting corners — which then left it too
   * weak to correct anything.
   */
  const learned = (targetDeg: number) => {
    const m = new MagneticHeading();
    for (let i = 0; i < 8; i++) {
      const { mag, up } = reading(0);
      m.push(mag, up);
      m.observeCourse(i * 1000, 0);
    }
    const { mag, up } = reading(targetDeg);
    m.push(mag, up);
    return m;
  };

  it('★ with a time constant the pull is proportional to the error', () => {
    const small = learned(10).yawRateToward(9000, 0, 8, 5000)!;
    const large = learned(60).yawRateToward(9000, 0, 8, 5000)!;
    // Six times the error, six times the correction — within the slop of the
    // levelling arithmetic. Neither is at a ceiling.
    expect(large / small).toBeGreaterThan(4);
    expect(large / small).toBeLessThan(8);
    // 10° over 5 s is 2°/s = 0.035 rad/s, and nowhere near maxSlewRadPerSec.
    expect(small).toBeGreaterThan(0.02);
    expect(small).toBeLessThan(0.06);
  });

  it('★ without one, a small error and a large one ask for the same thing', () => {
    // The old behaviour, kept reachable by tauMs = 0 so the regression is
    // demonstrable rather than asserted. Both saturate maxSlewRadPerSec.
    const small = learned(10).yawRateToward(9000, 0, 8, 0)!;
    const large = learned(60).yawRateToward(9000, 0, 8, 0)!;
    expect(small).toBeCloseTo(large, 6);
  });

  it('★ a stale offset is still refused, just later', () => {
    // The library default is 180 s — a pedestrian's grip. A handlebar mount is
    // a bolt, and the engine raises this; but the limit itself must still bite.
    const m = new MagneticHeading({ offsetMaxAgeMs: 900_000 });
    for (let i = 0; i < 8; i++) {
      const { mag, up } = reading(0);
      m.push(mag, up);
      m.observeCourse(i * 1000, 0);
    }
    const { mag, up } = reading(30);
    m.push(mag, up);
    expect(m.headingDeg(180_000)).not.toBeNull();   // survives a 180 s tunnel
    expect(m.headingDeg(1_000_000)).toBeNull();     // does not survive forever
  });
});

/**
 * ★ THE COMPASS TRIMS THE GYRO, IN A VEHICLE ★
 *
 * Second Tier F ride, a 171 s outage entered at 39.5 km/h on a main road:
 *
 *   179° → 138 → 141 → 104 → 107 → 68 → 79 → 63 → 44 → 73 → 85 → 89
 *
 * The vehicle was speeding up along a road and the heading swung through 135
 * degrees. `leanDeg` reads 0 throughout, so §24.11's compensation is not the
 * cause. What it is, is a phone on the HANDLEBARS: steering input is not
 * vehicle yaw, and on a two-wheeler the bars move constantly to balance.
 *
 * `pedestrianHeadingFromMagnetometer` REPLACES the gyro on foot. In a vehicle
 * the gyro is the better instrument over seconds and the worse one over
 * minutes, so the composition is the other way round — the gyro supplies the
 * rate and the compass trims it, slowly.
 */
describe('the vehicle heading aid', () => {
  const ORIGIN = { lat: 23.16, lon: 79.93 };

  /**
   * Drive north with GNSS, then lose it while the gyro reports a slow, false
   * yaw — the handlebar wander this exists to answer.
   */
  function ride(aidDegPerSec: number) {
    const e = new NavigationEngine({ vehicleHeadingAidDegPerSec: aidDegPerSec });
    let t = 0;
    const mag = (h: number) => {
      // A field pointing north, rotated into the device frame for heading h.
      const r = (h * Math.PI) / 180;
      return { mx: 30 * Math.cos(r), my: -30 * Math.sin(r), mz: -20 };
    };
    // ★ THE FIXTURE HAS TO VIBRATE ★ A perfectly clean az reads as stationary,
    // ZARU then learns the false yaw as a bias and removes it, and the drift
    // this test is about never happens. Road vibration is what tells the two
    // apart — see the note on `sample` in ml.test.ts.
    const road = (p: number) => ({
      ax: 0.35 * Math.sin(p * 7.1),
      ay: 0.25 * Math.sin(p * 11.3),
      az: 9.80665 + 0.4 * Math.sin(p * 13.7),
    });
    for (; t < 60_000; t += 20) {
      const s: SensorSample = {
        t,
        imu: { ...road(t / 1000), gx: 0, gy: 0, gz: 0 },
        mag: mag(0),
      };
      if (t % 1000 === 0) {
        s.gnss = {
          lat: ORIGIN.lat + (t / 1000) * 1e-4,
          lon: ORIGIN.lon,
          accuracyM: 4,
          speedMps: 11,
          headingDeg: 0,
        };
      }
      e.update(s);
    }
    // Outage: the gyro reports a steady false yaw, the compass keeps saying north.
    let heading = 0;
    for (; t < 160_000; t += 20) {
      heading = e.update({
        t,
        imu: { ...road(t / 1000), gx: 0, gy: 0, gz: 0.012 },
        mag: mag(0),
      }).headingDeg;
    }
    return ((heading + 540) % 360) - 180;
  }

  it('★ a false yaw walks the heading away when nothing trims it', () => {
    // 0.012 rad/s for 100 s is about 69 degrees of pure invention.
    expect(Math.abs(ride(0))).toBeGreaterThan(30);
  });

  it('★ and the compass pulls it back', () => {
    expect(Math.abs(ride(1))).toBeLessThan(Math.abs(ride(0)));
  });

  it('is bounded, so it cannot fight a real corner', () => {
    // At 1 deg/s a 90-degree turn taken over three seconds loses 3 degrees to
    // the trim. The wander it repairs took a minute to accumulate.
    const e = new NavigationEngine({ vehicleHeadingAidDegPerSec: 1 });
    expect(e.currentConfig.vehicleHeadingAidDegPerSec).toBe(1);
  });

  it('does nothing without a magnetometer', () => {
    // Every IO-VNBD log has none, so this must be inert on them rather than
    // steering toward a bearing that was never measured.
    const e = new NavigationEngine({ vehicleHeadingAidDegPerSec: 4 });
    let t = 0;
    let heading = 0;
    for (; t < 20_000; t += 20) {
      const s: SensorSample = { t, imu: { ax: 0, ay: 0, az: 9.80665, gx: 0, gy: 0, gz: 0 } };
      if (t % 1000 === 0) {
        s.gnss = { lat: ORIGIN.lat, lon: ORIGIN.lon, accuracyM: 4, speedMps: 11, headingDeg: 0 };
      }
      heading = e.update(s).headingDeg;
    }
    expect(Number.isFinite(heading)).toBe(true);
  });
});
