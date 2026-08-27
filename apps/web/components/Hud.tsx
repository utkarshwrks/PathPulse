'use client';

import type { NavEvent, NavigationState } from '@pathpulse/nav-core';
import { MODE_COLORS, MODE_LABELS } from '@/config/modes';

interface HudProps {
  navState: NavigationState | null;
  updateHz: number;
  imuHz: number;
  gnssHz: number;
  sourceName?: string;
  mapSourceLabel: string;
  events: NavEvent[];
  error: string | null;
  walkingMode: boolean;
}

/**
 * Phase 5A — the heads-up display.
 *
 * ★ GOLDEN RULE #7: PUT NUMBERS ON THE SCREEN ★
 * Without them a judge assumes the demo is fake, however good the maths is.
 * Every value here is measured rather than asserted: the update rate is
 * counted from real frames, the rates come from the sensor source's own
 * counters, and the drift shown after a recovery is the one measured against
 * a real GNSS fix.
 *
 * Monospace and tabular numerals throughout, so digits do not jitter as they
 * change — a HUD that visibly twitches reads as unstable even when it is not.
 */
export default function Hud({
  navState,
  updateHz,
  imuHz,
  gnssHz,
  sourceName,
  mapSourceLabel,
  events,
  error,
  walkingMode,
}: HudProps) {
  const mode = navState?.mode ?? 'INITIALIZING';
  const color = MODE_COLORS[mode];
  const isDr = mode === 'DEAD_RECKONING';

  // Drift as a percentage of distance travelled — the problem statement's own
  // metric. Guarded against the first metre, where the ratio is meaningless.
  const driftPct =
    navState && navState.distanceTravelledM > 1
      ? (navState.estimatedDriftM / navState.distanceTravelledM) * 100
      : 0;

  const lastDrift = [...events].reverse().find((e) => e.type === 'DRIFT_MEASURED');
  const hzLow = updateHz > 0 && updateHz < 10;

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[min(92vw,25rem)]">
      <div className="rounded-xl border border-white/10 bg-black/80 px-3 py-2.5 backdrop-blur-md">
        {/* Mode badge — the single most-looked-at element in the demo. */}
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-3 w-3 rounded-full ${isDr ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }}
          />
          <span
            className="text-sm font-bold uppercase tracking-[0.12em]"
            style={{ color }}
          >
            {MODE_LABELS[mode]}
          </span>
          {walkingMode ? (
            <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300">
              walking
            </span>
          ) : null}
          <span
            className={`tabular ml-auto font-mono text-[11px] ${
              hzLow ? 'text-amber-400' : 'text-neutral-500'
            }`}
            title="Measured engine output rate. The problem statement requires at least 10 Hz."
          >
            {updateHz.toFixed(1)} Hz
          </span>
        </div>

        {navState ? (
          <>
            {/* Speed gets the largest type: it is the number people read first. */}
            <div className="mt-2 flex items-end gap-3">
              <div className="flex items-baseline gap-1.5">
                <span className="tabular font-mono text-[2rem] font-semibold leading-none text-neutral-50">
                  {(navState.velocityMps * 3.6).toFixed(0)}
                </span>
                <span className="text-[11px] font-medium text-neutral-500">km/h</span>
              </div>
              <div className="mb-0.5 flex items-baseline gap-1.5">
                <span className="tabular font-mono text-lg leading-none text-neutral-200">
                  {navState.headingDeg.toFixed(0)}
                </span>
                <span className="text-[11px] text-neutral-500">°</span>
              </div>
              <div className="mb-0.5 ml-auto text-right">
                <div
                  className={`tabular font-mono text-lg leading-none ${
                    isDr ? 'text-orange-300' : 'text-neutral-200'
                  }`}
                >
                  {navState.estimatedDriftM.toFixed(1)}
                  <span className="ml-1 text-[11px] text-neutral-500">m</span>
                </div>
                <div className="text-[9px] uppercase tracking-wide text-neutral-500">
                  {isDr ? 'drift est' : 'drift'}
                </div>
              </div>
            </div>

            <div className="tabular mt-2 grid grid-cols-2 gap-x-4 font-mono text-[11px] leading-relaxed text-neutral-300">
              <Cell label="drift %" value={`${driftPct.toFixed(1)} %`} accent={isDr} />
              <Cell label="distance" value={`${navState.distanceTravelledM.toFixed(0)} m`} />
              <Cell
                label="no gnss"
                value={`${(navState.timeSinceGnssMs / 1000).toFixed(1)} s`}
                accent={isDr}
              />
              <Cell
                label="uncert."
                value={`${navState.covariance.alongM.toFixed(0)}/${navState.covariance.crossM.toFixed(0)} m`}
              />
            </div>

            <div className="mt-2">
              <div className="flex items-center justify-between text-[10px] text-neutral-500">
                <span>confidence</span>
                <span className="tabular font-mono">
                  {(navState.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full transition-[width] duration-300"
                  style={{ width: `${navState.confidence * 100}%`, backgroundColor: color }}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="mt-2 font-mono text-[11px] text-neutral-400">
            waiting for first fix…
          </div>
        )}

        {lastDrift ? (
          <div className="mt-2 rounded bg-white/5 px-1.5 py-1 text-[10px] leading-snug text-neutral-300">
            last recovery — <span className="font-mono">{lastDrift.message}</span>
          </div>
        ) : null}

        {error ? <div className="mt-1 text-[11px] text-amber-400">{error}</div> : null}

        <div className="tabular mt-2 border-t border-white/10 pt-1.5 font-mono text-[10px] text-neutral-500">
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

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-neutral-500">{label}</span>
      <span className={accent ? 'text-orange-300' : 'text-neutral-100'}>{value}</span>
    </div>
  );
}
