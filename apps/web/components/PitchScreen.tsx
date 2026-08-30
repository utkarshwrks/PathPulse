'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  COMPLIANCE,
  PITCH_SLIDES,
  STATUS_LABEL,
  complianceTally,
  type ComplianceStatus,
} from '@/lib/pitch';
import type { BenchmarkData } from './Benchmarks';

interface PitchScreenProps {
  onClose: () => void;
  /** Injected by tests; production fetches the generated table. */
  data?: BenchmarkData | null;
}

const STATUS_STYLE: Record<ComplianceStatus, string> = {
  DONE: 'bg-emerald-500/20 text-emerald-300',
  PARTIAL: 'bg-amber-500/20 text-amber-300',
  PART_B: 'bg-sky-500/20 text-sky-300',
};

/**
 * The pitch deck, inside the app.
 *
 * In the app rather than on a laptop for one reason: switching devices in the
 * middle of a demo breaks the thread, and the slide a judge most wants to see
 * — the ablation table — is generated from the same file the app already
 * ships. A deck in Keynote goes stale the moment anything is re-measured.
 *
 * Arrow keys, because that is what a presenter's thumb reaches for.
 */
export default function PitchScreen({ onClose, data: injected }: PitchScreenProps) {
  const [index, setIndex] = useState(0);
  const [data, setData] = useState<BenchmarkData | null>(injected ?? null);

  useEffect(() => {
    if (injected !== undefined) return;
    let cancelled = false;
    fetch('benchmarks/benchmarks.json')
      .then((r) => (r.ok ? (r.json() as Promise<BenchmarkData>) : Promise.reject(new Error())))
      .then((d) => !cancelled && setData(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [injected]);

  const go = useCallback((delta: number) => {
    setIndex((i) => Math.max(0, Math.min(PITCH_SLIDES.length - 1, i + delta)));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === ' ') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  const slide = PITCH_SLIDES[index]!;
  const tally = complianceTally();

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#080b10] text-neutral-100">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="text-[10px] uppercase tracking-widest text-neutral-500">
          PathPulse · SIH26168 · Team Avinya
        </span>
        <div className="flex items-center gap-2">
          <span className="tabular font-mono text-[11px] text-neutral-500">
            {index + 1} / {PITCH_SLIDES.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/15 px-2 py-1 text-[11px] text-neutral-300 transition hover:bg-white/10"
          >
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <h1 className="text-xl font-semibold leading-tight">{slide.title}</h1>
        <p className="mt-1 text-[12px] text-neutral-400">{slide.subtitle}</p>

        <ul className="mt-3 space-y-1.5">
          {slide.points.map((p) => (
            <li key={p} className="flex gap-2 text-[12px] leading-snug text-neutral-300">
              <span className="mt-[3px] shrink-0 text-neutral-600">▪</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>

        {slide.visual === 'architecture' ? <Architecture /> : null}
        {slide.visual === 'ml' ? <MlBlock /> : null}
        {slide.visual === 'ablation' ? <Ablation data={data} /> : null}
        {slide.visual === 'compliance' ? (
          <div className="mt-4">
            <p className="mb-2 font-mono text-[11px] text-neutral-500">
              {tally.DONE} done · {tally.PARTIAL} partial · {tally.PART_B} Part B
            </p>
            <div className="space-y-1.5">
              {COMPLIANCE.map((row) => (
                <div
                  key={row.requirement}
                  className="rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[11.5px] font-medium text-neutral-200">
                      {row.requirement}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${STATUS_STYLE[row.status]}`}
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10.5px] leading-snug text-neutral-400">
                    {row.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-4 py-2">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          className="rounded border border-white/15 px-3 py-1.5 text-[11px] text-neutral-200 transition hover:bg-white/10 disabled:opacity-30"
        >
          ← Back
        </button>
        <span className="text-[10px] text-neutral-600">arrow keys</span>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={index === PITCH_SLIDES.length - 1}
          className="rounded border border-white/15 px-3 py-1.5 text-[11px] text-neutral-200 transition hover:bg-white/10 disabled:opacity-30"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function Architecture() {
  const rows = [
    ['GNSS', 'position, speed, accuracy — when there is sky'],
    ['IMU', 'accel + gyro, resolved against measured gravity'],
    ['Filters', 'median despike, low-pass, stationarity'],
    ['Constraints', 'NHC · ZUPT · ZARU · speed clamp · road snap'],
    ['AI', 'IO-VNBD speed model, on-device'],
    ['Fusion', 'shadow-mode DR, bounded-rate recovery'],
  ];
  return (
    <div className="mt-4 space-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3 rounded bg-white/[0.03] px-2.5 py-1.5">
          <span className="w-24 shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-sky-300">
            {k}
          </span>
          <span className="text-[11px] text-neutral-300">{v}</span>
        </div>
      ))}
      <p className="pt-1 text-[10px] text-neutral-500">
        nav-core is pure TypeScript with no browser or Node APIs — the same code runs in the
        phone, in headless replay, and in the Part B edge engine.
      </p>
    </div>
  );
}

function MlBlock() {
  return (
    <div className="mt-4 rounded border border-white/10 bg-white/[0.03] p-3">
      <p className="font-mono text-[11px] text-neutral-300">
        Open <span className="text-sky-300">Debug → SENSORS</span> during the demo: the model’s
        size, its measured inference latency and its live prediction are all on screen.
      </p>
      <p className="mt-2 text-[10.5px] leading-snug text-neutral-500">
        The position plot the screening asks for is generated by the training pipeline into
        <span className="font-mono"> ml/results/position_plot.png</span>, from the model’s own
        predictions against IO-VNBD ground truth.
      </p>
    </div>
  );
}

function Ablation({ data }: { data: BenchmarkData | null }) {
  if (!data) {
    return (
      <p className="mt-4 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-300">
        No benchmark table bundled — run <span className="font-mono">pnpm ablation</span>. The
        slide will not invent numbers.
      </p>
    );
  }
  return (
    <div className="mt-4">
      <div className="overflow-x-auto">
        <table className="tabular w-full font-mono text-[10.5px]">
          <thead>
            <tr className="text-neutral-500">
              <th className="py-1 pr-2 text-left font-normal">config</th>
              <th className="py-1 pr-2 text-right font-normal">mean %</th>
              <th className="py-1 pr-2 text-right font-normal">median %</th>
              <th className="py-1 text-right font-normal">p90 %</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const shipped = r.config === 'full';
              return (
                <tr
                  key={r.config}
                  className={shipped ? 'text-emerald-300' : 'text-neutral-300'}
                >
                  <td className="py-0.5 pr-2">{r.config}</td>
                  <td className="py-0.5 pr-2 text-right">{r.meanDriftPct.toFixed(1)}</td>
                  <td className="py-0.5 pr-2 text-right">{r.medianDriftPct.toFixed(1)}</td>
                  <td className="py-0.5 text-right">{r.p90DriftPct.toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-amber-300/80">
        Every log is simulated. These numbers measure the estimator against a physics model,
        not against a road — no real drive log exists yet.
      </p>
    </div>
  );
}
