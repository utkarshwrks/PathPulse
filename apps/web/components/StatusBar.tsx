'use client';

import type { NavEvent, NavigationState } from '@pathpulse/nav-core';
import { MODE_COLORS, MODE_LABELS } from '@/config/modes';
import type { GeolocationStatus } from '@/hooks/useGeolocation';

interface StatusBarProps {
  navState: NavigationState | null;
  status: GeolocationStatus;
  error: string | null;
  distanceM: number;
  mapSourceLabel: string;
  sourceName?: string;
  updateHz: number;
  imuHz: number;
  gnssHz: number;
  events: NavEvent[];
}

/**
 * Live numbers, straight off the navigation engine.
 *
 * Golden Rule #7: without numbers on screen a judge assumes the demo is fake.
 * Every value here is measured — the update rate is counted, not hardcoded.
 * Phase 5 expands this into the full HUD and debug panel.
 */
export default function StatusBar({
  navState,
  status,
  error,
  distanceM,
  mapSourceLabel,
  sourceName,
  updateHz,
  imuHz,
  gnssHz,
  events,
}: StatusBarProps) {
  const mode = navState?.mode ?? 'INITIALIZING';
  const color = MODE_COLORS[mode];
  const isDr = mode === 'DEAD_RECKONING';
  const driftPct =
    navState && navState.distanceTravelledM > 1
      ? (navState.estimatedDriftM / navState.distanceTravelledM) * 100
      : 0;

  const lastDrift = [...events].reverse().find((e) => e.type === 'DRIFT_MEASURED');

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[min(92vw,24rem)]">
      <div className="rounded-lg border border-white/10 bg-black/75 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${isDr ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
          />
          <span className="text-xs font-semibold tracking-wider" style={{ color }}>
            {MODE_LABELS[mode]}
          </span>
          <span className="tabular ml-auto font-mono text-[10px] text-neutral-500">
            {updateHz.toFixed(1)} Hz
          </span>
        </div>

        {navState ? (
          <div className="tabular mt-1.5 grid grid-cols-2 gap-x-3 font-mono text-[11px] leading-relaxed text-neutral-300">
            <Cell label="speed" value={`${(navState.velocityMps * 3.6).toFixed(1)} km/h`} />
            <Cell label="heading" value={`${navState.headingDeg.toFixed(0)}°`} />
            <Cell
              label={isDr ? 'drift est' : 'drift'}
              value={`${navState.estimatedDriftM.toFixed(1)} m`}
              accent={isDr}
            />
            <Cell label="drift %" value={`${driftPct.toFixed(1)} %`} accent={isDr} />
            <Cell label="distance" value={`${navState.distanceTravelledM.toFixed(0)} m`} />
            <Cell label="no gnss" value={`${(navState.timeSinceGnssMs / 1000).toFixed(1)} s`} />
          </div>
        ) : (
          <div className="mt-1.5 font-mono text-[11px] text-neutral-400">
            {status === 'requesting' ? 'GNSS: waiting for fix…' : 'waiting for first fix…'}
          </div>
        )}

        {navState ? (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[10px] text-neutral-500">
              <span>confidence</span>
              <span className="tabular font-mono">
                {(navState.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full transition-[width] duration-300"
                style={{ width: `${navState.confidence * 100}%`, backgroundColor: color }}
              />
            </div>
          </div>
        ) : null}

        {lastDrift ? (
          <div className="mt-1.5 rounded bg-white/5 px-1.5 py-1 text-[10px] leading-snug text-neutral-300">
            last recovery — <span className="font-mono">{lastDrift.message}</span>
          </div>
        ) : null}

        {error ? <div className="mt-1 text-[11px] text-amber-400">{error}</div> : null}

        <div className="tabular mt-1.5 border-t border-white/10 pt-1.5 font-mono text-[10px] text-neutral-500">
          imu {imuHz.toFixed(1)} Hz · gnss {gnssHz.toFixed(2)} Hz
          {sourceName ? (
            <>
              <br />
              {sourceName}
            </>
          ) : null}
          <br />
          {mapSourceLabel}
        </div>
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-neutral-500">{label}</span>
      <span className={accent ? 'text-orange-300' : 'text-neutral-100'}>{value}</span>
    </div>
  );
}
