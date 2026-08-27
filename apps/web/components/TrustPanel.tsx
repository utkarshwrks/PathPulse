'use client';

import { useState } from 'react';
import type { NavEvent, SensorSample, SessionSummary } from '@pathpulse/nav-core';
import type { EngineControls, EngineDiagnostics } from '@/hooks/useNavigationEngine';

interface TrustPanelProps {
  sample: SensorSample | null;
  diagnostics: EngineDiagnostics;
  stats: SessionSummary;
  events: NavEvent[];
  controls: EngineControls;
  onControlsChange: (patch: Partial<EngineControls>) => void;
  onExportEvents: () => void;
  imuHz: number;
  gnssHz: number;
  updateHz: number;
}

type Tab = 'sensors' | 'constraints' | 'events' | 'stats';

/**
 * Phase 5B/5C/5D/5F — the anti-fake panel.
 *
 * ★ THIS IS WHERE CREDIBILITY IS WON ★
 * A judge's default assumption is that the demo is playing back canned data.
 * Nothing in the HUD can disprove that, because a scripted animation can show
 * any numbers it likes. These four tabs can:
 *
 *  - SENSORS: raw values, updating every frame. Real sensor data is always
 *    slightly dirty — a phone flat on a table still twitches by 0.01-0.05.
 *    Canned data is suspiciously smooth.
 *  - CONSTRAINTS: live toggles. A fake demo never breaks. Being able to switch
 *    NHC off mid-outage and watch the estimate wander, then switch it back, is
 *    the single most convincing thing in the whole build.
 *  - EVENTS: every mode change with its reason and a millisecond timestamp.
 *    An animation cannot explain itself.
 *  - STATS: measured drift from real recoveries, not our own error model.
 *
 * Tabs rather than four stacked panels because this has to be legible on a
 * phone held up in front of a judge, not just on a laptop.
 */
export default function TrustPanel({
  sample,
  diagnostics,
  stats,
  events,
  controls,
  onControlsChange,
  onExportEvents,
  imuHz,
  gnssHz,
  updateHz,
}: TrustPanelProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('sensors');

  return (
    <div className="absolute right-3 top-14 z-10 w-[min(92vw,21rem)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/75 px-3 py-2 text-xs font-medium text-neutral-200 backdrop-blur transition hover:bg-black/90"
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            diagnostics.isStationary ? 'bg-sky-400' : 'bg-emerald-400'
          }`}
        />
        Debug
        <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <div className="mt-1.5 overflow-hidden rounded-xl border border-white/10 bg-black/85 backdrop-blur-md">
          <div className="flex border-b border-white/10 text-[10px] font-medium">
            {(
              [
                ['sensors', 'SENSORS'],
                ['constraints', 'CONSTRAINTS'],
                ['events', 'EVENTS'],
                ['stats', 'STATS'],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex-1 px-2 py-2 tracking-wide transition ${
                  tab === key
                    ? 'bg-white/10 text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="max-h-[52vh] overflow-y-auto px-3 py-2.5">
            {tab === 'sensors' ? (
              <SensorsTab
                sample={sample}
                diagnostics={diagnostics}
                imuHz={imuHz}
                gnssHz={gnssHz}
                updateHz={updateHz}
              />
            ) : null}
            {tab === 'constraints' ? (
              <ConstraintsTab controls={controls} onChange={onControlsChange} />
            ) : null}
            {tab === 'events' ? (
              <EventsTab events={events} onExport={onExportEvents} />
            ) : null}
            {tab === 'stats' ? <StatsTab stats={stats} diagnostics={diagnostics} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- 5B */

function SensorsTab({
  sample,
  diagnostics,
  imuHz,
  gnssHz,
  updateHz,
}: {
  sample: SensorSample | null;
  diagnostics: EngineDiagnostics;
  imuHz: number;
  gnssHz: number;
  updateHz: number;
}) {
  const imu = sample?.imu;
  const gnss = sample?.gnss;

  return (
    <div className="tabular space-y-2.5 font-mono text-[10.5px] text-neutral-300">
      <Group title="raw imu">
        <Axis label="ACCEL" x={imu?.ax} y={imu?.ay} z={imu?.az} unit="m/s²" digits={2} />
        <Axis label="GYRO" x={imu?.gx} y={imu?.gy} z={imu?.gz} unit="rad/s" digits={4} />
      </Group>

      <Group title="rates (measured)">
        <Row k="IMU" v={`${imuHz.toFixed(1)} Hz`} />
        <Row k="GNSS" v={`${gnssHz.toFixed(2)} Hz`} />
        <Row k="ENGINE OUT" v={`${updateHz.toFixed(1)} Hz`} warn={updateHz > 0 && updateHz < 10} />
        <Row
          k="FIX INTERVAL"
          v={
            diagnostics.observedFixIntervalMs === null
              ? 'learning…'
              : `${(diagnostics.observedFixIntervalMs / 1000).toFixed(1)} s`
          }
        />
        <Row
          k="LOSS TIMEOUT"
          v={`${(diagnostics.effectiveNoFixTimeoutMs / 1000).toFixed(1)} s`}
        />
      </Group>

      <Group title="gnss">
        <Row k="ACCURACY" v={gnss ? `${gnss.accuracyM.toFixed(1)} m` : '—'} />
        <Row k="SPEED" v={gnss?.speedMps != null ? `${gnss.speedMps.toFixed(1)} m/s` : '—'} />
        <Row k="SATELLITES" v={gnss?.satCount != null ? String(gnss.satCount) : 'n/a'} />
        <Row k="MEAN C/N0" v={gnss?.meanCn0 != null ? `${gnss.meanCn0.toFixed(1)} dB-Hz` : 'n/a'} />
      </Group>

      <Group title="estimator">
        <Row
          k="STATIONARY"
          v={diagnostics.isStationary ? 'YES' : 'NO'}
          accent={diagnostics.isStationary}
        />
        <Row
          k="ACCEL VAR"
          v={Number.isFinite(diagnostics.accelVariance) ? diagnostics.accelVariance.toFixed(4) : '—'}
        />
        <Row k="ATTITUDE" v={diagnostics.attitudeSettled ? `${(diagnostics.attitudeQuality * 100).toFixed(0)}%` : 'settling…'} />
        <Row k="ACCEL BIAS" v={vec(diagnostics.accelBias, 3)} />
        <Row k="GYRO BIAS" v={vec(diagnostics.gyroBias, 4)} />
        <Row
          k="FWD BIAS"
          v={`${diagnostics.forwardBiasMps2.toFixed(3)} (${diagnostics.forwardBiasObservations})`}
        />
        <Row k="UNAIDED" v={`${(diagnostics.unaidedMs / 1000).toFixed(1)} s`} />
        <Row k="ZUPT / ZARU" v={`${diagnostics.zuptTriggers} / ${diagnostics.zaruTriggers}`} />
      </Group>

      <p className="pt-0.5 text-[9.5px] leading-snug text-neutral-500">
        Satellite count and C/N0 need the native GnssStatus API — Phase 15. Shown
        as n/a rather than faked.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- 5C */

const TOGGLES: Array<{ key: keyof EngineControls; label: string; hint: string }> = [
  { key: 'nhc', label: 'NHC', hint: 'A vehicle cannot slide sideways. Kills cross-track drift.' },
  { key: 'zupt', label: 'ZUPT', hint: 'Stopped means speed exactly zero, and free accel calibration.' },
  { key: 'zaru', label: 'ZARU', hint: 'Stopped means the gyro reading is pure bias. Stops heading drift.' },
  { key: 'forwardBias', label: 'Forward bias', hint: 'Learns mount tilt from GNSS Doppler, applies it in the tunnel.' },
  { key: 'speedClamp', label: 'Speed clamp', hint: 'Plausibility ceiling plus decay of a stale unaided estimate.' },
  { key: 'lowPass', label: 'Low-pass filter', hint: 'Removes engine and road vibration before integration.' },
  { key: 'medianFilter', label: 'Median filter', hint: 'Rejects pothole spikes.' },
  { key: 'adaptiveTimeout', label: 'Adaptive GNSS timeout', hint: 'Track the receiver’s real fix rate instead of assuming 1 Hz.' },
];

function ConstraintsTab({
  controls,
  onChange,
}: {
  controls: EngineControls;
  onChange: (patch: Partial<EngineControls>) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="pb-1.5 text-[9.5px] leading-snug text-neutral-500">
        Live — effective on the next sample, no restart. Switch one off during an
        outage and watch the estimate degrade.
      </p>

      {TOGGLES.map((t) => (
        <Toggle
          key={t.key}
          label={t.label}
          hint={t.hint}
          checked={Boolean(controls[t.key])}
          onChange={(v) => onChange({ [t.key]: v } as Partial<EngineControls>)}
        />
      ))}

      <div className="mt-2 border-t border-white/10 pt-2">
        <Toggle
          label="Walking Mode"
          hint="Clamps speed to 3 m/s so the engine can be demonstrated on foot."
          checked={controls.walkingMode}
          onChange={(v) => onChange({ walkingMode: v })}
        />
      </div>

      <p className="pt-2 text-[9.5px] leading-snug text-neutral-500">
        Road snapping is not built yet (Phase 6D), so it has no toggle. It will
        appear here rather than being shown as a switch that does nothing.
      </p>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left transition hover:bg-white/5"
    >
      <span
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? 'bg-emerald-500/80' : 'bg-white/15'
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-3' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-medium text-neutral-100">{label}</span>
        <span className="block text-[9.5px] leading-snug text-neutral-500">{hint}</span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- 5D */

const EVENT_COLORS: Record<string, string> = {
  MODE_CHANGE: 'text-sky-300',
  GNSS_LOST: 'text-orange-300',
  DRIFT_MEASURED: 'text-amber-300',
  RECOVERY_COMPLETE: 'text-emerald-300',
  ZUPT_TRIGGER: 'text-neutral-400',
  ZARU_TRIGGER: 'text-neutral-400',
  WARNING: 'text-red-400',
};

function EventsTab({ events, onExport }: { events: NavEvent[]; onExport: () => void }) {
  // Newest first: during a demo the interesting line is the one that just
  // happened, and scrolling to find it wastes the moment.
  const recent = [...events].reverse().slice(0, 120);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[9.5px] text-neutral-500">{events.length} events</span>
        <button
          type="button"
          onClick={onExport}
          className="rounded border border-white/15 px-2 py-1 text-[10px] text-neutral-300 transition hover:bg-white/10"
        >
          Export JSON
        </button>
      </div>

      {recent.length === 0 ? (
        <p className="py-3 text-center text-[10px] text-neutral-600">no events yet</p>
      ) : (
        <ul className="tabular space-y-0.5 font-mono text-[9.5px] leading-snug">
          {recent.map((e, i) => (
            <li key={`${e.t}-${i}`} className="flex gap-1.5">
              <span className="shrink-0 text-neutral-600">{formatT(e.t)}</span>
              <span className={`shrink-0 ${EVENT_COLORS[e.type] ?? 'text-neutral-400'}`}>
                {e.type}
              </span>
              <span className="min-w-0 break-words text-neutral-400">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 5F */

function StatsTab({
  stats,
  diagnostics,
}: {
  stats: SessionSummary;
  diagnostics: EngineDiagnostics;
}) {
  return (
    <div className="tabular space-y-2.5 font-mono text-[10.5px] text-neutral-300">
      <Group title="session">
        <Row k="DURATION" v={formatDuration(stats.durationMs)} />
        <Row k="DISTANCE" v={`${stats.distanceM.toFixed(0)} m`} />
        <Row k="MAX SPEED" v={`${(stats.maxSpeedMps * 3.6).toFixed(1)} km/h`} />
        <Row k="MEAN RATE" v={`${stats.meanUpdateHz.toFixed(1)} Hz`} />
      </Group>

      <Group title="outages">
        <Row k="COUNT" v={String(stats.outageCount)} />
        <Row k="TOTAL" v={formatDuration(stats.outageTotalMs)} />
        <Row k="LONGEST" v={formatDuration(stats.longestOutageMs)} />
        <Row k="ZUPT FIRED" v={String(diagnostics.zuptTriggers)} />
      </Group>

      <Group title="measured drift on recovery">
        <Row k="BEST" v={stats.bestDriftM === null ? '—' : `${stats.bestDriftM.toFixed(1)} m`} />
        <Row k="WORST" v={stats.worstDriftM === null ? '—' : `${stats.worstDriftM.toFixed(1)} m`} />
        <Row k="MEAN" v={stats.meanDriftM === null ? '—' : `${stats.meanDriftM.toFixed(1)} m`} />
      </Group>

      <p className="pt-0.5 text-[9.5px] leading-snug text-neutral-500">
        These are measured against a real fix when GNSS returned — not the
        engine’s own uncertainty model, which is what the HUD shows during an
        outage.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- shared */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-neutral-600">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v, accent, warn }: { k: string; v: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-neutral-500">{k}</span>
      <span
        className={
          warn ? 'text-amber-400' : accent ? 'text-sky-300' : 'text-neutral-100'
        }
      >
        {v}
      </span>
    </div>
  );
}

function Axis({
  label,
  x,
  y,
  z,
  unit,
  digits,
}: {
  label: string;
  x?: number;
  y?: number;
  z?: number;
  unit: string;
  digits: number;
}) {
  const f = (v?: number) =>
    v === undefined || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(digits);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="w-11 shrink-0 text-neutral-500">{label}</span>
      <span className="flex-1 text-neutral-100">
        {f(x)} {f(y)} {f(z)}
      </span>
      <span className="shrink-0 text-neutral-600">{unit}</span>
    </div>
  );
}

function vec(v: readonly number[], digits: number): string {
  return `[${v.map((n) => n.toFixed(digits)).join(', ')}]`;
}

/** Engine time is milliseconds since the source started, so show mm:ss.mmm. */
function formatT(t: number): string {
  const ms = Math.max(0, Math.floor(t));
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rem).padStart(3, '0')}`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
