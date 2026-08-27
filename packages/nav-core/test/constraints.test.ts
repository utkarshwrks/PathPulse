import { describe, expect, it } from 'vitest';
import {
  applyNhc,
  ForwardBiasEstimator,
  AttitudeEstimator,
  clampSpeed,
  coastingDecay,
  DeadReckoningEngine,
  NavigationEngine,
  NavigationStateMachine,
  ZaruProcessor,
  ZuptProcessor,
  type SensorSample,
} from '../src/index.js';

const G = 9.80665;

/**
 * Every test in this file corresponds to a defect observed on a real phone.
 * The screenshots showed the marker crossing open ground at 25 km/h while the
 * handset was standing still, and DEAD RECKONING being announced under open
 * sky. These pin each of those causes.
 */

/** Deterministic pseudo-random shake, so a "moving" fixture is not suspiciously clean. */
function shake(i: number, amp = 0.8): [number, number, number] {
  const p = i * 0.4;
  return [amp * Math.sin(p), amp * Math.sin(p * 1.31), amp * Math.sin(p * 0.77)];
}

describe('AttitudeEstimator — yaw must not depend on how the phone is held', () => {
  it('reads yaw from the vertical axis when the phone lies flat', () => {
    const att = new AttitudeEstimator();
    // Flat on its back: up is device +Z.
    for (let i = 0; i < 200; i++) att.push(0, 0, G);
    expect(att.isSettled).toBe(true);
    // A 0.1 rad/s right-hand rotation about +Z is a LEFT turn by compass, so
    // the compass-sense yaw rate must be negative.
    expect(att.yawRate(0, 0, 0.1)).toBeCloseTo(-0.1, 3);
  });

  it('still reads yaw when the phone stands upright in a cradle', () => {
    const att = new AttitudeEstimator();
    // Upright: up is device +Y. Device Z now points at the horizon.
    for (let i = 0; i < 200; i++) att.push(0, G, 0);
    expect(att.isSettled).toBe(true);

    // ★ THE BUG ★ The old code integrated gz directly. Here gz is rotation
    // about a HORIZONTAL axis — it is roll, not yaw — and treating it as
    // heading is what sent the marker off across open ground.
    expect(att.yawRate(0, 0, 0.1)).toBeCloseTo(0, 3);
    // The real yaw is now on the gy axis, and it is found without being told
    // anything about the mounting.
    expect(att.yawRate(0, 0.1, 0)).toBeCloseTo(-0.1, 3);
  });

  it('gives the same yaw rate for the same physical turn in any orientation', () => {
    const flat = new AttitudeEstimator();
    for (let i = 0; i < 200; i++) flat.push(0, 0, G);
    const upright = new AttitudeEstimator();
    for (let i = 0; i < 200; i++) upright.push(0, G, 0);

    // The same physical left turn, expressed about whichever device axis
    // happens to be vertical in each mounting.
    expect(flat.yawRate(0, 0, 0.2)).toBeCloseTo(upright.yawRate(0, 0.2, 0), 3);
  });

  it('removes gravity along the measured vertical, keeping sustained acceleration', () => {
    const att = new AttitudeEstimator();
    for (let i = 0; i < 200; i++) att.push(0, 0, G);
    // Level, plus 2 m/s^2 along device +Y.
    const linear = att.removeGravity(0, 2, G);
    expect(linear[2]).toBeCloseTo(0, 2);
    expect(linear[1]).toBeCloseTo(2, 2);
    // A low-pass gravity estimator would have absorbed that sustained 2 m/s^2.
    const h = att.toHorizontal(linear as [number, number, number]);
    expect(Math.abs(h.forward)).toBeCloseTo(2, 1);
  });
});

describe('ZARU — a stopped vehicle calibrates the gyroscope for free', () => {
  it('converges on an injected bias', () => {
    const zaru = new ZaruProcessor();
    const bias = [0.008, -0.003, 0.011];
    for (let i = 0; i < 300; i++) zaru.push(bias[0]!, bias[1]!, bias[2]!, true);
    expect(zaru.hasEstimate).toBe(true);
    expect(zaru.gyroBias[2]).toBeCloseTo(0.011, 3);
  });

  it('refuses an implausibly large "bias" — that is a misdetected turn', () => {
    const zaru = new ZaruProcessor();
    for (let i = 0; i < 300; i++) zaru.push(0, 0, 1.5, true);
    // Learning 1.5 rad/s as bias would corrupt every heading from then on, and
    // nothing on screen would reveal it.
    expect(zaru.hasEstimate).toBe(false);
    expect(zaru.gyroBias[2]).toBe(0);
  });

  it('discards a partial window when motion resumes', () => {
    const zaru = new ZaruProcessor();
    for (let i = 0; i < 30; i++) zaru.push(0.01, 0, 0.01, true);
    zaru.push(0.5, 0, 0.5, false); // pulling away
    for (let i = 0; i < 30; i++) zaru.push(0.01, 0, 0.01, true);
    // Neither partial window reached the threshold, so nothing was learned
    // across the boundary between standing and moving.
    expect(zaru.hasEstimate).toBe(false);
  });
});

describe('ZUPT — a stopped vehicle calibrates the accelerometer for free', () => {
  it('estimates accelerometer bias against the measured vertical', () => {
    const zupt = new ZuptProcessor();
    const up = [0, 0, 1] as const;
    for (let i = 0; i < 300; i++) zupt.push(0.02, -0.01, G + 0.03, up, true);
    expect(zupt.hasEstimate).toBe(true);
    expect(zupt.accelBias[0]).toBeCloseTo(0.02, 2);
    expect(zupt.accelBias[2]).toBeCloseTo(0.03, 2);
  });

  it('counts one trigger per stop, not one per sample', () => {
    const zupt = new ZuptProcessor();
    const up = [0, 0, 1] as const;
    for (let i = 0; i < 200; i++) zupt.push(0, 0, G, up, true);
    zupt.push(0, 0, G, up, false);
    for (let i = 0; i < 200; i++) zupt.push(0, 0, G, up, true);
    expect(zupt.triggerCount).toBe(2);
  });
});

describe('NHC — a vehicle does not slide sideways', () => {
  it('removes lateral velocity while preserving forward velocity', () => {
    // Heading due east; 10 m/s forward (east) plus 3 m/s of spurious north.
    const r = applyNhc(10, 3, 90);
    expect(r.forwardSpeed).toBeCloseTo(10, 6);
    expect(r.vE).toBeCloseTo(10, 6);
    // 95% of the lateral component is gone, not 100% — real vehicles do slip.
    expect(Math.abs(r.vN)).toBeCloseTo(0.15, 2);
    // Heading east means the vehicle right side faces south, so a spurious
    // +north velocity is a negative lateral component. Magnitude is the point.
    expect(Math.abs(r.removedLateralMps)).toBeCloseTo(2.85, 2);
  });

  it('leaves a purely forward velocity untouched', () => {
    const r = applyNhc(0, 12, 0); // heading north, moving north
    expect(r.forwardSpeed).toBeCloseTo(12, 6);
    expect(r.vE).toBeCloseTo(0, 6);
    expect(r.vN).toBeCloseTo(12, 6);
  });

  it('actually changes the trajectory, so the ablation row means something', () => {
    const withNhc = new DeadReckoningEngine({ nhc: true, yawRatePreCorrected: true, zupt: false });
    const without = new DeadReckoningEngine({ nhc: false, yawRatePreCorrected: true, zupt: false });
    for (const dr of [withNhc, without]) {
      dr.resetTo({ t: 0, enu: { e: 0, n: 0 }, speedMps: 10, headingDeg: 0, accuracyM: 4 });
      // Drive north for 20 s with a persistent 0.5 m/s^2 lateral error.
      for (let i = 0; i < 1000; i++) {
        dr.propagate(0, 0, 20, undefined, { lateralAccelMps2: 0.5 });
      }
    }
    // Cross-track error is what puts the marker inside a building.
    expect(Math.abs(without.current.enu.e)).toBeGreaterThan(50);
    expect(Math.abs(withNhc.current.enu.e)).toBeLessThan(
      Math.abs(without.current.enu.e) / 5,
    );
  });
});

describe('speed plausibility and the coasting decay', () => {
  it('clamps to the road speed limit when one is known', () => {
    expect(clampSpeed(30, undefined, 13.9)).toBeCloseTo(13.9 * 1.3, 3);
    expect(clampSpeed(-5)).toBe(0);
    expect(clampSpeed(999)).toBe(40);
  });

  it('does not decay while integration is still trustworthy', () => {
    expect(coastingDecay(10_000, 20)).toBe(1);
  });

  it('decays once integration has outlived its trust window', () => {
    expect(coastingDecay(120_000, 20)).toBeLessThan(1);
  });
});

describe('ForwardBiasEstimator — learn the tilt error in the open, apply it in the tunnel', () => {
  /** Drive at a steady speed while the accelerometer under-reads by `offset`. */
  function steadyDrive(est: ForwardBiasEstimator, offset: number, seconds = 30) {
    for (let s = 1; s <= seconds; s++) {
      for (let i = 0; i < 50; i++) est.pushAccel(offset);
      est.pushGnssSpeed(s * 1000, 14); // constant speed => true accel is 0
    }
  }

  it('recovers a steady forward-acceleration error', () => {
    const est = new ForwardBiasEstimator();
    steadyDrive(est, -0.2);
    expect(est.hasEstimate).toBe(true);
    expect(est.estimateMps2).toBeCloseTo(-0.2, 2);
    // The correction is applied by ADDING it, so it must be the opposite sign.
    expect(est.correctionMps2).toBeCloseTo(0.2, 2);
  });

  it('bootstraps even when the very first error is large', () => {
    // ★ REGRESSION ★ The first version adopted the first observation whole and
    // then rejected it for exceeding the cap, leaving `initialised` false — so
    // the next observation was also adopted whole and also rejected. It never
    // learned anything, and reported a bias of zero, which is indistinguishable
    // from a perfectly calibrated sensor. Silent, permanent, and measured as
    // obs=0 across a whole drive.
    const est = new ForwardBiasEstimator();
    steadyDrive(est, -0.9);
    expect(est.hasEstimate).toBe(true);
    expect(est.observationCount).toBeGreaterThan(0);
    // Clamped to the physical bound rather than discarded.
    expect(est.estimateMps2).toBeCloseTo(-0.35, 2);
  });

  it('stays silent until it has learned something', () => {
    const est = new ForwardBiasEstimator();
    expect(est.correctionMps2).toBe(0);
    expect(est.hasEstimate).toBe(false);
  });

  it('ignores GNSS speed below the Doppler noise floor', () => {
    const est = new ForwardBiasEstimator();
    for (let s = 1; s <= 20; s++) {
      for (let i = 0; i < 50; i++) est.pushAccel(-0.2);
      est.pushGnssSpeed(s * 1000, 0.4); // crawling; speed is mostly noise
    }
    expect(est.hasEstimate).toBe(false);
  });

  it('discards a single wild observation instead of learning from it', () => {
    const est = new ForwardBiasEstimator();
    steadyDrive(est, -0.2);
    const before = est.estimateMps2;
    for (let i = 0; i < 50; i++) est.pushAccel(50); // a dropped phone
    est.pushGnssSpeed(31_000, 14);
    expect(est.estimateMps2).toBeCloseTo(before, 3);
  });
});

describe('the field bugs, pinned', () => {
  /** A phone lying still on a desk: tiny noise, no motion, no GNSS. */
  function stationaryPhone(durationS: number, startT = 0): SensorSample[] {
    const out: SensorSample[] = [];
    for (let i = 0; i * 20 <= durationS * 1000; i++) {
      // Sensor noise floor only — far below the stationarity thresholds.
      const n = 0.004 * Math.sin(i * 0.7);
      out.push({
        t: startT + i * 20,
        imu: { ax: n, ay: n * 0.6, az: G + n, gx: n * 0.01, gy: 0, gz: n * 0.01 },
      });
    }
    return out;
  }

  it('a stationary phone does not travel 4 km — the reported bug', () => {
    const engine = new NavigationEngine();

    // Ten seconds of real driving east at 14 m/s, so the engine has a fix,
    // a heading and a non-zero speed to carry into the outage.
    let t = 0;
    for (let i = 0; i < 500; i++, t += 20) {
      const s: SensorSample = { t, imu: imuMoving(i) };
      if (i % 50 === 0) {
        s.gnss = {
          lat: 28.6315,
          lon: 77.2167 + (14 * t) / 1000 / (111_320 * Math.cos((28.6315 * Math.PI) / 180)),
          accuracyM: 4,
          speedMps: 14,
          headingDeg: 90,
          satCount: 9,
        };
      }
      engine.update(s);
    }

    const beforeStop = engine.update({ t, imu: imuMoving(500) }).distanceTravelledM;

    // Now the vehicle stops and GNSS is gone. Three minutes of it.
    let last = engine.update(stationaryPhone(0.02, t + 20)[0]!);
    for (const s of stationaryPhone(180, t + 40)) last = engine.update(s);

    const phantom = last.distanceTravelledM - beforeStop;
    // Before the fix this accumulated roughly 4 km at a steady 25 km/h.
    expect(last.velocityMps).toBeLessThan(0.5);
    expect(phantom).toBeLessThan(150);
  });

  it('invents no motion before the first fix — the 144 km/h bug', () => {
    // ★ FIELD DEFECT ★ On a handset that took ~40 s to acquire, the badge read
    // ACQUIRING while the HUD showed 144 km/h and 551 m travelled. 144 km/h is
    // 40 m/s: exactly the plausibility ceiling, which is what a runaway
    // integration always saturates at. Dead reckoning was integrating hand
    // movement and gravity leakage with nothing to correct against.
    const engine = new NavigationEngine();

    // A minute of the phone being handled, with no GNSS at all.
    let last = engine.update({ t: 0, imu: imuMoving(0) });
    for (let i = 1; i < 3000; i++) {
      // Deliberately violent: being passed from hand to hand.
      const p = i * 0.05;
      last = engine.update({
        t: i * 20,
        imu: {
          ax: 3 * Math.sin(p),
          ay: 2.5 * Math.cos(p * 0.7),
          az: G + 2 * Math.sin(p * 1.3),
          gx: 0.4 * Math.sin(p),
          gy: 0.3 * Math.cos(p),
          gz: 0.5 * Math.sin(p * 0.9),
        },
      });
    }

    expect(last.mode).toBe('INITIALIZING');
    expect(last.velocityMps).toBe(0);
    expect(last.distanceTravelledM).toBe(0);
  });

  it('derives speed from consecutive fixes when the device reports none', () => {
    // The Geolocation API marks coords.speed nullable and many Android devices
    // return null — the field device did, leaving the engine with no speed
    // reference at all and the forward-bias estimator with zero observations.
    const engine = new NavigationEngine();
    const lat = 28.6315;
    const metresPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);

    let last = engine.update({ t: 0, imu: imuMoving(0) });
    for (let i = 1; i < 2000; i++) {
      const t = i * 20;
      const sample: SensorSample = { t, imu: imuMoving(i) };
      if (t % 2000 === 0) {
        sample.gnss = {
          lat,
          // 10 m/s due east, but NO speedMps and NO headingDeg reported.
          lon: 77.2167 + (10 * t) / 1000 / metresPerDegLon,
          accuracyM: 6,
          satCount: 9,
        };
      }
      last = engine.update(sample);
    }

    expect(last.mode).toBe('GNSS');
    expect(last.velocityMps).toBeGreaterThan(7);
    expect(last.velocityMps).toBeLessThan(13);
    // Heading derived from the displacement: due east is 90 degrees.
    expect(Math.abs(last.headingDeg - 90)).toBeLessThan(15);
  });

  it('does not claim DEAD RECKONING when a slow receiver is working fine', () => {
    // The field device delivered a fix every 5 s (0.20 Hz). Under the old
    // fixed 1.5 s timeout the machine dropped to dead reckoning 3.5 s after
    // every single fix, under open sky.
    const sm = new NavigationStateMachine();
    let t = 0;
    const fix = { hasFix: true, accuracyM: 6, satCount: 9 };
    const gap = { hasFix: false };
    // recoveryComplete is passed so the machine can settle back to GNSS; in the
    // app the RecoveryBlender supplies it. Here we only care about the timeout.

    for (let cycle = 0; cycle < 12; cycle++) {
      sm.update(t, fix);
      for (let ms = 100; ms < 5000; ms += 100) sm.update(t + ms, gap, true);
      t += 5000;
    }

    expect(sm.observedFixIntervalMs).toBeCloseTo(5000, -2);
    expect(sm.effectiveNoFixTimeoutMs).toBeGreaterThan(10_000);
    expect(sm.current).toBe('GNSS');
  });

  it('still detects a genuine outage on that same slow receiver', () => {
    const sm = new NavigationStateMachine();
    let t = 0;
    const fix = { hasFix: true, accuracyM: 6, satCount: 9 };
    const gap = { hasFix: false };
    // recoveryComplete is passed so the machine can settle back to GNSS; in the
    // app the RecoveryBlender supplies it. Here we only care about the timeout.
    for (let cycle = 0; cycle < 12; cycle++) {
      sm.update(t, fix);
      for (let ms = 100; ms < 5000; ms += 100) sm.update(t + ms, gap, true);
      t += 5000;
    }
    expect(sm.current).toBe('GNSS');

    // Now the tunnel: no fix at all.
    for (let ms = 0; ms < 40_000; ms += 100) sm.update(t + ms, gap, true);
    expect(sm.current).toBe('DEAD_RECKONING');
  });

  it('reproduces the original bug when the adaptive timeout is switched off', () => {
    // Keeping the old behaviour reachable makes this an ablation row rather
    // than an undocumented change, and lets the demo show the failure.
    const sm = new NavigationStateMachine({ adaptiveTimeout: false });
    let t = 0;
    const fix = { hasFix: true, accuracyM: 6, satCount: 9 };
    for (let cycle = 0; cycle < 6; cycle++) {
      sm.update(t, fix);
      for (let ms = 100; ms < 5000; ms += 100) sm.update(t + ms, { hasFix: false }, true);
      t += 5000;
    }
    expect(sm.current).toBe('DEAD_RECKONING');
  });
});

/** A moving vehicle: road vibration on every axis. */
function imuMoving(i: number) {
  const [sx, sy, sz] = shake(i);
  return { ax: sx, ay: sy, az: G + sz, gx: 0, gy: 0, gz: 0 };
}
