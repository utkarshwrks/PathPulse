'use client';

import { useEffect, useRef, useState } from 'react';
import type { NavMode } from '@pathpulse/nav-core';
import type { GnssFix } from './useGeolocation';

/**
 * Dev-only synthetic track, enabled with ?mock=1.
 *
 * Exists so the map, marker and mode-coloured trail can be exercised on a
 * laptop with no GPS. It drives a vehicle around a small loop and cycles
 * through the navigation modes so the trail's segment colouring is visible.
 *
 * This is a stopgap for Phase 1 verification only. Phase 2 replaces it with
 * the real SimulationSource in @pathpulse/sensor-sources, which models IMU
 * noise, bias and vibration properly and lives behind the SensorSource
 * interface. Do not build on this.
 */

const START = { lat: 28.6315, lon: 77.2167 };
const STEP_MS = 500;
/** Metres advanced per tick — ~14 m/s, roughly 50 km/h. */
const STEP_M = 7;

const MODE_SCRIPT: Array<{ untilTick: number; mode: NavMode }> = [
  { untilTick: 16, mode: 'GNSS' },
  { untilTick: 24, mode: 'GNSS_DEGRADED' },
  { untilTick: 60, mode: 'DEAD_RECKONING' },
  { untilTick: 68, mode: 'RECOVERING' },
  { untilTick: Number.POSITIVE_INFINITY, mode: 'GNSS' },
];

export function mockModeForTick(tick: number): NavMode {
  return MODE_SCRIPT.find((s) => tick < s.untilTick)?.mode ?? 'GNSS';
}

export function useMockTrack(enabled: boolean): { fix: GnssFix | null; mode: NavMode } {
  const [fix, setFix] = useState<GnssFix | null>(null);
  const [mode, setMode] = useState<NavMode>('INITIALIZING');
  const tickRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const id = window.setInterval(() => {
      const tick = tickRef.current++;
      // A gentle arc so the heading actually changes and the arrow rotates.
      const headingDeg = (tick * 4) % 360;
      const rad = (headingDeg * Math.PI) / 180;
      const travelled = tick * STEP_M;

      setFix((prev) => {
        const baseLat = prev?.lat ?? START.lat;
        const baseLon = prev?.lon ?? START.lon;
        const dLat = (STEP_M * Math.cos(rad)) / 111_132;
        const dLon =
          (STEP_M * Math.sin(rad)) / (111_320 * Math.cos((baseLat * Math.PI) / 180));
        return {
          lat: baseLat + dLat,
          lon: baseLon + dLon,
          accuracyM: mockModeForTick(tick) === 'GNSS_DEGRADED' ? 31 : 4.2,
          speedMps: STEP_M / (STEP_MS / 1000),
          headingDeg,
          altitudeM: 216,
          timestamp: Date.now(),
        };
      });
      setMode(mockModeForTick(tick));
      void travelled;
    }, STEP_MS);

    return () => window.clearInterval(id);
  }, [enabled]);

  return { fix, mode };
}
