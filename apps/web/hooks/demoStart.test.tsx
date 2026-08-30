import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import type { SensorSample } from '@pathpulse/nav-core';
import { useSensorSource, type RouteKey, type SourceKind } from './useSensorSource';

/**
 * Starting the scripted demo from whatever source happens to be selected.
 *
 * ★ THE ORDERING BUG THIS PINS ★
 * `useSensorSource` rebuilds its source inside an effect keyed on
 * [kind, routeKey], and effects run after the render that changed them. So
 * pressing Demo while Live was selected called `play()` on a simulator that
 * did not exist yet — `simRef` was still null, the web source was started
 * instead, and the fresh simulator arrived a moment later un-started. The
 * result was a demo banner counting down over a dead map.
 *
 * page.tsx is not directly testable (it dynamically imports a WebGL map), so
 * this reproduces its hook composition: the same source hook, the same
 * epoch-driven start effect, in the same order.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Mirrors page.tsx: the source hook, then an epoch-keyed start effect. */
function useHarness(initialKind: SourceKind) {
  const [kind, setKind] = useState<SourceKind>(initialKind);
  const [routeKey, setRouteKey] = useState<RouteKey>('highway');
  const [demoEpoch, setDemoEpoch] = useState(0);
  const samples: SensorSample[] = [];
  const source = useSensorSource(kind, routeKey, (s) => {
    samples.push(s);
  });

  useEffect(() => {
    if (demoEpoch === 0) return;
    source.reset();
    source.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoEpoch]);

  return {
    source,
    kind,
    startDemo: () => {
      setKind('simulation');
      setRouteKey('city');
      setDemoEpoch((e) => e + 1);
    },
  };
}

describe('starting the demo', () => {
  it('★ runs when the demo is started from the Live source', async () => {
    // The failing case. Before the fix this left isRunning false, because
    // play() ran against a simulator that did not exist yet.
    const { result } = renderHook(() => useHarness('live'));
    expect(result.current.kind).toBe('live');

    act(() => result.current.startDemo());

    await waitFor(() => expect(result.current.kind).toBe('simulation'));
    await waitFor(() => expect(result.current.source.isRunning).toBe(true));
    expect(result.current.source.sourceName).toMatch(/sim/i);
  });

  it('runs when the demo is started from an already-simulated source', async () => {
    const { result } = renderHook(() => useHarness('simulation'));
    act(() => result.current.startDemo());
    await waitFor(() => expect(result.current.source.isRunning).toBe(true));
  });

  it('restarts cleanly when started twice', async () => {
    const { result } = renderHook(() => useHarness('simulation'));
    act(() => result.current.startDemo());
    await waitFor(() => expect(result.current.source.isRunning).toBe(true));
    act(() => result.current.startDemo());
    await waitFor(() => expect(result.current.source.isRunning).toBe(true));
  });
});
