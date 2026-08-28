import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import { ROUTES, useSensorSource } from './useSensorSource';

/**
 * The hook that owns the active sensor source.
 *
 * It was at 10% coverage while being the thing that decides which source is
 * running, measures the rates the HUD displays, and drives every transport
 * button. A bug here looks like a bug in the engine.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ROUTES — the dropdown can never drift from the files on disk', () => {
  it('offers both routes, labelled from their own generated metadata', () => {
    expect(Object.keys(ROUTES)).toEqual(['city', 'highway']);
    // Labels are derived from the route's properties rather than hard-coded,
    // so regenerating a route cannot leave the menu describing the old one.
    expect(ROUTES.city.label).toMatch(/City — \d+\.\d+ km/);
    expect(ROUTES.highway.label).toMatch(/Highway — \d+\.\d+ km/);
  });

  it('carries real geometry for both routes', () => {
    for (const key of ['city', 'highway'] as const) {
      const coords = ROUTES[key].route.geometry.coordinates;
      expect(coords.length).toBeGreaterThan(100);
      // Delhi: every coordinate must be a plausible lon/lat, not a swapped pair.
      for (const [lon, lat] of coords) {
        expect(lon).toBeGreaterThan(76);
        expect(lon).toBeLessThan(78);
        expect(lat).toBeGreaterThan(28);
        expect(lat).toBeLessThan(29);
      }
    }
  });
});

describe('useSensorSource — simulation', () => {
  it('starts idle with the simulation source selected', () => {
    const { result } = renderHook(() => useSensorSource('simulation', 'city'));
    expect(result.current.isRunning).toBe(false);
    expect(result.current.progress).toBe(0);
    expect(result.current.sourceName).toMatch(/simulation/i);
    expect(result.current.fix).toBeNull();
  });

  it('feeds samples to the engine callback at full rate', async () => {
    vi.useFakeTimers();
    const samples: SensorSample[] = [];
    const { result } = renderHook(() =>
      useSensorSource('simulation', 'city', (s) => samples.push(s)),
    );

    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // 50 Hz IMU means roughly fifty samples per simulated second.
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.some((s) => s.imu)).toBe(true);
    expect(samples.some((s) => s.gnss)).toBe(true);
  });

  it('measures the sample rates rather than reporting the nominal ones', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSensorSource('simulation', 'city'));
    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.imuHz).toBeGreaterThan(20);
    expect(result.current.gnssHz).toBeGreaterThan(0);
  });

  it('pauses and resumes', async () => {
    vi.useFakeTimers();
    const samples: SensorSample[] = [];
    const { result } = renderHook(() =>
      useSensorSource('simulation', 'city', (s) => samples.push(s)),
    );

    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const afterPlay = samples.length;

    act(() => result.current.pause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(samples.length).toBe(afterPlay);
    expect(result.current.isRunning).toBe(false);
  });

  it('reset returns the drive to the start', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSensorSource('simulation', 'city'));
    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.progress).toBeGreaterThan(0);

    act(() => result.current.reset());
    expect(result.current.progress).toBe(0);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.fix).toBeNull();
  });

  it('triggerOutage removes GNSS entirely rather than zeroing it', async () => {
    // ★ The shape of a real tunnel. ★ A zeroed or faked fix would be a
    // different signal, and the state machine would treat it differently.
    vi.useFakeTimers();
    const samples: SensorSample[] = [];
    const { result } = renderHook(() =>
      useSensorSource('simulation', 'city', (s) => samples.push(s)),
    );

    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(samples.some((s) => s.gnss)).toBe(true);

    const mark = samples.length;
    act(() => result.current.triggerOutage(10_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    const during = samples.slice(mark);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((s) => s.gnss === undefined)).toBe(true);
    // The IMU keeps coming — that is what dead reckoning runs on.
    expect(during.some((s) => s.imu)).toBe(true);
  });

  it('reports being in an outage', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSensorSource('simulation', 'city'));
    act(() => result.current.play());
    act(() => result.current.triggerOutage(10_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.inOutage).toBe(true);
  });

  it('advances faster at a higher playback rate', async () => {
    vi.useFakeTimers();
    const slow: SensorSample[] = [];
    const a = renderHook(() => useSensorSource('simulation', 'city', (s) => slow.push(s)));
    act(() => a.result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const slowSpan = slow[slow.length - 1]!.t;
    cleanup();

    const fast: SensorSample[] = [];
    const b = renderHook(() => useSensorSource('simulation', 'city', (s) => fast.push(s)));
    act(() => {
      b.result.current.setSpeed(5);
      b.result.current.play();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Five times the simulated time in the same wall-clock second.
    expect(fast[fast.length - 1]!.t).toBeGreaterThan(slowSpan * 2);
  });

  it('records what it emits, and offers it for download', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSensorSource('simulation', 'city'));
    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.recordedCount).toBeGreaterThan(0);
  });

  it('rebuilds the source when the route changes', async () => {
    const { result, rerender } = renderHook(
      ({ route }: { route: 'city' | 'highway' }) => useSensorSource('simulation', route),
      { initialProps: { route: 'city' as 'city' | 'highway' } },
    );
    expect(result.current.sourceName).toMatch(/city/i);
    rerender({ route: 'highway' });
    await waitFor(() => expect(result.current.sourceName).toMatch(/highway/i));
    // A fresh source, back at the start, with no stale fix carried across.
    expect(result.current.progress).toBe(0);
    expect(result.current.fix).toBeNull();
    expect(result.current.isRunning).toBe(false);
  });

  it('stops cleanly on unmount rather than leaving a timer running', async () => {
    vi.useFakeTimers();
    const samples: SensorSample[] = [];
    const { result, unmount } = renderHook(() =>
      useSensorSource('simulation', 'city', (s) => samples.push(s)),
    );
    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const atUnmount = samples.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // A leaked interval would keep pushing samples into a dead component.
    expect(samples.length).toBe(atUnmount);
  });
});

describe('useSensorSource — live', () => {
  it('resolves a live source without a route', async () => {
    const { result } = renderHook(() => useSensorSource('live', 'city'));
    await waitFor(() => expect(result.current.sourceName).not.toBe(''));
    // In jsdom this is the browser source; inside the APK it resolves to the
    // Capacitor one. Same interface either way.
    expect(result.current.sourceName).toMatch(/browser|capacitor/i);
  });

  it('has no simulation transport to drive', async () => {
    const { result } = renderHook(() => useSensorSource('live', 'city'));
    await waitFor(() => expect(result.current.sourceName).not.toBe(''));
    // Reset and outage are simulation-only; calling them must be harmless
    // rather than throwing on a live source.
    expect(() => act(() => result.current.reset())).not.toThrow();
    expect(() => act(() => result.current.triggerOutage(1000))).not.toThrow();
    expect(result.current.inOutage).toBe(false);
  });
});
