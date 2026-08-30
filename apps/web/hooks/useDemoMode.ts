'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  demoPositionAt,
  shouldTriggerOutage,
  type DemoPosition,
} from '@/lib/demoScript';

export interface DemoActions {
  /** Put the app into the demo's starting configuration. */
  prepare: () => void;
  /** Punch the scripted GNSS outage. */
  triggerOutage: () => void;
}

export interface DemoMode {
  running: boolean;
  elapsedMs: number;
  position: DemoPosition;
  start: () => void;
  restart: () => void;
  stop: () => void;
}

const TICK_MS = 200;

/**
 * Drives the scripted demo.
 *
 * The clock is wall-clock elapsed rather than a tick count: a `setInterval`
 * that misses a beat — and it will, on a phone rendering a map — would drift
 * the script away from what the presenter is saying. Reading the real elapsed
 * time each tick means a dropped frame costs smoothness, never sequence.
 *
 * The outage is fired exactly once, guarded by a ref rather than by state,
 * because a re-render between the check and the set would fire it twice and
 * the second call would restart a 60 s outage mid-recovery.
 */
export function useDemoMode(actions: DemoActions): DemoMode {
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const outageFiredRef = useRef(false);
  // Held in a ref so the ticking effect does not restart every render when the
  // caller passes a fresh object, which it will.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const begin = useCallback(() => {
    outageFiredRef.current = false;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    actionsRef.current.prepare();
    setRunning(true);
  }, []);

  const stop = useCallback(() => {
    setRunning(false);
    startedAtRef.current = null;
    outageFiredRef.current = false;
    setElapsedMs(0);
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (!outageFiredRef.current && shouldTriggerOutage(elapsed)) {
        outageFiredRef.current = true;
        actionsRef.current.triggerOutage();
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  return {
    running,
    elapsedMs,
    position: demoPositionAt(elapsedMs),
    start: begin,
    restart: begin,
    stop,
  };
}
