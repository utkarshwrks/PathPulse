'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Browser geolocation, wrapped.
 *
 * ★ This file lives in apps/web on purpose. navigator.geolocation is a browser
 * API and must never appear in @pathpulse/nav-core (Golden Rule #1).
 * Phase 2 puts this behind the SensorSource interface; Phase 3 swaps in the
 * Capacitor native implementation.
 */

export type GeolocationStatus =
  | 'idle'
  | 'unsupported'
  | 'requesting'
  | 'watching'
  | 'denied'
  | 'unavailable';

export interface GnssFix {
  lat: number;
  lon: number;
  /** Horizontal accuracy in metres, as reported by the platform. */
  accuracyM: number;
  /** Ground speed in m/s, or null when the platform cannot supply it. */
  speedMps: number | null;
  /** Course over ground in degrees, or null when stationary/unknown. */
  headingDeg: number | null;
  altitudeM: number | null;
  /** Wall-clock ms from the platform. */
  timestamp: number;
}

export interface UseGeolocationResult {
  status: GeolocationStatus;
  fix: GnssFix | null;
  /** Human-readable reason we have no fix, if any. */
  error: string | null;
  /** Count of fixes received this session — proves the watch is alive. */
  fixCount: number;
  start: () => void;
  stop: () => void;
}

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  // Never hand us a cached fix — we want to see the real update cadence.
  maximumAge: 0,
  timeout: 5000,
};

export function useGeolocation(autoStart = false): UseGeolocationResult {
  const [status, setStatus] = useState<GeolocationStatus>('idle');
  const [fix, setFix] = useState<GnssFix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixCount, setFixCount] = useState(0);
  const watchIdRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setStatus('idle');
  }, []);

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStatus('unsupported');
      setError('This browser does not expose the Geolocation API.');
      return;
    }
    if (watchIdRef.current !== null) return;

    setStatus('requesting');
    setError(null);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        setFix({
          lat: c.latitude,
          lon: c.longitude,
          accuracyM: c.accuracy,
          // Chrome reports null (not 0) when it has no Doppler speed.
          speedMps: typeof c.speed === 'number' && !Number.isNaN(c.speed) ? c.speed : null,
          headingDeg:
            typeof c.heading === 'number' && !Number.isNaN(c.heading) ? c.heading : null,
          altitudeM:
            typeof c.altitude === 'number' && !Number.isNaN(c.altitude) ? c.altitude : null,
          timestamp: pos.timestamp,
        });
        setFixCount((n) => n + 1);
        setStatus('watching');
        setError(null);
      },
      (err) => {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setStatus('denied');
            setError('Location permission denied.');
            // Stop watching — retrying without permission just spins.
            if (watchIdRef.current !== null) {
              navigator.geolocation.clearWatch(watchIdRef.current);
              watchIdRef.current = null;
            }
            break;
          case err.POSITION_UNAVAILABLE:
            setStatus('unavailable');
            setError('Position unavailable — no usable signal.');
            break;
          case err.TIMEOUT:
            // Expected indoors. The watch stays alive and keeps trying, so
            // this is a status message, not a failure.
            setError('Waiting for a fix — no satellites yet.');
            break;
          default:
            setError(err.message || 'Unknown geolocation error.');
        }
      },
      GEO_OPTIONS,
    );
  }, []);

  useEffect(() => {
    if (autoStart) start();
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [autoStart, start]);

  return { status, fix, error, fixCount, start, stop };
}
