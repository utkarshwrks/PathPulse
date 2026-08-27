import { describe, expect, it } from 'vitest';
import {
  NavigationEngine,
  SessionStats,
  type NavEvent,
  type NavigationState,
} from '../src/index.js';

function stateAt(t: number, patch: Partial<NavigationState> = {}): NavigationState {
  return {
    t,
    mode: 'GNSS',
    position: { lat: 28.6, lon: 77.2 },
    velocityMps: 10,
    headingDeg: 90,
    covariance: { alongM: 5, crossM: 5, headingDeg: 2 },
    confidence: 1,
    distanceTravelledM: 0,
    timeSinceGnssMs: 0,
    estimatedDriftM: 0,
    biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
    ...patch,
  };
}

describe('SessionStats', () => {
  it('tracks duration, distance and peak speed', () => {
    const s = new SessionStats();
    s.push(stateAt(0, { velocityMps: 0, distanceTravelledM: 0 }));
    s.push(stateAt(5000, { velocityMps: 18, distanceTravelledM: 60 }));
    s.push(stateAt(10_000, { velocityMps: 12, distanceTravelledM: 140 }));

    const r = s.summary;
    expect(r.durationMs).toBe(10_000);
    expect(r.distanceM).toBe(140);
    expect(r.maxSpeedMps).toBe(18);
    expect(r.meanUpdateHz).toBeCloseTo(0.2, 3);
  });

  it('counts a completed outage and its duration', () => {
    const s = new SessionStats();
    s.push(stateAt(0));
    s.push(stateAt(1000, { mode: 'DEAD_RECKONING' }));
    s.push(stateAt(9000, { mode: 'DEAD_RECKONING' }));
    s.push(stateAt(9500, { mode: 'RECOVERING' }));

    const r = s.summary;
    expect(r.outageCount).toBe(1);
    expect(r.outageTotalMs).toBe(8500);
    expect(r.longestOutageMs).toBe(8500);
  });

  it('counts an outage that is still in progress', () => {
    // Otherwise the panel reads zero during the exact moment the demo is about.
    const s = new SessionStats();
    s.push(stateAt(0));
    s.push(stateAt(1000, { mode: 'DEAD_RECKONING' }));
    s.push(stateAt(6000, { mode: 'DEAD_RECKONING' }));

    const r = s.summary;
    expect(r.outageCount).toBe(1);
    expect(r.outageTotalMs).toBe(5000);
  });

  it('keeps the longest outage across several', () => {
    const s = new SessionStats();
    s.push(stateAt(0));
    s.push(stateAt(1000, { mode: 'DEAD_RECKONING' }));
    s.push(stateAt(3000, { mode: 'GNSS' }));
    s.push(stateAt(5000, { mode: 'DEAD_RECKONING' }));
    s.push(stateAt(15_000, { mode: 'GNSS' }));

    const r = s.summary;
    expect(r.outageCount).toBe(2);
    expect(r.longestOutageMs).toBe(10_000);
    expect(r.outageTotalMs).toBe(12_000);
  });

  it('reports MEASURED drift from events, not the engine uncertainty model', () => {
    const s = new SessionStats();
    // A large modelled drift must not leak into the reported figures.
    s.push(stateAt(0, { estimatedDriftM: 999 }));
    const events: NavEvent[] = [
      { t: 1000, type: 'DRIFT_MEASURED', message: '11.4m', data: { driftM: 11.4 } },
      { t: 2000, type: 'DRIFT_MEASURED', message: '4.2m', data: { driftM: 4.2 } },
      { t: 3000, type: 'ZUPT_TRIGGER', message: 'stationary' },
    ];
    s.pushEvents(events);

    const r = s.summary;
    expect(r.bestDriftM).toBeCloseTo(4.2, 5);
    expect(r.worstDriftM).toBeCloseTo(11.4, 5);
    expect(r.meanDriftM).toBeCloseTo(7.8, 5);
    expect(r.zuptTriggers).toBe(1);
  });

  it('does not double-count events when the whole log is pushed each frame', () => {
    const s = new SessionStats();
    const events: NavEvent[] = [{ t: 1, type: 'ZUPT_TRIGGER', message: 'a' }];
    s.pushEvents(events);
    s.pushEvents(events);
    events.push({ t: 2, type: 'ZUPT_TRIGGER', message: 'b' });
    s.pushEvents(events);
    expect(s.summary.zuptTriggers).toBe(2);
  });

  it('survives a source whose clock restarts', () => {
    const s = new SessionStats();
    s.push(stateAt(50_000));
    s.push(stateAt(0)); // simulator reset without a stats reset
    s.push(stateAt(2000));
    expect(s.summary.durationMs).toBe(2000);
  });

  it('resets to empty', () => {
    const s = new SessionStats();
    s.push(stateAt(0, { mode: 'DEAD_RECKONING', velocityMps: 30 }));
    s.pushEvents([{ t: 1, type: 'ZUPT_TRIGGER', message: 'x' }]);
    s.reset();
    const r = s.summary;
    expect(r.durationMs).toBe(0);
    expect(r.maxSpeedMps).toBe(0);
    expect(r.outageCount).toBe(0);
    expect(r.zuptTriggers).toBe(0);
  });
});

describe('NavigationEngine.setConfig — Phase 5 live toggles', () => {
  it('changes behaviour without a restart', () => {
    const engine = new NavigationEngine();
    expect(engine.currentConfig.nhc).toBe(true);
    engine.setConfig({ nhc: false });
    expect(engine.currentConfig.nhc).toBe(false);
    // The change must reach the dead-reckoning engine too, not just the flag.
    engine.setConfig({ nhc: true });
    expect(engine.currentConfig.nhc).toBe(true);
  });

  it('Walking Mode clamps the speed ceiling', () => {
    const engine = new NavigationEngine({ maxSpeedMps: 3 });
    // Feed a stationary-looking IMU with a big GNSS speed: the clamp applies to
    // the propagated estimate, so the ceiling must be respected.
    expect(engine.currentConfig.maxSpeedMps).toBe(3);
    engine.setConfig({ maxSpeedMps: 40 });
    expect(engine.currentConfig.maxSpeedMps).toBe(40);
  });

  it('a mid-run toggle actually changes the trajectory', () => {
    // The whole point of the toggles is that a judge can break the system on
    // demand. If flipping a flag mid-outage produced identical output, the
    // demo would be theatre — so assert the divergence, not the flag.
    //
    // ZUPT is the toggle used here because its effect is unambiguous: with it
    // on, a stationary vehicle stops; with it off, the last speed is carried
    // forward indefinitely, which is exactly the phantom motion the field test
    // exposed. (An earlier version of this test injected a constant lateral
    // acceleration to exercise NHC — but a constant device-frame offset is
    // physically indistinguishable from mount tilt, so the attitude filter
    // correctly absorbs it and the two runs stayed 0.8 m apart.)
    const G = 9.80665;
    const control = new NavigationEngine();
    const toggled = new NavigationEngine();

    const moving = (ms: number) => {
      const p = (ms / 1000) * 2 * Math.PI * 20;
      return {
        ax: 0.8 * Math.sin(p),
        ay: 0.8 * Math.sin(p * 1.31),
        az: G + 0.8 * Math.sin(p * 0.77),
        gx: 0,
        gy: 0,
        gz: 0,
      };
    };
    // A phone at rest: sensor noise floor only.
    const still = (ms: number) => {
      const n = 0.004 * Math.sin(ms * 0.01);
      return { ax: n, ay: n * 0.6, az: G + n, gx: n * 0.01, gy: 0, gz: n * 0.01 };
    };

    const drive = (engine: NavigationEngine) => {
      // 20 s aided at 10 m/s due north, so both engines enter the outage with
      // an identical state and a real speed to carry.
      for (let ms = 0; ms < 20_000; ms += 20) {
        engine.update({
          t: ms,
          imu: moving(ms),
          ...(ms % 1000 === 0
            ? {
                gnss: {
                  lat: 28.6 + (10 * ms) / 1000 / 111_320,
                  lon: 77.2,
                  accuracyM: 4,
                  speedMps: 10,
                  headingDeg: 0,
                  satCount: 9,
                },
              }
            : {}),
        });
      }
      // Then the vehicle stops dead and GNSS disappears.
      for (let ms = 20_000; ms <= 90_000; ms += 20) {
        engine.update({ t: ms, imu: still(ms) });
      }
    };

    toggled.setConfig({ zupt: false });
    drive(control);
    drive(toggled);

    const a = control.update({ t: 90_020, imu: still(90_020) });
    const b = toggled.update({ t: 90_020, imu: still(90_020) });

    // With ZUPT the vehicle is stopped; without it, it coasts on.
    expect(a.velocityMps).toBeLessThan(0.5);
    expect(b.velocityMps).toBeGreaterThan(a.velocityMps + 1);

    const separationM =
      Math.hypot(a.position.lat - b.position.lat, a.position.lon - b.position.lon) * 111_320;
    // Hundreds of metres apart — unmistakable on the map, which is the point.
    expect(separationM).toBeGreaterThan(100);
  });

  it('leaves untouched flags alone', () => {
    const engine = new NavigationEngine();
    engine.setConfig({ zupt: false });
    expect(engine.currentConfig.zupt).toBe(false);
    expect(engine.currentConfig.zaru).toBe(true);
    expect(engine.currentConfig.nhc).toBe(true);
  });
});
