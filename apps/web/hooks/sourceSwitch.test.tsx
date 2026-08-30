import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { useSensorSource, type SourceKind } from './useSensorSource';

/**
 * Switching source while it is running.
 *
 * ★ THE ORDERING THAT MATTERS ★
 * `SourcePicker.onPick` sets the kind AND calls play() in the same handler —
 * before React has run the effect that rebuilds the source. So the outgoing
 * source is still in its ref: play() starts the one being torn down, the
 * incoming one never starts, and `isRunning` is set true regardless.
 *
 * Measured on a real phone: picking "This phone" showed RUNNING with imu
 * 0.0 Hz and gnss 0.00 Hz, while a manual Pause then Start took the IMU
 * straight to 60 Hz.
 *
 * A test that rerenders and *then* plays does not reproduce this, because the
 * rerender flushes the effect first — which is exactly how the first version
 * of this test passed against the broken code.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function useHarness(onSample: () => void) {
  const [kind, setKind] = useState<SourceKind>('simulation');
  const source = useSensorSource(kind, 'city', onSample);
  return {
    source,
    kind,
    // Both in one handler, exactly as SourcePicker does it.
    pick: (next: SourceKind) => {
      setKind(next);
      source.play();
    },
  };
}

describe('picking a different source while running', () => {
  it('★ starts the NEW source, not the one being torn down', async () => {
    const log = readFileSync(resolve(process.cwd(), 'public/replay/demo.jsonl'), 'utf8');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => log }));

    let count = 0;
    const { result } = renderHook(() => useHarness(() => { count++; }));

    act(() => result.current.source.play());
    await waitFor(() => expect(count).toBeGreaterThan(2));
    const afterSim = count;

    // The real gesture: set the kind and play in the same tick.
    act(() => result.current.pick('replay'));
    await waitFor(() => expect(result.current.kind).toBe('replay'));

    // The replay log must actually produce samples, not merely claim to run.
    await waitFor(() => expect(count).toBeGreaterThan(afterSim + 3), { timeout: 4000 });
    expect(result.current.source.isRunning).toBe(true);
    expect(result.current.source.sourceName).toMatch(/Demo replay/);
  });
});
