import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SensorSample } from '@pathpulse/nav-core';
import { useSensorSource } from './useSensorSource';

/**
 * The replay source — the demo-day backup.
 *
 * ★ A BACKUP YOU CANNOT RESTART IS HALF A BACKUP ★
 * The transport controls in `useSensorSource` were written when the only
 * scriptable source was the simulator, so several of them reach for `simRef`
 * and give up if it is null. The replay source lives in `webRef`. Nothing
 * fails loudly; the buttons simply stop working, on the one run where
 * everything else has already gone wrong.
 */

const LOG = readFileSync(
  resolve(process.cwd(), 'public/replay/demo.jsonl'),
  'utf8',
);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, text: async () => LOG }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const samples: SensorSample[] = [];
  const hook = renderHook(() =>
    useSensorSource('replay', 'city', (s) => {
      samples.push(s);
    }),
  );
  return { ...hook, samples };
}

describe('the replay source', () => {
  it('loads the backup log and names it', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.sourceName).toMatch(/Demo replay/));
    expect(result.current.sourceName).toMatch(/\d+ samples/);
  });

  it('plays and pauses', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.sourceName).toMatch(/Demo replay/));
    act(() => result.current.play());
    expect(result.current.isRunning).toBe(true);
    act(() => result.current.pause());
    expect(result.current.isRunning).toBe(false);
  });

  it('★ can be restarted — Reset must rewind the backup', async () => {
    // reset() reached for simRef and returned early when it was null, so the
    // Reset button did nothing at all in replay. You could play the backup
    // once and then had no way to run it again without reloading the app.
    const { result, samples } = setup();
    await waitFor(() => expect(result.current.sourceName).toMatch(/Demo replay/));

    act(() => result.current.play());
    await waitFor(() => expect(samples.length).toBeGreaterThan(5));
    const afterFirst = samples.length;

    act(() => result.current.reset());
    expect(result.current.isRunning).toBe(false);

    act(() => result.current.play());
    await waitFor(() => expect(samples.length).toBeGreaterThan(afterFirst + 5));
    // Rewound: the log starts again from its first timestamp.
    const restarted = samples.slice(afterFirst);
    expect(restarted[0]!.t).toBeLessThan(samples[afterFirst - 1]!.t);
  });

  it('★ reports progress, so the presenter can see where the backup is', async () => {
    // progress read `sim ? sim.progressFraction : 0`, so the bar sat at zero
    // for the whole replay — no way to tell a stalled backup from a running
    // one at a glance.
    const { result, samples } = setup();
    await waitFor(() => expect(result.current.sourceName).toMatch(/Demo replay/));
    act(() => result.current.play());
    await waitFor(() => expect(samples.length).toBeGreaterThan(20));
    await waitFor(() => expect(result.current.progress).toBeGreaterThan(0));
    expect(result.current.progress).toBeLessThanOrEqual(1);
  });

  it('says so rather than hanging when the log is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const { result } = setup();
    await waitFor(() => expect(result.current.sourceName).toMatch(/missing/i));
  });

  it('survives a fetch that rejects outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { result } = setup();
    await waitFor(() => expect(result.current.sourceName).toMatch(/missing/i));
  });
});
