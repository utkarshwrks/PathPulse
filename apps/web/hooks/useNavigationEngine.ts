'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { NavigationEngine, type NavEvent, type NavigationState, type SensorSample } from '@pathpulse/nav-core';

/** UI emit rate. The engine itself runs at full sensor rate (50 Hz), which is
 *  strictly better; the problem statement asks for at least 10 Hz *output*. */
const EMIT_INTERVAL_MS = 100;

export interface NavEngineOutput {
  state: NavigationState | null;
  events: NavEvent[];
  /** Measured output rate — counted, never hardcoded. */
  updateHz: number;
  feed: (sample: SensorSample) => void;
  reset: () => void;
}

export function useNavigationEngine(): NavEngineOutput {
  const engineRef = useRef<NavigationEngine | null>(null);
  if (!engineRef.current) engineRef.current = new NavigationEngine();

  const [state, setState] = useState<NavigationState | null>(null);
  const [events, setEvents] = useState<NavEvent[]>([]);
  const [updateHz, setUpdateHz] = useState(0);

  const lastEmitRef = useRef(0);
  const emitTimesRef = useRef<number[]>([]);
  const pendingRef = useRef<NavigationState | null>(null);

  const feed = useCallback((sample: SensorSample) => {
    const engine = engineRef.current!;
    const next = engine.update(sample);
    pendingRef.current = next;

    // Throttle to the UI rate. React cannot usefully re-render at 50 Hz, and
    // trying makes the map stutter.
    if (next.t - lastEmitRef.current >= EMIT_INTERVAL_MS) {
      lastEmitRef.current = next.t;
      setState(next);
      setEvents([...engine.events.all]);

      const now = performance.now();
      emitTimesRef.current.push(now);
      if (emitTimesRef.current.length > 30) emitTimesRef.current.shift();
      const times = emitTimesRef.current;
      if (times.length > 2) {
        const spanS = (times[times.length - 1]! - times[0]!) / 1000;
        if (spanS > 0) setUpdateHz((times.length - 1) / spanS);
      }
    }
  }, []);

  const reset = useCallback(() => {
    engineRef.current?.reset();
    lastEmitRef.current = 0;
    emitTimesRef.current = [];
    pendingRef.current = null;
    setState(null);
    setEvents([]);
    setUpdateHz(0);
  }, []);

  useEffect(() => () => engineRef.current?.reset(), []);

  return { state, events, updateHz, feed, reset };
}
