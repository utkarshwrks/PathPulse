'use client';

import type { GeolocationStatus } from '@/hooks/useGeolocation';

interface PermissionGateProps {
  status: GeolocationStatus;
  error: string | null;
  onRetry: () => void;
  /**
   * Leave live sensors and go back to something that works.
   *
   * ★ THIS GATE USED TO BE A TRAP ★
   * It covers the whole screen and offered only "Retry". Choose live sensors
   * on an http origin, or deny the prompt once, and there was no way back —
   * the source picker was underneath it and the menu button was behind it. The
   * app was not broken; it was unreachable, which to the person holding it is
   * the same thing and looks worse.
   */
  onUseSimulation: () => void;
}

/**
 * Shown when we cannot watch position. Never a crash, never a blank screen —
 * a blocked fix during a demo must still leave something coherent up.
 *
 * The three blocked states are deliberately distinguished. They look identical
 * to the user (no dot) but have completely different fixes, and telling someone
 * to "allow location" when the real problem is an http:// origin sends them
 * chasing a setting that will not help.
 */
export default function PermissionGate({
  status,
  error,
  onRetry,
  onUseSimulation,
}: PermissionGateProps) {
  const blocked = status === 'denied' || status === 'unsupported' || status === 'insecure';
  if (!blocked) return null;

  const escape = (
    <button
      type="button"
      onClick={onUseSimulation}
      className="mt-3 w-full rounded-lg border border-white/15 px-4 py-2 text-sm text-neutral-300 transition hover:bg-white/10"
    >
      Use the simulation instead
    </button>
  );

  if (status === 'insecure') {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return (
      <Shell title="Not a secure context">
        <p className="text-sm leading-relaxed text-neutral-400">
          Browsers only expose GNSS over HTTPS or <code>localhost</code>. This page is
          plain HTTP, so Chrome blocks location <strong>without ever prompting</strong> —
          it reports a denial you were never asked about.
        </p>
        {origin ? (
          <p className="mt-2 break-all font-mono text-[11px] text-neutral-600">{origin}</p>
        ) : null}
        <div className="mt-4 rounded-lg border border-white/10 bg-black/40 p-3 text-left">
          <p className="text-xs font-semibold text-neutral-300">Options</p>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-neutral-400">
            <li>
              <strong className="text-neutral-300">Simulate instead:</strong> add{' '}
              <code className="text-neutral-300">?mock=1</code> to the URL — no GNSS needed.
            </li>
            <li>
              <strong className="text-neutral-300">Android Chrome:</strong> allow this origin
              under <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>,
              then relaunch.
            </li>
            <li>
              <strong className="text-neutral-300">Real fix:</strong> the Android APK uses
              native permissions and has no secure-context rule.
            </li>
          </ul>
        </div>
        {escape}
      </Shell>
    );
  }

  if (status === 'unsupported') {
    return (
      <Shell title="Geolocation unsupported">
        <p className="text-sm leading-relaxed text-neutral-400">
          This browser does not expose the Geolocation API. Add{' '}
          <code className="text-neutral-300">?mock=1</code> to the URL to drive a synthetic
          track instead.
        </p>
        {error ? <p className="mt-2 text-xs text-amber-400">{error}</p> : null}
        {escape}
      </Shell>
    );
  }

  return (
    <Shell title="Location permission needed">
      <p className="text-sm leading-relaxed text-neutral-400">
        PathPulse needs your location to show the live GNSS marker. Enable location for this
        site in your browser settings, then retry.
      </p>
      {error ? <p className="mt-2 text-xs text-amber-400">{error}</p> : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white"
      >
        Retry
      </button>
      {escape}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-[45] flex items-center justify-center bg-black/80 p-6 backdrop-blur">
      <div className="max-w-sm rounded-xl border border-white/10 bg-neutral-900 p-6 text-center">
        <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}
