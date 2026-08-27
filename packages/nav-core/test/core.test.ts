import { describe, expect, it } from 'vitest';
import {
  AttitudeEstimator,
  SimpleAlignment,
  EventLog,
  RecoveryBlender,
  angleDiffDeg,
  applyNhc,
  enuToLatLon,
  latLonToEnu,
  lateralConsistency,
  normalizeAngle360,
  normalizeRadians,
  normaliseDeg,
} from '../src/index.js';

const G = 9.80665;

describe('AttitudeEstimator — the rotation-vector path', () => {
  it('takes the vertical straight from an identity quaternion', () => {
    // A device reporting no rotation is level: world up is device +Z.
    const att = new AttitudeEstimator();
    att.pushQuaternion([1, 0, 0, 0]);
    expect(att.isSettled).toBe(true);
    expect(att.upVector[0]).toBeCloseTo(0, 6);
    expect(att.upVector[1]).toBeCloseTo(0, 6);
    expect(att.upVector[2]).toBeCloseTo(1, 6);
  });

  it('settles immediately, skipping the accelerometer ramp', () => {
    // The rotation vector fuses gyro, accelerometer and magnetometer on the
    // device, so it is strictly better than anything we can derive here — and
    // it is available on the first sample rather than after half a second.
    const att = new AttitudeEstimator();
    expect(att.isSettled).toBe(false);
    att.pushQuaternion([1, 0, 0, 0]);
    expect(att.isSettled).toBe(true);
    expect(att.quality).toBe(1);
  });

  it('reads yaw about the vertical the quaternion implies', () => {
    const att = new AttitudeEstimator();
    // 90 degrees about device X: world up moves onto device -Y... or +Y,
    // depending on sense. Either way yaw must come off the Y axis, not Z.
    const s = Math.SQRT1_2;
    att.pushQuaternion([s, s, 0, 0]);
    expect(Math.abs(att.upVector[1])).toBeCloseTo(1, 5);
    expect(Math.abs(att.yawRate(0, 0.2, 0))).toBeCloseTo(0.2, 5);
    expect(att.yawRate(0, 0, 0.2)).toBeCloseTo(0, 5);
  });

  it('ignores a non-finite or degenerate quaternion', () => {
    const att = new AttitudeEstimator();
    att.pushQuaternion([Number.NaN, 0, 0, 0]);
    expect(att.isSettled).toBe(false);
    att.pushQuaternion([0, 0, 0, 0]);
    expect(att.isSettled).toBe(false);
  });

  it('can be seeded directly from a known orientation', () => {
    const att = new AttitudeEstimator();
    att.seed(0, G, 0);
    expect(att.isSettled).toBe(true);
    expect(att.upVector[1]).toBeCloseTo(1, 6);
  });

  it('refuses to seed from free fall', () => {
    const att = new AttitudeEstimator();
    att.seed(0, 0, 0);
    expect(att.isSettled).toBe(false);
  });
});

describe('lateralConsistency — does the turn rate explain the sideways force?', () => {
  it('is fully confident when they agree', () => {
    // A steady turn has a_lateral = v * yawRate. 10 m/s at 0.2 rad/s is 2 m/s^2.
    expect(lateralConsistency(2, 10, 0.2)).toBeCloseTo(1, 6);
  });

  it('collapses when the accelerometer sees a force the gyro cannot explain', () => {
    // Not cornering — a phone that has shifted in its mount, or an alignment
    // offset that is simply wrong. Either way the forward/lateral split is
    // untrustworthy and the accelerometer-derived speed should be de-weighted.
    expect(lateralConsistency(4, 10, 0)).toBe(0);
  });

  it('degrades smoothly rather than switching', () => {
    const good = lateralConsistency(2, 10, 0.2);
    const slight = lateralConsistency(2.5, 10, 0.2);
    const bad = lateralConsistency(3.5, 10, 0.2);
    expect(good).toBeGreaterThan(slight);
    expect(slight).toBeGreaterThan(bad);
    expect(bad).toBeGreaterThanOrEqual(0);
  });

  it('returns zero confidence for non-finite input', () => {
    expect(lateralConsistency(Number.NaN, 10, 0.2)).toBe(0);
    expect(lateralConsistency(2, 10, Number.NaN)).toBe(0);
  });

  it('is stationary-safe: at rest any lateral force is unexplained', () => {
    expect(lateralConsistency(0, 0, 0)).toBeCloseTo(1, 6);
    expect(lateralConsistency(3, 0, 0)).toBe(0);
  });
});

describe('applyNhc — degenerate input', () => {
  it('returns a zero velocity for non-finite input rather than propagating NaN', () => {
    expect(applyNhc(Number.NaN, 1, 0)).toEqual({
      vE: 0,
      vN: 0,
      forwardSpeed: 0,
      removedLateralMps: 0,
    });
    expect(applyNhc(1, 1, Number.NaN).forwardSpeed).toBe(0);
  });

  it('leaves a stationary vehicle stationary', () => {
    const r = applyNhc(0, 0, 137);
    expect(r.vE).toBeCloseTo(0, 9);
    expect(r.vN).toBeCloseTo(0, 9);
  });

  it('handles reversing without inventing lateral motion', () => {
    // Heading north, velocity south: forward speed is negative, and NHC must
    // not turn that into a sideways slide.
    const r = applyNhc(0, -8, 0);
    expect(r.forwardSpeed).toBeCloseTo(-8, 6);
    expect(r.vE).toBeCloseTo(0, 6);
  });
});

describe('EventLog', () => {
  it('returns the most recent n entries', () => {
    const log = new EventLog();
    for (let i = 0; i < 10; i++) log.push({ t: i, type: 'GNSS_FIX', message: `${i}` });
    expect(log.recent(3).map((e) => e.message)).toEqual(['7', '8', '9']);
  });

  it('asks for more than it holds without complaint', () => {
    const log = new EventLog();
    log.push({ t: 0, type: 'WARNING', message: 'x' });
    expect(log.recent(50)).toHaveLength(1);
  });

  it('caps itself so a long session cannot exhaust memory', () => {
    const log = new EventLog(5);
    for (let i = 0; i < 50; i++) log.push({ t: i, type: 'GNSS_FIX', message: `${i}` });
    expect(log.all).toHaveLength(5);
    // The OLDEST are dropped: during a demo the recent ones are what matter.
    expect(log.all[0]!.message).toBe('45');
  });

  it('exports valid JSON that round-trips', () => {
    const log = new EventLog();
    log.push({ t: 1, type: 'MODE_CHANGE', message: 'GNSS -> DR', from: 'GNSS', to: 'DEAD_RECKONING' });
    const parsed = JSON.parse(log.toJSON()) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe('MODE_CHANGE');
    expect(parsed[0]!.from).toBe('GNSS');
  });

  it('clears', () => {
    const log = new EventLog();
    log.push({ t: 0, type: 'WARNING', message: 'x' });
    log.clear();
    expect(log.all).toHaveLength(0);
    expect(JSON.parse(log.toJSON())).toEqual([]);
  });
});

describe('RecoveryBlender — lifecycle', () => {
  it('reports not-recovering before it has begun', () => {
    const b = new RecoveryBlender();
    expect(b.isActive).toBe(false);
    const r = b.update(0, { e: 5, n: 5 });
    expect(r.isRecovering).toBe(false);
    // With nothing to correct, the GNSS position passes straight through.
    expect(r.enu).toEqual({ e: 5, n: 5 });
  });

  it('cancel abandons a slew in progress', () => {
    const b = new RecoveryBlender();
    b.begin(0, { e: 30, n: 0 }, { e: 0, n: 0 });
    expect(b.isActive).toBe(true);
    b.cancel();
    expect(b.isActive).toBe(false);
    expect(b.update(100, { e: 0, n: 0 }).isRecovering).toBe(false);
  });

  it('reset clears the measured drift', () => {
    const b = new RecoveryBlender();
    b.begin(0, { e: 30, n: 40 }, { e: 0, n: 0 });
    expect(b.driftM).toBeCloseTo(50, 6);
    b.reset();
    expect(b.driftM).toBe(0);
    expect(b.isActive).toBe(false);
  });

  it('treats a zero drift as already recovered', () => {
    const b = new RecoveryBlender();
    expect(b.begin(0, { e: 0, n: 0 }, { e: 0, n: 0 })).toBeCloseTo(0, 9);
  });
});

describe('geo — angle and projection edges', () => {
  it('normalises angles into [0, 360)', () => {
    expect(normalizeAngle360(0)).toBe(0);
    expect(normalizeAngle360(360)).toBe(0);
    expect(normalizeAngle360(-90)).toBe(270);
    expect(normalizeAngle360(450)).toBe(90);
    expect(normalizeAngle360(-450)).toBe(270);
  });

  it('normalises radians into a single turn about zero', () => {
    // The contract is "same angle, within one turn of zero" — and +pi and -pi
    // are the same angle, so asserting a particular sign at the boundary would
    // be testing an implementation detail rather than the contract.
    expect(normalizeRadians(0)).toBeCloseTo(0, 9);
    for (const r of [0, 0.5, -0.5, 3 * Math.PI, -3 * Math.PI, 100, -100]) {
      const n = normalizeRadians(r);
      expect(Math.abs(n)).toBeLessThanOrEqual(Math.PI + 1e-9);
      // Same direction: the unit vectors must agree.
      expect(Math.sin(n)).toBeCloseTo(Math.sin(r), 9);
      expect(Math.cos(n)).toBeCloseTo(Math.cos(r), 9);
    }
  });

  it('takes the short way round when differencing angles', () => {
    expect(angleDiffDeg(10, 350)).toBeCloseTo(20, 9);
    expect(angleDiffDeg(350, 10)).toBeCloseTo(-20, 9);
    expect(angleDiffDeg(0, 0)).toBe(0);
    expect(Math.abs(angleDiffDeg(0, 180))).toBeCloseTo(180, 9);
  });

  it('normaliseDeg agrees with normalizeAngle360', () => {
    for (const d of [-720, -1, 0, 1, 359, 360, 720.5]) {
      expect(normaliseDeg(d)).toBeCloseTo(normalizeAngle360(d), 9);
    }
  });

  it('round-trips lat/lon through ENU', () => {
    const origin = { lat: 28.6315, lon: 77.2167 };
    for (const [e, n] of [
      [0, 0],
      [1500, -2200],
      [-800, 900],
    ] as const) {
      const ll = enuToLatLon(e, n, origin.lat, origin.lon);
      const back = latLonToEnu(ll.lat, ll.lon, origin.lat, origin.lon);
      expect(back.e).toBeCloseTo(e, 3);
      expect(back.n).toBeCloseTo(n, 3);
    }
  });

  it('projects the origin to exactly zero', () => {
    const p = latLonToEnu(28.6315, 77.2167, 28.6315, 77.2167);
    expect(p.e).toBeCloseTo(0, 9);
    expect(p.n).toBeCloseTo(0, 9);
  });

  it('works at the equator and at high latitude', () => {
    // The longitude scale factor collapses toward the poles; a projection that
    // hard-codes Delhi's would silently mis-scale everywhere else.
    for (const lat of [0, 45, 78]) {
      const p = latLonToEnu(lat, 10.01, lat, 10);
      const back = enuToLatLon(p.e, p.n, lat, 10);
      expect(back.lon).toBeCloseTo(10.01, 6);
      expect(p.e).toBeGreaterThan(0);
    }
  });
});


describe('SimpleAlignment — phone-to-vehicle yaw offset', () => {
  it('assumes the phone points along the bonnet until told otherwise', () => {
    // The default covers a flat dash mount with +Y forward, which is the demo
    // case. It must be a usable default, not a refusal to answer.
    const a = new SimpleAlignment();
    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.yawOffsetRad).toBe(0);
    const v = a.toVehicleFrame(0, 5);
    expect(v.forward).toBeCloseTo(5, 6);
    expect(v.lateral).toBeCloseTo(0, 6);
  });

  it('rotates a device-frame vector by the calibrated offset', () => {
    const a = new SimpleAlignment();
    a.startCalibration(0, 1000);
    // Straight-line acceleration along device +X means the phone is rotated
    // 90 degrees relative to the vehicle.
    for (let t = 0; t <= 1000; t += 20) a.push([2, 0, 0], t);
    expect(a.state.isCalibrated).toBe(true);
    expect(Math.abs(a.state.yawOffsetRad)).toBeCloseTo(Math.PI / 2, 2);

    // ★ REGRESSION ★ The rotation used to be inverted, so a phone mounted at
    // 90 degrees reported forward acceleration as BACKWARD — dead reckoning
    // would have driven the vehicle in reverse. Latent only because nothing
    // calls startCalibration yet.
    expect(a.toVehicleFrame(2, 0).forward).toBeCloseTo(2, 2);
    expect(a.toVehicleFrame(2, 0).lateral).toBeCloseTo(0, 2);
    // And what was device +Y is now the vehicle's left.
    expect(a.toVehicleFrame(0, 2).forward).toBeCloseTo(0, 2);
    expect(Math.abs(a.toVehicleFrame(0, 2).lateral)).toBeCloseTo(2, 2);
  });

  it('reports that it is calibrating, and stops when the window closes', () => {
    const a = new SimpleAlignment();
    expect(a.isCalibrating).toBe(false);
    a.startCalibration(0, 500);
    expect(a.isCalibrating).toBe(true);
    for (let t = 0; t <= 500; t += 20) a.push([1.5, 0, 0], t);
    expect(a.isCalibrating).toBe(false);
  });

  it('ignores samples with no directional content', () => {
    // Cruising at a constant speed carries no information about which way is
    // forward — only acceleration does. Averaging noise would produce a
    // confident and arbitrary offset.
    const a = new SimpleAlignment();
    a.startCalibration(0, 1000);
    for (let t = 0; t <= 1000; t += 20) a.push([0.01, 0.01, 0], t);
    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.yawOffsetRad).toBe(0);
  });

  it('refuses to calibrate from too few samples', () => {
    const a = new SimpleAlignment();
    a.startCalibration(0, 100);
    a.push([3, 0, 0], 20);
    a.push([3, 0, 0], 120);
    expect(a.state.isCalibrated).toBe(false);
  });

  it('ignores pushes when no calibration is running', () => {
    const a = new SimpleAlignment();
    for (let t = 0; t < 1000; t += 20) a.push([3, 0, 0], t);
    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.yawOffsetRad).toBe(0);
  });

  it('reports lower confidence before calibration than after', () => {
    const a = new SimpleAlignment();
    const before = a.state.quality;
    a.startCalibration(0, 1000);
    for (let t = 0; t <= 1000; t += 20) a.push([0, 2, 0], t);
    expect(a.state.quality).toBeGreaterThan(before);
  });

  it('resets to the default assumption', () => {
    const a = new SimpleAlignment();
    a.startCalibration(0, 1000);
    for (let t = 0; t <= 1000; t += 20) a.push([2, 0, 0], t);
    expect(a.state.isCalibrated).toBe(true);
    a.reset();
    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.yawOffsetRad).toBe(0);
    expect(a.isCalibrating).toBe(false);
  });
});
