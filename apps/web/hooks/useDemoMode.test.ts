import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDemoMode } from './useDemoMode';

/**
 * The demo driver.
 *
 * The failure that matters is firing the outage twice: the second call would
 * restart a 60 s outage part-way through the recovery, so the marker would
 * never come back and the demo would end on the estimator apparently failing.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const prepare = vi.fn();
  const triggerOutage = vi.fn();
  const hook = renderHook(() => useDemoMode({ prepare, triggerOutage }));
  return { ...hook, prepare, triggerOutage };
}

describe('useDemoMode', () => {
  it('is idle until started', () => {
    const { result, prepare } = setup();
    expect(result.current.running).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('sets the stage on start', () => {
    const { result, prepare } = setup();
    act(() => result.current.start());
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.current.running).toBe(true);
  });

  it('advances the clock and the phase', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => void vi.advanceTimersByTime(16_000));
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(15_000);
    expect(result.current.position.phase.kind).toBe('OUTAGE');
  });

  it('★ fires the outage exactly once, however many ticks pass', () => {
    // Guarded by a ref rather than state: a re-render between the check and
    // the set would fire it twice, and the second call restarts a 60 s outage
    // mid-recovery — the marker never returns and the demo ends on an apparent
    // failure.
    const { result, triggerOutage } = setup();
    act(() => result.current.start());
    act(() => void vi.advanceTimersByTime(60_000));
    expect(triggerOutage).toHaveBeenCalledTimes(1);
  });

  it('does not fire the outage before its mark', () => {
    const { result, triggerOutage } = setup();
    act(() => result.current.start());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(triggerOutage).not.toHaveBeenCalled();
  });

  it('re-arms the outage on a restart', () => {
    const { result, triggerOutage, prepare } = setup();
    act(() => result.current.start());
    act(() => void vi.advanceTimersByTime(20_000));
    expect(triggerOutage).toHaveBeenCalledTimes(1);

    act(() => result.current.restart());
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(result.current.elapsedMs).toBe(0);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(triggerOutage).toHaveBeenCalledTimes(2);
  });

  it('stops cleanly and stops ticking', () => {
    const { result, triggerOutage } = setup();
    act(() => result.current.start());
    act(() => result.current.stop());
    expect(result.current.running).toBe(false);
    expect(result.current.elapsedMs).toBe(0);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(triggerOutage).not.toHaveBeenCalled();
  });

  it('clears its interval on unmount', () => {
    const { result, unmount, triggerOutage } = setup();
    act(() => result.current.start());
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(triggerOutage).not.toHaveBeenCalled();
  });
});
