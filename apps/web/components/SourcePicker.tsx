'use client';

import { ROUTES, type RouteKey, type SourceKind } from '@/hooks/useSensorSource';

interface SourcePickerProps {
  kind: SourceKind;
  routeKey: RouteKey;
  isRunning: boolean;
  progress: number;
  sourceName: string;
  onPick: (kind: SourceKind) => void;
  onRouteChange: (key: RouteKey) => void;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
}

interface Choice {
  kind: SourceKind;
  icon: string;
  label: string;
  hint: string;
}

const CHOICES: readonly Choice[] = [
  {
    kind: 'live',
    icon: '📡',
    label: 'This phone',
    hint: 'Your real GPS and motion sensors. Walk around and the marker follows you.',
  },
  {
    kind: 'simulation',
    icon: '🚗',
    label: 'Simulated drive',
    hint: 'A synthetic vehicle on a real road. No car and no signal needed.',
  },
  {
    kind: 'replay',
    icon: '💾',
    label: 'Recorded run',
    hint: 'A saved drive with the outage already in it. Plays the whole story.',
  },
];

/**
 * Choosing where the data comes from.
 *
 * ★ PICKING A SOURCE STARTS IT ★
 * This used to be a dropdown, and then a separate Play button somewhere else
 * in the panel. Switching to live sensors therefore took four taps, and the
 * fourth was easy to miss — so "I chose Live and nothing happened" was the
 * commonest way to conclude the app was broken. Nobody selects a source
 * without wanting it to run. Tapping a card selects it and starts it.
 */
export default function SourcePicker({
  kind,
  routeKey,
  isRunning,
  progress,
  sourceName,
  onPick,
  onRouteChange,
  onPlay,
  onPause,
  onReset,
}: SourcePickerProps) {
  return (
    <div>
      <div className="space-y-2">
        {CHOICES.map((c) => {
          const active = c.kind === kind;
          return (
            <button
              key={c.kind}
              type="button"
              onClick={() => onPick(c.kind)}
              className={`flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition ${
                active
                  ? 'border-sky-400/50 bg-sky-500/10'
                  : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.06]'
              }`}
            >
              <span className="mt-0.5 w-5 shrink-0 text-center text-base leading-none">
                {c.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-[13px] font-semibold ${
                    active ? 'text-sky-200' : 'text-neutral-100'
                  }`}
                >
                  {c.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">
                  {c.hint}
                </span>
              </span>
              {active ? (
                <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                  {isRunning ? 'running' : 'selected'}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {kind === 'simulation' ? (
        <label className="mt-3 block">
          <span className="text-[10px] uppercase tracking-widest text-neutral-500">Route</span>
          <select
            value={routeKey}
            onChange={(e) => onRouteChange(e.target.value as RouteKey)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-neutral-900 px-2 py-2 text-xs text-neutral-200"
          >
            {(Object.keys(ROUTES) as RouteKey[]).map((k) => (
              <option key={k} value={k}>
                {ROUTES[k].label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {kind === 'replay' ? (
        <p className="mt-3 rounded-lg bg-sky-500/10 px-3 py-2 text-[11px] leading-snug text-sky-300">
          Announce this as a replay. It is one — a recorded log, not a live run,
          and saying so first is what keeps the rest credible.
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={isRunning ? onPause : onPlay}
          className="flex-1 rounded-xl bg-sky-500 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-sky-400"
        >
          {isRunning ? 'Pause' : 'Start'}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded-xl border border-white/15 px-4 py-2.5 text-[13px] text-neutral-200 transition hover:bg-white/10"
        >
          Restart
        </button>
      </div>

      {kind !== 'live' ? (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-neutral-400 transition-[width] duration-300"
            style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
          />
        </div>
      ) : null}

      <p className="mt-3 border-t border-white/10 pt-2 font-mono text-[10px] text-neutral-500">
        {sourceName || '—'}
      </p>
    </div>
  );
}
