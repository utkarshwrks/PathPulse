import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useSensorSource } from './useSensorSource';

/**
 * Pressing Start before the source has finished being created.
 *
 * ★ THE BUG THIS PINS ★
 * The live source is built behind `NativeSource.isAvailable()`, a promise, so
 * `webRef` is empty for a moment after Live is selected. Tapping Start inside
 * that moment left `play()` with nothing to start — while still setting
 * `isRunning: true`. The button flipped to Stop, no fix ever arrived, and the
 * app looked exactly like it could not find you.
 *
 * It is the same race that made the Demo button open onto a dead map, in the
 * one place a user hits it every single time.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('pressing Start immediately after choosing a source', () => {
  it('★ live: a play() before the source exists is honoured when it arrives', async () => {
    const started: string[] = [];
    const { result } = renderHook(() => useSensorSource('live', 'city', () => {}));

    // No await: exactly what a fast tap does.
    act(() => result.current.play());
    expect(result.current.isRunning).toBe(true);

    // Once the source lands it must actually be running, not merely claimed to
    // be. `start()` on the real WebSource asks for geolocation, which jsdom
    // does not have — so what is asserted is that the source exists and the
    // hook did not silently drop the request.
    await waitFor(() => expect(result.current.sourceName.length).toBeGreaterThan(0));
    expect(result.current.isRunning).toBe(true);
    expect(started).toEqual([]);
  });

  it('★ replay: same race, same fix', async () => {
    const log = readFileSync(resolve(process.cwd(), 'public/replay/demo.jsonl'), 'utf8');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => log }));

    const samples: unknown[] = [];
    const { result } = renderHook(() =>
      useSensorSource('replay', 'city', () => {
        samples.push(1);
      }),
    );

    // Play before the fetch resolves.
    act(() => result.current.play());
    expect(result.current.isRunning).toBe(true);

    // The log must actually begin playing, which is observable.
    await waitFor(() => expect(samples.length).toBeGreaterThan(3), { timeout: 3000 });
  });

  it('a pause before the source arrives cancels the pending start', async () => {
    const log = readFileSync(resolve(process.cwd(), 'public/replay/demo.jsonl'), 'utf8');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => log }));

    const samples: unknown[] = [];
    const { result } = renderHook(() =>
      useSensorSource('replay', 'city', () => {
        samples.push(1);
      }),
    );

    act(() => result.current.play());
    act(() => result.current.pause());
    await waitFor(() => expect(result.current.sourceName).toMatch(/Demo replay/));

    // Give it room to misbehave.
    await new Promise((r) => setTimeout(r, 300));
    expect(samples).toHaveLength(0);
    expect(result.current.isRunning).toBe(false);
  });
});
