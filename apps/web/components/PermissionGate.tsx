'use client';

import type { GeolocationStatus } from '@/hooks/useGeolocation';

interface PermissionGateProps {
  status: GeolocationStatus;
  error: string | null;
  onRetry: () => void;
}

/**
 * Shown when we cannot watch position. Never a crash, never a blank screen —
 * a denied permission during a demo must still leave something coherent up.
 */
export default function PermissionGate({ status, error, onRetry }: PermissionGateProps) {
  const blocked = status === 'denied' || status === 'unsupported';
  if (!blocked) return null;

  const denied = status === 'denied';

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-6 backdrop-blur">
      <div className="max-w-sm rounded-xl border border-white/10 bg-neutral-900 p-6 text-center">
        <h2 className="text-lg font-semibold text-neutral-100">
          {denied ? 'Location permission needed' : 'Geolocation unsupported'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          {denied
            ? 'PathPulse needs your location to show the live GNSS marker. Enable location for this site in your browser settings, then retry.'
            : 'This browser does not expose the Geolocation API. Phase 2 adds a simulation source that needs no GPS at all.'}
        </p>
        {error ? <p className="mt-2 text-xs text-amber-400">{error}</p> : null}
        {denied ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white"
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}
