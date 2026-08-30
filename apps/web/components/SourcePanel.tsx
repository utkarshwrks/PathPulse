'use client';

import { useState } from 'react';
import type { RouteKey, SourceKind } from '@/hooks/useSensorSource';
import { ROUTES } from '@/hooks/useSensorSource';

interface SourcePanelProps {
  kind: SourceKind;
  routeKey: RouteKey;
  isRunning: boolean;
  inOutage: boolean;
  progress: number;
  imuHz: number;
  gnssHz: number;
  recordedCount: number;
  onKindChange: (k: SourceKind) => void;
  onRouteChange: (r: RouteKey) => void;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSpeed: (rate: number) => void;
  onOutage: () => void;
  onDownload: () => void;
}

/**
 * Development control panel for the sensor source.
 *
 * The point of Phase 2 is that development stops needing a car, a tunnel or
 * even a GPS fix: pick simulation, press play, and the whole pipeline runs at
 * up to 5x. Phase 5 turns this into the demo HUD.
 */
export default function SourcePanel(props: SourcePanelProps) {
  const [speed, setSpeed] = useState(1);
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute bottom-4 left-3 z-20 rounded-lg border border-white/15 bg-black/75 px-3 py-2 text-xs text-neutral-200 backdrop-blur"
      >
        Source ▲
      </button>
    );
  }

  return (
    <div className="absolute bottom-4 left-3 z-20 w-[min(92vw,20rem)] rounded-xl border border-white/10 bg-black/80 p-3 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
          Sensor source
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ▼
        </button>
      </div>

      <select
        value={props.kind}
        onChange={(e) => props.onKindChange(e.target.value as SourceKind)}
        className="mb-2 w-full rounded-lg border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
      >
        <option value="simulation">Simulation</option>
        <option value="live">Live browser sensors</option>
        <option value="replay">Replay — demo.jsonl (backup)</option>
      </select>

      {props.kind === 'replay' ? (
        <p className="mb-2 rounded bg-sky-500/10 px-2 py-1.5 text-[10px] leading-snug text-sky-300">
          Recorded log with the outage already in it — press play and the whole
          sequence runs with nothing else to trigger. Announce it as a replay:
          it is one, and saying so first is what keeps the rest credible.
        </p>
      ) : null}

      {props.kind === 'simulation' ? (
        <>
          <select
            value={props.routeKey}
            onChange={(e) => props.onRouteChange(e.target.value as RouteKey)}
            className="mb-2 w-full rounded-lg border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200"
          >
            {(Object.keys(ROUTES) as RouteKey[]).map((k) => (
              <option key={k} value={k}>
                {ROUTES[k].label}
              </option>
            ))}
          </select>

          <div className="mb-2 flex gap-1.5">
            <Btn onClick={props.isRunning ? props.onPause : props.onPlay} primary>
              {props.isRunning ? 'Pause' : 'Play'}
            </Btn>
            <Btn onClick={props.onReset}>Reset</Btn>
            <Btn onClick={props.onOutage} danger={!props.inOutage}>
              {props.inOutage ? 'In outage' : 'GNSS loss'}
            </Btn>
          </div>

          <label className="mb-2 block">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">
              Speed {speed.toFixed(1)}×
            </span>
            <input
              type="range"
              min={1}
              max={5}
              step={0.5}
              value={speed}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSpeed(v);
                props.onSpeed(v);
              }}
              className="w-full accent-neutral-300"
            />
          </label>

          <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-neutral-400 transition-[width] duration-300"
              style={{ width: `${Math.min(100, props.progress * 100)}%` }}
            />
          </div>
        </>
      ) : null}

      {/*
        ★ THE BACKUP NEEDS TRANSPORT CONTROLS OF ITS OWN ★
        Play, Pause and Reset used to live inside the `simulation` branch, and
        the fallback text described the live sensors. So selecting Replay gave
        you a loaded backup log, an explanation of DeviceMotion, and no way to
        start it — the feature existed and could not be used, on the run where
        everything else has already gone wrong.
      */}
      {props.kind === 'replay' ? (
        <>
          <div className="mb-2 flex gap-1.5">
            <Btn onClick={props.isRunning ? props.onPause : props.onPlay} primary>
              {props.isRunning ? 'Pause' : 'Play'}
            </Btn>
            <Btn onClick={props.onReset}>Restart</Btn>
          </div>
          <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-sky-400 transition-[width] duration-300"
              style={{ width: `${Math.min(100, props.progress * 100)}%` }}
            />
          </div>
        </>
      ) : null}

      {props.kind === 'live' ? (
        <p className="mb-2 text-[11px] leading-relaxed text-neutral-500">
          Uses DeviceMotion and Geolocation. Both need a secure context; press Play from a
          tap so iOS grants motion access.
        </p>
      ) : null}

      {props.kind === 'live' ? (
        <Btn onClick={props.isRunning ? props.onPause : props.onPlay} primary>
          {props.isRunning ? 'Stop' : 'Start'}
        </Btn>
      ) : null}

      <div className="tabular mt-2 border-t border-white/10 pt-2 font-mono text-[10px] text-neutral-500">
        IMU <span className="text-neutral-300">{props.imuHz.toFixed(1)} Hz</span>
        {'  ·  '}
        GNSS <span className="text-neutral-300">{props.gnssHz.toFixed(2)} Hz</span>
        {'  ·  '}
        rec <span className="text-neutral-300">{props.recordedCount}</span>
      </div>

      {props.recordedCount > 0 ? (
        <button
          type="button"
          onClick={props.onDownload}
          className="mt-1.5 w-full rounded-lg border border-white/10 px-2 py-1 text-[11px] text-neutral-300 hover:bg-white/5"
        >
          Download recording (.jsonl)
        </button>
      ) : null}
    </div>
  );
}

function Btn({
  children,
  onClick,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  const base =
    'flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition border w-full';
  const style = primary
    ? 'bg-neutral-100 text-neutral-900 border-transparent hover:bg-white'
    : danger
      ? 'border-orange-500/40 text-orange-300 hover:bg-orange-500/10'
      : 'border-white/10 text-neutral-300 hover:bg-white/5';
  return (
    <button type="button" onClick={onClick} className={`${base} ${style}`}>
      {children}
    </button>
  );
}
