import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import { useNavigationEngine } from './useNavigationEngine';

const G = 9.80665;
const START = { lat: 28.6315, lon: 77.2167 };

/** A moving vehicle: road vibration on every axis, so ZUPT does not fire. */
function moving(tMs: number): SensorSample['imu'] {
  const p = (tMs / 1000) * 2 * Math.PI * 20;
  return {
    ax: 0.8 * Math.sin(p),
    ay: 0.8 * Math.sin(p * 1.31),
    az: G + 0.8 * Math.sin(p * 0.77),
    gx: 0,
    gy: 0,
    gz: 0,
  };
}

function sample(tMs: number, withGnss: boolean): SensorSample {
  const s: SensorSample = { t: tMs, imu: moving(tMs) };
  if (withGnss) {
    s.gnss = {
      lat: START.lat,
      lon: START.lon + (14 * tMs) / 1000 / (111_320 * Math.cos((START.lat * Math.PI) / 180)),
      accuracyM: 4,
      speedMps: 14,
      headingDeg: 90,
      satCount: 9,
    };
  }
  return s;
}

/** Feed a stretch of drive through the hook's `feed`. */
function feedDrive(
  result: { current: ReturnType<typeof useNavigationEngine> },
  fromMs: number,
  toMs: number,
  gnss = true,
) {
  act(() => {
    for (let t = fromMs; t < toMs; t += 20) {
      result.current.feed(sample(t, gnss && t % 1000 === 0));
    }
  });
}

describe('useNavigationEngine', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useNavigationEngine());
    expect(result.current.state).toBeNull();
    expect(result.current.events).toEqual([]);
    expect(result.current.lastSample).toBeNull();
    expect(result.current.stats.durationMs).toBe(0);
    expect(result.current.diagnostics.attitudeSettled).toBe(false);
  });

  it('emits state once samples arrive', () => {
    const { result } = renderHook(() => useNavigationEngine());
    feedDrive(result, 0, 10_000);
    expect(result.current.state).not.toBeNull();
    expect(result.current.state!.mode).toBe('GNSS');
    expect(result.current.lastSample).not.toBeNull();
  });

  it('throttles UI updates to ~10 Hz while consuming every sample', () => {
    // React cannot usefully re-render at 50 Hz, but the engine must still see
    // every sample — dropping them would change the estimate, not just the
    // frame rate.
    const { result } = renderHook(() => useNavigationEngine());
    feedDrive(result, 0, 10_000);
    // 10 s of engine time at 100 ms emit spacing.
    expect(result.current.stats.durationMs).toBeGreaterThanOrEqual(9_000);
    // The engine consumed 50 Hz, so its own mean rate is far above the UI rate.
    expect(result.current.stats.meanUpdateHz).toBeGreaterThan(30);
  });

  it('exposes diagnostics for the debug panel', () => {
    const { result } = renderHook(() => useNavigationEngine());
    feedDrive(result, 0, 20_000);
    const d = result.current.diagnostics;
    expect(d.attitudeSettled).toBe(true);
    expect(d.accelBias).toHaveLength(3);
    expect(d.gyroBias).toHaveLength(3);
    expect(Number.isFinite(d.accelVariance)).toBe(true);
    expect(d.effectiveNoFixTimeoutMs).toBeGreaterThan(0);
  });

  it('accumulates session stats across an outage', () => {
    const { result } = renderHook(() => useNavigationEngine());
    feedDrive(result, 0, 20_000);
    feedDrive(result, 20_000, 60_000, false); // GNSS gone
    feedDrive(result, 60_000, 80_000);

    const s = result.current.stats;
    expect(s.outageCount).toBeGreaterThanOrEqual(1);
    expect(s.outageTotalMs).toBeGreaterThan(10_000);
    expect(s.maxSpeedMps).toBeGreaterThan(5);
    expect(s.distanceM).toBeGreaterThan(100);
  });

  it('records events and exports them as JSON', () => {
    const { result } = renderHook(() => useNavigationEngine());
    feedDrive(result, 0, 20_000);
    feedDrive(result, 20_000, 50_000, false);
    feedDrive(result, 50_000, 70_000);

    expect(result.current.events.length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.current.exportEventsJson());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(result.current.events.length);
    expect(parsed[0]).toHaveProperty('type');
    expect(parsed[0]).toHaveProperty('t');
  });

  describe('controls', () => {
    it('defaults to the configuration the ablation actually favours', () => {
      const { result } = renderHook(() => useNavigationEngine());
      const c = result.current.controls;
      expect(c.nhc).toBe(true);
      expect(c.zupt).toBe(true);
      expect(c.zaru).toBe(true);
      // Off on purpose: the ablation shows it degrades drift now that the
      // acceleration high-pass exists.
      expect(c.forwardBias).toBe(false);
      expect(c.accelHighPass).toBe(true);
      expect(c.walkingMode).toBe(false);
    });

    it('patches one flag without disturbing the others', () => {
      const { result } = renderHook(() => useNavigationEngine());
      act(() => result.current.setControls({ nhc: false }));
      expect(result.current.controls.nhc).toBe(false);
      expect(result.current.controls.zupt).toBe(true);
      expect(result.current.controls.zaru).toBe(true);
    });

    it('takes effect mid-run rather than needing a restart', () => {
      // ★ The claim the whole CONSTRAINTS tab rests on. ★ A judge switching
      // ZUPT off during an outage must see the estimate change immediately.
      const control = renderHook(() => useNavigationEngine());
      const toggled = renderHook(() => useNavigationEngine());

      for (const r of [control.result, toggled.result]) feedDrive(r, 0, 20_000);
      act(() => toggled.result.current.setControls({ zupt: false }));

      // Now stand still with no GNSS. With ZUPT the vehicle stops; without it
      // the last speed is carried forward.
      const still = (t: number): SensorSample => {
        const n = 0.004 * Math.sin(t * 0.01);
        return {
          t,
          imu: { ax: n, ay: n * 0.6, az: G + n, gx: n * 0.01, gy: 0, gz: n * 0.01 },
        };
      };
      for (const r of [control.result, toggled.result]) {
        act(() => {
          for (let t = 20_000; t < 90_000; t += 20) r.current.feed(still(t));
        });
      }

      expect(control.result.current.state!.velocityMps).toBeLessThan(0.5);
      expect(toggled.result.current.state!.velocityMps).toBeGreaterThan(
        control.result.current.state!.velocityMps + 1,
      );
    });

    it('walking mode clamps speed to a walking pace', () => {
      const { result } = renderHook(() => useNavigationEngine());
      act(() => result.current.setControls({ walkingMode: true }));
      expect(result.current.controls.walkingMode).toBe(true);

      // Feed a vehicle-speed GNSS fix; the estimate must not exceed 3 m/s.
      feedDrive(result, 0, 20_000);
      expect(result.current.state!.velocityMps).toBeLessThanOrEqual(3.0001);
    });

    it('returns to the vehicle ceiling when walking mode is switched off', () => {
      const { result } = renderHook(() => useNavigationEngine());
      act(() => result.current.setControls({ walkingMode: true }));
      feedDrive(result, 0, 10_000);
      act(() => result.current.setControls({ walkingMode: false }));
      feedDrive(result, 10_000, 30_000);
      expect(result.current.state!.velocityMps).toBeGreaterThan(5);
    });
  });

  it('reset clears state, events and stats', () => {
    const { result } = renderHook(() => useNavigationEngine());
    feedDrive(result, 0, 20_000);
    expect(result.current.state).not.toBeNull();

    act(() => result.current.reset());

    expect(result.current.state).toBeNull();
    expect(result.current.events).toEqual([]);
    expect(result.current.lastSample).toBeNull();
    expect(result.current.stats.durationMs).toBe(0);
    expect(result.current.stats.outageCount).toBe(0);
    expect(result.current.diagnostics.zuptTriggers).toBe(0);
    expect(result.current.updateHz).toBe(0);
  });

  it('keeps controls through a reset — a reset is not a settings wipe', () => {
    const { result } = renderHook(() => useNavigationEngine());
    act(() => result.current.setControls({ nhc: false, walkingMode: true }));
    act(() => result.current.reset());
    expect(result.current.controls.nhc).toBe(false);
    expect(result.current.controls.walkingMode).toBe(true);
  });

  it('survives a hostile sample without throwing', () => {
    const { result } = renderHook(() => useNavigationEngine());
    feedDrive(result, 0, 10_000);
    act(() => {
      result.current.feed({
        t: 10_020,
        imu: { ax: NaN, ay: Infinity, az: NaN, gx: NaN, gy: 0, gz: NaN },
      });
    });
    expect(Number.isFinite(result.current.state!.position.lat)).toBe(true);
    expect(Number.isFinite(result.current.state!.velocityMps)).toBe(true);
  });
});
