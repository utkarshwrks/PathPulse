import { describe, expect, it } from 'vitest';
import {
  NavigationEngine,
  haversineDistance,
  type SensorSample,
} from '../src/index.js';

/**
 * A walk round corners, through a GNSS outage.
 *
 * ★ THE FIELD REPORT THIS FILE IS ★
 *
 * "dead reckoning only works on straight road, just follow the blue line...
 * street and gali, this appears to just go straight."
 *
 * It was exactly true and the reason was one line. On foot the engine refuses
 * to integrate device yaw — correctly, see pedestrian.test.ts and the
 * star-shaped trail — and takes its bearing from the GNSS course instead. There
 * is no course during an outage, so the heading was frozen at whatever it last
 * was and the estimate walked a straight line through every corner. Below, that
 * is a heading stuck 90° or 180° from the truth and 172 m to 300 m of error on
 * a 410 m walk.
 *
 * See `MagneticHeading` for the answer and for why this project's standing
 * reason to ignore the magnetometer — "a vehicle is a steel box" — is a
 * statement about vehicles.
 *
 * ★ THE ONE NUMBER THIS FIXTURE IS GUESSING AT ★
 *
 * How far the phone itself turns in the hand. It is not measured anywhere in
 * this project, it decides the whole result, and inventing one value for it
 * would be inventing the answer — so the sweep below reports the curve instead,
 * and the assertions are made where a person navigating actually holds a phone.
 * Errors are metres from the carrier at the end of a 410 m walk:
 *
 *   grip wander   outage@40s      @60s       @90s      @150s
 *   ±18°   frozen   172.4       172.2      299.5      300.7
 *          compass   80.5        35.1       19.2        5.6
 *   ±55°   frozen   172.4       172.2      299.5      300.7
 *          compass   31.0       101.0       16.6       30.5
 *   ±109°  frozen   172.4       172.2      299.5      300.7
 *          compass  190.5       210.2       73.2      107.9
 *
 * The compass wins everywhere the handset is held with any steadiness, and
 * falls back to roughly the frozen result only at ±109°, which is not somebody
 * navigating — it is somebody idly turning the phone over and over. A real
 * recorded walk would pin this properly and none exists yet; that is stated
 * rather than papered over.
 */

const START = { lat: 23.1655, lon: 79.9312 };
const M_PER_DEG_LAT = 111_320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((START.lat * Math.PI) / 180);

/**
 * A walk through a street grid: straight, left, straight, right, straight.
 * The thing the field report says the engine cannot do.
 */
interface Leg {
  headingDeg: number;
  metres: number;
}

const ROUTE: Leg[] = [
  { headingDeg: 90, metres: 120 },
  { headingDeg: 0, metres: 90 },
  { headingDeg: 90, metres: 110 },
  { headingDeg: 180, metres: 80 },
];

const SPEED = 1.4;
const TURN_S = 2.5;

function makeCorneredWalk(opts: { outageStartS: number; fixIntervalS?: number; seed?: number; withMag?: boolean; grip?: number }) {
  const { outageStartS, fixIntervalS = 1, seed = 11, withMag = true, grip = 0.6 } = opts;
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };

  // Build the truth track: position and true course, sampled at 60 Hz.
  const dtMs = 1000 / 60;
  const dt = dtMs / 1000;
  const truth: Array<{ t: number; e: number; n: number; course: number }> = [];
  let e = 0;
  let n = 0;
  let course = ROUTE[0]!.headingDeg;
  let tMs = 0;
  for (let i = 0; i < ROUTE.length; i++) {
    const leg = ROUTE[i]!;
    // Turn onto the leg's heading over TURN_S, the way a person rounds a corner.
    if (i > 0) {
      const from = ROUTE[i - 1]!.headingDeg;
      let delta = leg.headingDeg - from;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      const steps = Math.round((TURN_S * 1000) / dtMs);
      for (let k = 0; k < steps; k++) {
        course = from + (delta * (k + 1)) / steps;
        const r = (course * Math.PI) / 180;
        e += SPEED * Math.sin(r) * dt;
        n += SPEED * Math.cos(r) * dt;
        truth.push({ t: tMs, e, n, course });
        tMs += dtMs;
      }
    }
    const steps = Math.round((leg.metres / SPEED / dt));
    for (let k = 0; k < steps; k++) {
      course = leg.headingDeg;
      const r = (course * Math.PI) / 180;
      e += SPEED * Math.sin(r) * dt;
      n += SPEED * Math.cos(r) * dt;
      truth.push({ t: tMs, e, n, course });
      tMs += dtMs;
    }
  }

  const samples: SensorSample[] = [];
  let nextFixMs = 0;
  let prevCourse = truth[0]!.course;
  let handYawIntegral = 0;

  for (let i = 0; i < truth.length; i++) {
    const p = truth[i]!;
    const tS = p.t / 1000;
    const step = 2 * Math.PI * 2 * tS;

    // Body yaw rate, rad/s, right-hand rule: a RIGHT turn (increasing compass
    // heading) is NEGATIVE about +z.
    let dc = p.course - prevCourse;
    while (dc > 180) dc -= 360;
    while (dc < -180) dc += 360;
    prevCourse = p.course;
    const bodyYawRate = -((dc * Math.PI) / 180) / dt;

    // The hand: arm swing plus a slow rotation of the phone in the grip, the
    // two terms that made integrating device yaw hopeless on foot.
    // ★ THE HAND AND THE SENSOR ERROR ARE DIFFERENT THINGS ★
    // Arm swing and the slow turn of the phone in the grip are REAL rotation:
    // the magnetometer sees them, because the phone really is pointing
    // somewhere else. The 0.012 rad/s is gyro BIAS — an error in the
    // instrument, which rotates nothing. Folding it into the device's true
    // orientation would model a handset spinning steadily in the hand, 137°
    // over a three-minute outage, and no hand does that.
    const handYawTrue =
      1.1 * Math.sin(step * 0.37 + 0.6) + grip * Math.sin(2 * Math.PI * 0.05 * tS);
    const GYRO_BIAS = 0.012;
    const handYaw = handYawTrue + GYRO_BIAS;
    handYawIntegral += handYawTrue * dt;

    // The device's yaw in the world: where the carrier is going, plus however
    // far the phone has turned in the hand. The magnetometer sees this, and
    // nothing else on the handset does.
    const deviceYawDeg = p.course - (handYawIntegral * 180) / Math.PI;

    const s: SensorSample = {
      t: Math.round(p.t),
      imu: {
        ax: 3.2 * Math.sin(step) + 0.05 * rand(),
        ay: 2.4 * Math.sin(step * 0.5 + 1) + 0.05 * rand(),
        az: 9.80665 + 4.1 * Math.sin(step) + 0.05 * rand(),
        gx: 0.9 * Math.sin(step * 0.5),
        gy: 0.7 * Math.sin(step * 0.33 + 2),
        gz: bodyYawRate + handYaw,
      },
    };

    if (withMag) {
      const F = 47;
      const inc = (42 * Math.PI) / 180;
      const hN = F * Math.cos(inc);
      const hD = F * Math.sin(inc);
      // Device flat, screen up, +y pointing along deviceYawDeg. North in the
      // device frame is that bearing rotated the other way.
      const yaw = (deviceYawDeg * Math.PI) / 180;
      s.mag = {
        mx: hN * -Math.sin(yaw),
        my: hN * Math.cos(yaw),
        mz: -hD,
      };
    }

    if (p.t >= nextFixMs) {
      nextFixMs += fixIntervalS * 1000;
      if (tS < outageStartS) {
        const noise = () => (rand() + rand() + rand()) * 2 * 5;
        s.gnss = {
          lat: START.lat + (p.n + noise()) / M_PER_DEG_LAT,
          lon: START.lon + (p.e + noise()) / mPerDegLon,
          accuracyM: 5,
          satCount: 11,
          speedMps: SPEED,
          headingDeg: p.course,
        };
      }
    }
    samples.push(s);
  }
  return { samples, truth };
}

/** Metres from the carrier at the end of the walk. */
function finalError(opts: { outageStartS: number; withMag: boolean; grip: number }): {
  errorM: number;
  headingDeg: number;
  truthCourse: number;
} {
  const { samples, truth } = makeCorneredWalk(opts);
  const engine = new NavigationEngine();
  let last = null as null | ReturnType<NavigationEngine['update']>;
  for (const s of samples) last = engine.update(s);
  const end = truth[truth.length - 1]!;
  return {
    errorM: haversineDistance(
      last!.position.lat,
      last!.position.lon,
      START.lat + end.n / M_PER_DEG_LAT,
      START.lon + end.e / mPerDegLon,
    ),
    headingDeg: last!.headingDeg,
    truthCourse: end.course,
  };
}

const OUTAGE_STARTS = [40, 60, 90, 150];

describe('★ a walk round corners, through an outage', () => {
  it('★ the frozen heading never turns — this is the field report', () => {
    for (const outageStartS of OUTAGE_STARTS) {
      const r = finalError({ outageStartS, withMag: false, grip: 0.1 });
      // Stuck on a leg bearing rather than anywhere near the final course.
      expect(Math.abs(r.headingDeg - r.truthCourse)).toBeGreaterThan(60);
      expect(r.errorM).toBeGreaterThan(150);
    }
  });

  it('★ the compass turns the corners, at a grip a person actually uses', () => {
    for (const outageStartS of OUTAGE_STARTS) {
      const frozen = finalError({ outageStartS, withMag: false, grip: 0.1 });
      const compass = finalError({ outageStartS, withMag: true, grip: 0.1 });
      expect(compass.errorM).toBeLessThan(frozen.errorM);
      // Every case in the table above is under 100 m against 172-300 m frozen.
      expect(compass.errorM).toBeLessThan(100);
    }
  });

  it('a phone turning ±55° in the hand is still far better than frozen', () => {
    for (const outageStartS of OUTAGE_STARTS) {
      const frozen = finalError({ outageStartS, withMag: false, grip: 0.3 });
      const compass = finalError({ outageStartS, withMag: true, grip: 0.3 });
      expect(compass.errorM).toBeLessThan(frozen.errorM);
    }
  });

  it('a handset with no magnetometer behaves exactly as it did', () => {
    // Every source but the Phase 15 native loop sends no `mag`, and replayed
    // logs recorded before it certainly do not. Those must be untouched.
    for (const outageStartS of OUTAGE_STARTS) {
      const a = finalError({ outageStartS, withMag: false, grip: 0.1 });
      const b = finalError({ outageStartS, withMag: false, grip: 0.1 });
      expect(a.errorM).toBeCloseTo(b.errorM, 6);
      expect(a.headingDeg).toBeCloseTo(b.headingDeg, 6);
    }
  });

  it.skip('the sweep the table above was read off', () => {
    console.log('grip amplitude -> how far the phone itself turns in the hand');
    for (const outageStartS of [40, 60, 90, 150]) {
     for (const grip of [0.1, 0.3, 0.6]) {
     for (const withMag of [false, true]) {
      const { samples, truth } = makeCorneredWalk({ outageStartS, withMag, grip });
      const engine = new NavigationEngine();
      let last = null as null | ReturnType<NavigationEngine['update']>;
      for (const s of samples) last = engine.update(s);
      const end = truth[truth.length - 1]!;
      const truthLat = START.lat + end.n / M_PER_DEG_LAT;
      const truthLon = START.lon + end.e / mPerDegLon;
      const err = haversineDistance(
        last!.position.lat,
        last!.position.lon,
        truthLat,
        truthLon,
      );
      const outageS = samples[samples.length - 1]!.t / 1000 - outageStartS;
      void outageS;
      console.log(
        `outage@${String(outageStartS).padStart(3)}s grip ±${(grip * 182).toFixed(0).padStart(3)}° ` +
          `${withMag ? 'WITH compass ' : 'frozen      '}: ` +
          `error ${err.toFixed(1).padStart(6)} m, heading ${last!.headingDeg.toFixed(0).padStart(4)}° ` +
          `(truth ${end.course.toFixed(0)}°)`,
      );
     }
     }
    }
  });
});
