'use client';

import {
  DEMO_SCRIPT,
  DEMO_TOTAL_MS,
  formatDemoClock,
  type DemoPosition,
} from '@/lib/demoScript';

interface DemoBarProps {
  running: boolean;
  elapsedMs: number;
  position: DemoPosition;
  onStart: () => void;
  onReset: () => void;
  onStop: () => void;
}

const PHASE_COLORS: Record<string, string> = {
  GNSS: '#22c55e',
  OUTAGE: '#f97316',
  RECOVERY: '#3b82f6',
  DONE: '#a1a1aa',
};

/**
 * The scripted-demo banner.
 *
 * Two jobs, and the second is the important one. It saves the presenter
 * hunting for buttons — and it states, on screen, that the outage is triggered
 * by the script rather than by a tunnel. A judge who works that out for
 * themselves stops believing the rest of the screen; a judge who is told it up
 * front gets a system that is candid about its own staging.
 */
export default function DemoBar({
  running,
  elapsedMs,
  position,
  onStart,
  onReset,
  onStop,
}: DemoBarProps) {
  if (!running) {
    return (
      <button
        type="button"
        data-tour="demo"
        onClick={onStart}
        className="rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 backdrop-blur transition hover:bg-emerald-500/25"
      >
        ▶ Demo
      </button>
    );
  }

  const color = PHASE_COLORS[position.phase.kind] ?? '#a1a1aa';

  return (
    <div className="pointer-events-auto w-[min(92vw,26rem)] rounded-xl border border-white/15 bg-black/85 p-2.5 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>
          {position.phase.label}
        </span>
        <span className="tabular ml-auto font-mono text-[11px] text-neutral-400">
          {formatDemoClock(elapsedMs)} / {formatDemoClock(DEMO_TOTAL_MS)}
        </span>
      </div>

      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full transition-[width] duration-200"
          style={{ width: `${position.progress * 100}%`, backgroundColor: color }}
        />
      </div>

      <p className="mt-1.5 text-[10.5px] leading-snug text-neutral-300">
        {position.phase.note}
      </p>

      {/* Golden Rule #8, on screen and unprompted. */}
      <p className="mt-1 text-[9.5px] leading-snug text-amber-300/80">
        Scripted run on the simulator. The outage at{' '}
        {formatDemoClock(DEMO_SCRIPT.find((p) => p.kind === 'OUTAGE')?.atMs ?? 0)} is triggered
        by this script, not by a tunnel — the physics and the estimate are real, the timing is
        ours.
      </p>

      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-white/15 px-2 py-1 text-[10px] text-neutral-200 transition hover:bg-white/10"
        >
          Restart
        </button>
        <button
          type="button"
          onClick={onStop}
          className="rounded border border-white/15 px-2 py-1 text-[10px] text-neutral-400 transition hover:bg-white/10"
        >
          Exit demo
        </button>
      </div>
    </div>
  );
}
