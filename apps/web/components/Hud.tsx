'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MotionContext, NavEvent, NavigationState, SpeedSource } from '@pathpulse/nav-core';
import { driftRatioPct } from '@pathpulse/nav-core';
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
  /**
   * What the engine has worked out the carrier is doing.
   *
   * ★ IT IS NOT A COSMETIC BADGE ★ This one value decides whether the speed
   * model is consulted at all, whether device yaw is integrated into the
   * heading, and whether GNSS may assert a stop the accelerometer cannot see.
   * Somebody watching the AI badge disappear when the phone leaves the cradle
   * is owed the reason on the same line.
   */
  motionContext?: MotionContext;
  /** Phase 8 — where the speed came from, shown beside it. */
  speedSource?: SpeedSource;
  /**
   * Why the engine is degraded or dead reckoning, in words.
   *
   * Both facts were already on screen — the mode, and the fix age — and read
   * as a contradiction without this.
   */
  modeReason?: string | null;
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
/**
 * Where the panel sits. Four corners, chosen by dragging it.
 *
 * ★ WHY A CORNER AND NOT FREE POSITIONING ★
 * Field report: "if a pointer is below that I can't see the point, and even
 * the map is not zoomable there." The fix is to let the panel move out of the
 * way — but free positioning on a phone means a panel half off-screen, or
 * covering the Demo button, and it has to be re-solved on every rotation and
 * every screen size. Four corners cannot be dropped anywhere useless, survive
 * a rotation without arithmetic, and are reachable one-handed.
 */
export type HudCorner = 'tl' | 'tr' | 'bl' | 'br';

const CORNER_KEY = 'pathpulse.hud.corner';
const COLLAPSED_KEY = 'pathpulse.hud.collapsed';

/**
 * `right-16` at the top keeps clear of the menu button, which lives there.
 * The bottom row clears the Demo button and the attribution strip.
 */
const CORNER_CLASS: Record<HudCorner, string> = {
  tl: 'left-3 right-16 top-3',
  tr: 'right-3 top-16 left-auto',
  bl: 'left-3 right-16 bottom-24',
  br: 'right-3 bottom-24 left-auto',
};

function readStored<T extends string>(key: string, fallback: T, valid: readonly T[]): T {
  try {
    const v = window.localStorage.getItem(key);
    return v !== null && (valid as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    // Storage is fallible in this codebase by policy — a private window, a
    // browser blocking site data. The default is always usable.
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Losing the preference across restarts is the whole cost.
  }
}

/** Nearest corner to a point, in viewport coordinates. */
export function nearestCorner(x: number, y: number, width: number, height: number): HudCorner {
  const left = x < width / 2;
  const top = y < height / 2;
  return left ? (top ? 'tl' : 'bl') : top ? 'tr' : 'br';
}

export default function Hud({
  modeReason,
  navState,
  updateHz,
  imuHz,
  gnssHz,
  sourceName,
  mapSourceLabel,
  events,
  error,
  walkingMode,
  motionContext,
  speedSource,
}: HudProps) {
  const mode = navState?.mode ?? 'INITIALIZING';
  const color = MODE_COLORS[mode];
  const isDr = mode === 'DEAD_RECKONING';

  // Drift as a percentage of distance travelled — the problem statement's own
  // metric, and null until there is enough distance to divide by. The old guard
  // was one metre, which is not a guard: parked on a desk this cell read
  // 1067.9 %, then 228 %, then 236 %, purely because the denominator was noise.
  // See nav-core/state/drift.ts.
  const driftPct = navState
    ? driftRatioPct(navState.estimatedDriftM, navState.distanceTravelledM)
    : null;

  const lastDrift = [...events].reverse().find((e) => e.type === 'DRIFT_MEASURED');
  const hzLow = updateHz > 0 && updateHz < 10;

  const [corner, setCorner] = useState<HudCorner>('tl');
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Read once on mount rather than during render: localStorage is not
  // available during SSR and this component is part of a static export.
  useEffect(() => {
    setCorner(readStored<HudCorner>(CORNER_KEY, 'tl', ['tl', 'tr', 'bl', 'br']));
    setCollapsed(readStored(COLLAPSED_KEY, 'false', ['true', 'false']) === 'true');
  }, []);

  // The write is deliberately OUTSIDE the updater. React may invoke a state
  // updater more than once for the same transition, and an updater that also
  // writes to storage is a side effect in a place React is entitled to repeat.
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    store(COLLAPSED_KEY, String(next));
  }, [collapsed]);

  /*
   * ★ SNAP ON RELEASE, DO NOT TRACK THE FINGER ★
   * Following the pointer means re-rendering the whole HUD on every move event
   * while the engine is also emitting at 10 Hz, and it ends with the panel
   * wherever the finger happened to lift — including half off-screen. Reading
   * the release point and picking a corner costs one render and cannot produce
   * an unusable layout.
   */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only a primary press on the grab handle; never a scroll or a second
    // finger, which on a phone is usually the start of a pinch.
    if (!e.isPrimary) return;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const w = typeof window === 'undefined' ? 0 : window.innerWidth;
    const h = typeof window === 'undefined' ? 0 : window.innerHeight;
    if (w === 0 || h === 0) return;
    const next = nearestCorner(e.clientX, e.clientY, w, h);
    setCorner(next);
    store(CORNER_KEY, next);
  }, [dragging]);

  return (
    <div
      className={`pointer-events-none absolute z-10 max-w-[25rem] ${CORNER_CLASS[corner]}`}
      data-tour="hud"
      data-corner={corner}
    >
      <div
        className={`pp-surface relative overflow-hidden px-3.5 py-3 ${dragging ? 'opacity-70' : ''}`}
      >
        {/*
          The grab handle is the header strip itself, and the collapse control
          sits in it. `touch-none` matters: without it the browser claims the
          gesture for scrolling and the pointer events never arrive.
        */}
        <div
          className="pointer-events-auto flex touch-none items-center gap-2"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDragging(false)}
          data-testid="hud-handle"
        >
          <span
            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${isDr ? 'pp-beacon' : ''}`}
            style={{ backgroundColor: color, boxShadow: `0 0 12px ${color}, 0 0 3px ${color}` }}
          />
          <span
            className="text-[13px] font-semibold uppercase tracking-[0.14em]"
            style={{ color }}
          >
            {MODE_LABELS[mode]}
          </span>
          {/*
            One badge slot, not two. The detected context is the more useful of
            the two facts and needs no explaining; the manual Walking Mode
            switch only fills the slot when nothing has been detected yet.
          */}
          {motionContext === 'PEDESTRIAN' ? (
            <span
              title="Detected: on foot. The vehicle-trained speed model is held back and the heading comes from GNSS, not from device yaw."
              className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300"
            >
              on foot
            </span>
          ) : motionContext === 'STATIONARY' ? (
            <span
              title="Detected: not moving. GNSS has found no displacement, so velocity is held at zero."
              className="rounded bg-neutral-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-300"
            >
              still
            </span>
          ) : walkingMode ? (
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
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand the HUD' : 'Collapse the HUD'}
            data-testid="hud-collapse"
            className="pointer-events-auto -my-1 ml-1 rounded px-1.5 py-1 text-[11px] leading-none text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
          >
            {collapsed ? '▾' : '▴'}
          </button>
        </div>

        {/*
          ★ COLLAPSED IS NOT EMPTY ★
          Hiding everything would mean tapping twice to read the speed, which
          is the number people look at most. Mode, speed and drift are the
          three that answer "is it working right now"; everything else is
          detail that can wait for a tap.
        */}
        {collapsed && navState ? (
          <div className="tabular mt-2 flex items-baseline gap-3 font-mono text-[11px] text-neutral-300">
            <span>
              <span className="text-[1.05rem] font-semibold text-white">
                {(navState.velocityMps * 3.6).toFixed(0)}
              </span>{' '}
              km/h
            </span>
            {driftPct !== null ? <span>drift {driftPct.toFixed(1)} %</span> : null}
          </div>
        ) : null}

        {!collapsed && navState ? (
          <>
            {/* Speed gets the largest type: it is the number people read first. */}
            <div className="mt-3 flex items-end gap-3.5">
              <div className="flex items-baseline gap-1.5">
                <span className="tabular font-mono text-[2.25rem] font-semibold leading-[0.9] tracking-tight text-white">
                  {(navState.velocityMps * 3.6).toFixed(0)}
                </span>
                <span className="text-[11px] font-medium text-neutral-500">km/h</span>
                {/*
                  ★ SAY WHERE THE SPEED CAME FROM. ★
                  The problem statement asks for AI, so a judge will ask whether
                  the AI is doing anything. "[ML]" next to a moving number while
                  the badge reads DEAD RECKONING is the answer, and it costs one
                  span. [GNSS] while satellites are up is equally important: it
                  shows we do NOT use the model when we have something better.
                */}
                {speedSource && speedSource !== 'NONE' ? (
                  <span
                    data-testid="speed-source"
                    className={`ml-0.5 rounded px-1 py-px font-mono text-[10px] font-semibold ${
                      speedSource === 'ML' || speedSource === 'STEPS'
                        ? 'bg-violet-500/20 text-violet-300'
                        : speedSource === 'GNSS'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-neutral-700/60 text-neutral-400'
                    }`}
                  >
                    [{speedSource}]
                  </span>
                ) : null}
              </div>
              <div className="mb-0.5 flex items-baseline gap-1.5">
                <span className="tabular font-mono text-[17px] leading-none text-neutral-300">
                  {navState.headingDeg.toFixed(0)}
                </span>
                <span className="text-[11px] text-neutral-500">°</span>
              </div>
              <div className="mb-0.5 ml-auto text-right">
                <div
                  className={`tabular font-mono text-[17px] leading-none ${
                    isDr ? 'text-orange-300' : 'text-neutral-300'
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

            <div className="tabular mt-3 grid grid-cols-2 gap-x-5 gap-y-0.5 border-t border-white/[0.07] pt-2.5 font-mono text-[11px] leading-relaxed text-neutral-300">
              {/* Metres when the ratio has no denominator yet: the honest
                  quantity at that scale, and it never reads as a failure. */}
              <Cell
                label={driftPct === null ? 'drift est' : 'drift %'}
                value={
                  driftPct === null
                    ? `${(navState?.estimatedDriftM ?? 0).toFixed(1)} m`
                    : `${driftPct.toFixed(1)} %`
                }
                accent={isDr}
              />
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
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full transition-[width,background-color] duration-500 ease-out"
                  style={{
                    width: `${navState.confidence * 100}%`,
                    backgroundColor: color,
                    boxShadow: `0 0 8px ${color}`,
                  }}
                />
              </div>
            </div>
          </>
        ) : collapsed ? null : (
          <div className="mt-2 font-mono text-[11px] text-neutral-400">
            waiting for first fix…
          </div>
        )}

        {/* Everything below is detail. Collapsed, the panel keeps only what
            answers "is it working right now" — see the collapsed block above. */}
        {!collapsed ? (
        <>

        {/* ★ SAY WHY, NOT JUST WHAT ★
            Observed on a real phone indoors: "DEAD RECKONING" and
            "no gnss 1.3 s" on screen together — both true, together
            unreadable. Someone watching the phone lie still on a table
            concluded the app was inventing movement. The reason was computed
            all along and thrown away. */}
        {modeReason ? (
          <div className="mt-2 rounded bg-amber-500/10 px-1.5 py-1 text-[10px] leading-snug text-amber-300">
            {modeReason}
          </div>
        ) : null}

        {navState?.gnssAnomaly ? (
          <div className="mt-2 rounded border border-red-500/40 bg-red-500/15 px-1.5 py-1 text-[10px] leading-snug text-red-200">
            <span className="font-semibold uppercase tracking-wide">GNSS anomaly detected</span>
            <br />
            <span className="font-mono">{navState.gnssAnomaly.message}</span>
            <br />
            <span className="text-red-300/70">
              Advisory only — the estimate is unchanged.
            </span>
          </div>
        ) : null}

        {navState?.lastTurn ? (
          <div className="mt-2 rounded bg-white/5 px-1.5 py-1 text-[10px] leading-snug text-neutral-300">
            last turn —{' '}
            <span className="font-mono">
              {navState.lastTurn.label} @ {formatClock(navState.lastTurn.t)}
            </span>
          </div>
        ) : null}

        {lastDrift ? (
          <div className="mt-2 rounded bg-white/5 px-1.5 py-1 text-[10px] leading-snug text-neutral-300">
            last recovery — <span className="font-mono">{lastDrift.message}</span>
          </div>
        ) : null}

        {error ? <div className="mt-1 text-[11px] text-amber-400">{error}</div> : null}

        <div className="tabular mt-2.5 border-t border-white/[0.07] pt-2 font-mono text-[10px] leading-relaxed text-neutral-500">
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
        </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Session-elapsed time as mm:ss.
 *
 * The guide's mock-up shows a wall clock — "@ 12:04:33". Sample timestamps are
 * milliseconds since the source started, not epoch, so formatting one as a
 * time of day would print a number that looks authoritative and means nothing
 * (and would be flatly wrong on a replayed log). Elapsed time is what the
 * event log is stamped with, so the two can be read against each other.
 */
function formatClock(tMs: number): string {
  if (!Number.isFinite(tMs) || tMs < 0) return '--:--';
  const total = Math.floor(tMs / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-neutral-500">{label}</span>
      <span className={accent ? 'text-orange-300' : 'text-neutral-100'}>{value}</span>
    </div>
  );
}
