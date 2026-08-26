'use client';

import type { NavMode } from '@pathpulse/nav-core';
import { MODE_COLORS, MODE_LABELS } from '@/config/modes';
import type { GnssFix, GeolocationStatus } from '@/hooks/useGeolocation';

interface StatusBarProps {
  mode: NavMode;
  fix: GnssFix | null;
  status: GeolocationStatus;
  error: string | null;
  fixCount: number;
  distanceM: number;
  mapSourceLabel: string;
}

export default function StatusBar({
  mode,
  fix,
  status,
  error,
  fixCount,
  distanceM,
  mapSourceLabel,
}: StatusBarProps) {
  const color = MODE_COLORS[mode];

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[min(92vw,26rem)]">
      <div className="rounded-lg border border-white/10 bg-black/70 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
          />
          <span className="text-xs font-semibold tracking-wider" style={{ color }}>
            {MODE_LABELS[mode]}
          </span>
        </div>

        <div className="tabular mt-1.5 font-mono text-[11px] leading-relaxed text-neutral-300">
          {fix ? (
            <>
              <div>
                accuracy <span className="text-neutral-100">{fix.accuracyM.toFixed(1)} m</span>
                {'  ·  '}
                fixes <span className="text-neutral-100">{fixCount}</span>
              </div>
              <div>
                {fix.lat.toFixed(6)}, {fix.lon.toFixed(6)}
              </div>
              <div>
                speed{' '}
                <span className="text-neutral-100">
                  {fix.speedMps === null ? '—' : `${(fix.speedMps * 3.6).toFixed(1)} km/h`}
                </span>
                {'  ·  '}
                hdg{' '}
                <span className="text-neutral-100">
                  {fix.headingDeg === null ? '—' : `${fix.headingDeg.toFixed(0)}°`}
                </span>
              </div>
              <div>
                trail <span className="text-neutral-100">{distanceM.toFixed(0)} m</span>
              </div>
            </>
          ) : (
            <div className="text-neutral-400">
              {status === 'requesting' ? 'GNSS: waiting for fix…' : 'GNSS: no fix'}
            </div>
          )}
        </div>

        {error ? <div className="mt-1 text-[11px] text-amber-400">{error}</div> : null}

        <div className="mt-1.5 border-t border-white/10 pt-1.5 text-[10px] text-neutral-500">
          {/* Honest about a real platform limit rather than faking a number. */}
          satellites: unavailable on web — native GnssStatus lands in Phase 15
          <br />
          basemap: {mapSourceLabel}
        </div>
      </div>
    </div>
  );
}
