/**
 * Phase 18B — two-wheelers.
 *
 * ★ THE CLAIM BEING TESTED ★
 *
 * A motorcycle leans until the resultant of gravity and centripetal
 * acceleration runs down its own vertical axis — that is what leaning IS. So a
 * phone strapped to it reads a specific force that never moves in its own
 * frame, the attitude estimator concludes the leaned axis is "down", and the
 * yaw rate it recovers by projecting the gyro onto that axis is the true rate
 * times cos(lean).
 *
 * The bike therefore turns MORE than the engine believes. Every test below
 * simulates that geometry exactly and asks whether the compensation recovers
 * the truth.
 */
import { describe, expect, it } from 'vitest';
import {
  VehicleTypeDetector,
  leanAngleRad,
  leanCompensatedYawRate,
  turnRadiusFromLeanM,
} from '../src/twowheeler/index.js';
import { GRAVITY_MPS2 as G } from '../src/alignment/gravity.js';
import type { Vec3 } from '../src/types.js';

const deg = (rad: number) => (rad * 180) / Math.PI;

/**
 * What a bike's gyro reads, given the truth.
 *
 * Steady turn: tan(lean) = v*w_true/g, and the gyro's component along the
 * leaned vertical is w_true*cos(lean).
 */
function bikeMeasurement(speedMps: number, trueYawRate: number) {
  const lean = Math.atan2(speedMps * trueYawRate, G);
  return { lean, measured: trueYawRate * Math.cos(lean) };
}

describe('the lean angle', () => {
  it('recovers the geometry it was derived from', () => {
    // The worked example from the module: 15 m/s, 0.30 rad/s.
    const { lean, measured } = bikeMeasurement(15, 0.3);
    expect(deg(lean)).toBeCloseTo(24.6, 1);
    expect(measured).toBeCloseTo(0.273, 3);
    // And from the measurement alone, with no knowledge of the true rate:
    expect(deg(leanAngleRad(15, measured))).toBeCloseTo(deg(lean), 3);
  });

  it('is zero when the vehicle is not turning', () => {
    expect(leanAngleRad(20, 0)).toBeCloseTo(0, 9);
  });

  it('is zero when the vehicle is not moving', () => {
    // A stationary bike held upright at a light is not leaning, whatever the
    // gyro does while the rider shifts their weight.
    expect(leanAngleRad(0, 0.4)).toBeCloseTo(0, 9);
  });

  it('leans the same way it turns', () => {
    expect(leanAngleRad(15, 0.3)).toBeGreaterThan(0);
    expect(leanAngleRad(15, -0.3)).toBeLessThan(0);
  });

  it('clamps rather than returning NaN past the physical limit', () => {
    // sin(lean) = v*w/g has no solution beyond g — that is a crash, not a
    // corner. It happens transiently from noise, and the honest answer is
    // "at the limit", not a NaN entering the heading integration.
    const extreme = leanAngleRad(60, 1.5);
    expect(Number.isFinite(extreme)).toBe(true);
    expect(Math.abs(deg(extreme))).toBeLessThan(90);
  });
});

describe('★ lean compensation', () => {
  it('recovers the true yaw rate a leaning bike hides', () => {
    for (const [v, w] of [
      [10, 0.2],
      [15, 0.3],
      [20, 0.25],
      [8, 0.45],
      [25, 0.15],
    ] as const) {
      const { measured } = bikeMeasurement(v, w);
      expect(leanCompensatedYawRate(v, measured)).toBeCloseTo(w, 3);
    }
  });

  it('★ the uncompensated rate is wrong by a margin that matters', () => {
    // This is the whole phase in one assertion. A 90-degree corner at 15 m/s
    // and 0.3 rad/s takes 5.2 seconds; integrating the measured rate over it
    // yields eight degrees less than the bike actually turned.
    const trueRate = 0.3;
    const { measured } = bikeMeasurement(15, trueRate);
    const seconds = (Math.PI / 2) / trueRate;
    const turnedTruly = deg(trueRate * seconds);
    const turnedBelieved = deg(measured * seconds);
    expect(turnedTruly).toBeCloseTo(90, 3);
    expect(turnedBelieved).toBeLessThan(83);
    // And eight degrees of heading error over a kilometre of tunnel is about
    // 140 m of cross-track error — from one roundabout.
    expect(1000 * Math.sin(((turnedTruly - turnedBelieved) * Math.PI) / 180)).toBeGreaterThan(100);
  });

  it('★ is NOT a no-op for a car, which is why it has to be gated', () => {
    // The comment in lean.ts originally claimed this WAS safe to leave on,
    // reasoning that with no lean cos(0) is 1. This test disproved it on the
    // first run, and the claim was wrong in an instructive way: the function
    // cannot tell whether the vehicle leaned. It INFERS a lean from speed and
    // yaw rate, and a car cornering briskly presents exactly the inputs a
    // leaning bike does.
    //
    // Gentle cornering is nearly harmless...
    expect(Math.abs(leanCompensatedYawRate(15, 0.05) - 0.05)).toBeLessThan(0.05 * 0.02);
    // ...and brisk cornering is not. Eighteen per cent of invented turn.
    const inflated = leanCompensatedYawRate(15, 0.35);
    expect(inflated / 0.35).toBeGreaterThan(1.15);

    // Hence VehicleTypeDetector, and hence its default. This is the assertion
    // that keeps somebody from "simplifying" the gate away later.
    expect(inflated).not.toBeCloseTo(0.35, 2);
  });

  it('does not amplify noise at a standstill', () => {
    expect(leanCompensatedYawRate(0, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('survives non-finite input', () => {
    expect(Number.isFinite(leanCompensatedYawRate(Number.NaN, 0.2))).toBe(true);
    expect(Number.isFinite(leanAngleRad(15, Number.NaN))).toBe(true);
  });
});

describe('turn radius from lean', () => {
  it('agrees with the corner it came from', () => {
    // v = 15, w = 0.3 gives r = v/w = 50 m.
    const { lean } = bikeMeasurement(15, 0.3);
    expect(turnRadiusFromLeanM(15, lean)).toBeCloseTo(50, 0);
  });

  it('is infinite going straight', () => {
    expect(turnRadiusFromLeanM(15, 0)).toBe(Infinity);
  });
});

describe('★ telling a bike from a car', () => {
  /**
   * The discriminator: during a turn, does the specific force MOVE in the
   * sensor's own frame?
   *
   *   car  — stays level, so the force swings sideways by the full tilt
   *   bike — rolls until the force runs down its own axis, so it does not move
   */
  function feed(
    detector: VehicleTypeDetector,
    kind: 'car' | 'bike',
    samples: number,
    speedMps = 15,
    trueYawRate = 0.3,
  ) {
    const up: Vec3 = [0, 0, 1];
    const { lean, measured } = bikeMeasurement(speedMps, trueYawRate);
    for (let i = 0; i < samples; i++) {
      // Same trajectory, same forces — only the sensor's orientation differs.
      const accel: Vec3 =
        kind === 'bike'
          ? // The bike rolled with the resultant: it is straight "down" in the
            // device frame, and only heavier.
            [0, 0, G / Math.cos(lean)]
          : // The car stayed level: the resultant swings sideways.
            [speedMps * trueYawRate, 0, G];
      detector.push(accel, up, speedMps, kind === 'bike' ? measured : trueYawRate);
    }
    return detector.state;
  }

  it('calls a leaning vehicle a two-wheeler', () => {
    const d = new VehicleTypeDetector();
    const state = feed(d, 'bike', 120);
    expect(state.type).toBe('TWO_WHEELER');
    expect(state.followRatio).toBeLessThan(0.35);
  });

  it('calls a level vehicle a car', () => {
    const d = new VehicleTypeDetector();
    const state = feed(d, 'car', 120);
    expect(state.type).toBe('CAR');
    expect(state.followRatio).toBeGreaterThan(0.65);
  });

  it('★ says nothing until it has seen enough cornering', () => {
    // Evidence only exists in turns. A verdict from three samples of a
    // motorway is a guess, and the compensation it would enable is applied to
    // every corner afterwards.
    const d = new VehicleTypeDetector();
    expect(feed(d, 'bike', 10).type).toBe('UNKNOWN');
  });

  it('ignores straight driving entirely', () => {
    const d = new VehicleTypeDetector();
    const up: Vec3 = [0, 0, 1];
    for (let i = 0; i < 500; i++) d.push([0, 0, G], up, 20, 0);
    expect(d.state.samples).toBe(0);
    expect(d.state.type).toBe('UNKNOWN');
  });

  it('ignores a stationary vehicle however much it is waggled', () => {
    // A rider paddling a scooter at a light produces gyro and accelerometer
    // activity that has nothing to do with cornering.
    const d = new VehicleTypeDetector();
    const up: Vec3 = [0, 0, 1];
    for (let i = 0; i < 500; i++) d.push([2, 1, G], up, 0.5, 0.8);
    expect(d.state.samples).toBe(0);
  });

  it('★ defaults to CAR behaviour when it is unsure', () => {
    // The asymmetry, asserted. A wrong bike verdict inflates every corner for
    // the rest of the drive; a wrong car verdict costs the compensation, which
    // is what every phase before this one did anyway.
    const d = new VehicleTypeDetector();
    const up: Vec3 = [0, 0, 1];
    const { lean } = bikeMeasurement(15, 0.3);
    // Halfway between the two behaviours — a genuinely ambiguous sensor.
    for (let i = 0; i < 200; i++) {
      d.push([(G * Math.tan(lean)) / 2, 0, G], up, 15, 0.3);
    }
    expect(d.state.type).toBe('UNKNOWN');
  });

  it('forgets everything on reset', () => {
    const d = new VehicleTypeDetector();
    feed(d, 'bike', 120);
    d.reset();
    expect(d.state.type).toBe('UNKNOWN');
    expect(d.state.samples).toBe(0);
  });
});

/**
 * ★ THE COUPLING THAT TURNED A SPEED BUG INTO A HEADING BUG ★
 *
 * Field report, a scooter: "it is about the correct prediction in dead
 * reckoning it goes anywhere ... it just do hit and trail."
 *
 * Lean is inferred from `sin(lean) = v * w / g`, which is LINEAR in v, and
 * during an outage v is an estimate rather than a measurement. The correction
 * then divides by cos(lean). So an over-read speed does not merely inflate
 * distance — it rewrites the heading, which is the one quantity an outage has
 * no other way to repair, and once the heading is past `maxHeadingMismatchDeg`
 * map matching stops matching and the marker is released to wander.
 */
describe('a lean inferred from a speed we may not believe', () => {
  /** The ride in the report: 30 km/h true, with the model reading 89 km/h. */
  const TRUE_MPS = 8.3;
  const OVERREAD_MPS = 24.7;
  /** An ordinary corner, smoothed — not a pothole. */
  const CORNER_RAD_S = 0.35;

  it('★ an over-read speed used to double the rate of every corner', () => {
    // Unbounded, which is what shipped: cos(61.8 deg) is 0.47.
    const NO_CAP = Math.PI / 2;
    const honest = leanCompensatedYawRate(TRUE_MPS, CORNER_RAD_S, NO_CAP);
    const inflated = leanCompensatedYawRate(OVERREAD_MPS, CORNER_RAD_S, NO_CAP);
    expect(honest / CORNER_RAD_S).toBeLessThan(1.1);
    expect(inflated / CORNER_RAD_S).toBeGreaterThan(2);
  });

  it('★ and the bound holds it to what a road rider can actually produce', () => {
    const inflated = leanCompensatedYawRate(OVERREAD_MPS, CORNER_RAD_S);
    // 1 / cos(40 deg) = 1.305, and nothing above it however wrong the speed is.
    expect(inflated / CORNER_RAD_S).toBeLessThanOrEqual(1.306);
  });

  it('costs a real lean nothing — every angle a rider uses is under the cap', () => {
    // A scooter in traffic at 40 km/h taking a brisk corner leans about 20 deg.
    for (const [v, w] of [
      [8.3, 0.15],
      [11.1, 0.25],
      [13.9, 0.3],
      [16.7, 0.2],
    ] as const) {
      expect(leanCompensatedYawRate(v, w)).toBeCloseTo(
        leanCompensatedYawRate(v, w, Math.PI / 2),
        9,
      );
    }
  });

  it('bounds the correction however absurd the inputs get', () => {
    for (const v of [0, 5, 25, 40, 100, 1000]) {
      for (const w of [0.05, 0.3, 0.6, 1.2, 3]) {
        const r = leanCompensatedYawRate(v, w) / w;
        expect(r).toBeGreaterThanOrEqual(0.999);
        expect(r).toBeLessThanOrEqual(1.306);
      }
    }
  });

  it('★ the whole 40-to-84 degree band used to pass through, and does not now', () => {
    // ★ A NUMERICAL GUARD IS NOT A PHYSICAL ONE ★ applyLeanCompensation refused
    // only once cos fell below 0.1 — 84 degrees — so everything between 40 and
    // 84 multiplied the yaw rate by 1.3 to 9.6. Nothing in that band is a lean.
    // 20 m/s puts sin(lean) = v*w/g across the whole band without saturating:
    // 0.32 rad/s is 41 degrees, 0.48 is 78.
    const RATES = [0.32, 0.36, 0.42, 0.48];
    const worst = Math.max(...RATES.map((w) => leanCompensatedYawRate(20, w, Math.PI / 2) / w));
    expect(worst).toBeGreaterThan(2.5);
    const bounded = Math.max(...RATES.map((w) => leanCompensatedYawRate(20, w) / w));
    expect(bounded).toBeLessThanOrEqual(1.306);
  });
});
