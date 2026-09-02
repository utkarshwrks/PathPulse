'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MODE_COLORS, MODE_LABELS } from '@/config/modes';
import DownloadCta from './DownloadCta';
import type { SceneConstraints, SceneStatus } from './EngineScene';

/**
 * The hero: a live engine view with a real HUD wrapped around it.
 *
 * three.js and the engine are pulled in only when this renders, and never on
 * the server — the scene needs a canvas, and the app route must not pay for
 * any of it. `ssr: false` is load-bearing rather than defensive.
 */
const EngineScene = dynamic(() => import('./EngineScene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <span className="text-[11px] tracking-wide text-neutral-600">
        starting the navigation engine…
      </span>
    </div>
  ),
});

const CAPTIONS: Record<SceneStatus['phase'], { title: string; body: string }> = {
  GNSS: {
    title: 'Satellites available',
    body: 'The estimate follows the fix — and dead reckoning is already running underneath it, reset by every fix. That is why the switch, when it comes, costs nothing.',
  },
  OUTAGE: {
    title: 'Signal gone — this is dead reckoning',
    body: 'No satellites. Position now comes from the phone’s own inertial sensors, bounded by vehicle physics and road geometry. The shaded ellipse is the engine’s own uncertainty, stretching along the road while staying narrow across it.',
  },
  RECOVERY: {
    title: 'Satellites back — sliding, not jumping',
    body: 'The gap between the two paths was the drift. The marker eases onto truth at a bounded rate, because a teleporting dot reads as a bug however right the mathematics is.',
  },
};

const CONSTRAINT_INFO: Array<{
  key: keyof SceneConstraints;
  label: string;
  hint: string;
}> = [
  { key: 'nhc', label: 'NHC', hint: 'A car cannot slide sideways. Removing it is worth 59% drift against 29% — the single biggest component.' },
  { key: 'zupt', label: 'ZUPT / ZARU', hint: 'A stopped vehicle has zero speed and is not turning. Off, sensor noise integrates into imaginary travel at every red light.' },
  { key: 'roadSnap', label: 'Road snap', hint: 'Correct sideways onto the matched road. Off, cross-track error is bounded only by NHC.' },
  { key: 'accelHighPass', label: 'Accel high-pass', hint: 'Removes the slow mean of forward acceleration — the tilt error that makes dead-reckoned speed run away.' },
];

export default function LiveHero() {
  const [s, setS] = useState<SceneStatus | null>(null);
  const [constraints, setConstraints] = useState<SceneConstraints>({
    nhc: true,
    zupt: true,
    roadSnap: true,
    accelHighPass: true,
  });
  const onStatus = useCallback((next: SceneStatus) => setS(next), []);
  const anyOff = Object.values(constraints).some((v) => !v);

  /*
   * Hero scroll progress, 0 at the top and 1 once the hero has left.
   *
   * Kept in a ref and never in state: this updates every scroll frame, and
   * re-rendering the hero at 60 Hz to move a camera would be the single
   * heaviest thing on the page. The render loop reads it directly.
   */
  const scrollRef = useRef(0);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scrollRef.current = Math.min(1, window.scrollY / Math.max(window.innerHeight, 1));
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const mode = s?.mode ?? 'INITIALIZING';
  const color = MODE_COLORS[mode];
  const caption = CAPTIONS[s?.phase ?? 'GNSS'];

  return (
    <header className="relative overflow-hidden border-b border-white/[0.06]">
      <div className="pp-splash-glow pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2" />

      <div className="relative mx-auto max-w-6xl px-6 pb-14 pt-16 sm:pt-20">
        <p className="pp-fade text-[10.5px] font-medium uppercase tracking-[0.2em] text-sky-400/80">
          Smart India Hackathon 2026 · SIH26168 · ISRO
        </p>
        <h1 className="pp-fade pp-delay-1 mt-5 max-w-3xl text-[2.5rem] font-bold leading-[1.04] tracking-tight text-white sm:text-[3.5rem]">
          Navigation that does not stop
          <br />
          <span className="text-sky-400">when the satellites do.</span>
        </h1>
        <p className="pp-fade pp-delay-2 mt-6 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          In a tunnel, a basement, or an urban canyon, GNSS disappears and the
          blue dot freezes. PathPulse keeps it moving from the phone&rsquo;s own
          inertial sensors — no internet, no cloud, no hardware in the vehicle.
        </p>

        {/* --------------------------------------------------- the live view */}
        <div className="pp-fade pp-delay-3 mt-10 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#070a10]">
          <div className="relative h-[420px] w-full sm:h-[560px]">
            <EngineScene
              onStatus={onStatus}
              constraints={constraints}
              scrollRef={scrollRef}
            />

            {/* HUD, over the canvas, reading the same state the app's does. */}
            <div className="pointer-events-none absolute left-3 top-3 sm:left-4 sm:top-4">
              <div className="pp-surface relative overflow-hidden px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                      mode === 'DEAD_RECKONING' ? 'pp-beacon' : ''
                    }`}
                    style={{ backgroundColor: color, boxShadow: `0 0 12px ${color}` }}
                  />
                  <span
                    className="text-[12px] font-semibold uppercase tracking-[0.14em]"
                    style={{ color }}
                  >
                    {MODE_LABELS[mode]}
                  </span>
                </div>
                <div className="mt-2.5 flex items-baseline gap-1.5">
                  <span className="tabular font-mono text-[2rem] font-semibold leading-none text-white">
                    {(s?.speedKph ?? 0).toFixed(0)}
                  </span>
                  <span className="text-[11px] text-neutral-500">km/h</span>
                </div>
                <div className="tabular mt-2.5 grid w-[150px] grid-cols-2 gap-x-4 border-t border-white/[0.07] pt-2 font-mono text-[10.5px] text-neutral-400">
                  <Row k="drift" v={`${(s?.driftM ?? 0).toFixed(1)} m`} />
                  <Row k="dist" v={`${(s?.distanceM ?? 0).toFixed(0)} m`} />
                  <Row k="no gnss" v={`${(s?.sinceGnssS ?? 0).toFixed(1)} s`} />
                  <Row
                    k="uncert"
                    v={`${(s?.alongM ?? 0).toFixed(0)}/${(s?.crossM ?? 0).toFixed(0)}`}
                  />
                </div>
              </div>
            </div>

            <div className="pointer-events-none absolute bottom-3 right-3 flex gap-3 text-[10px] text-neutral-500 sm:bottom-4 sm:right-4">
              <Legend swatch="#22c55e" label="GNSS" />
              <Legend swatch="#f97316" label="dead reckoning" />
              <Legend swatch="#3b82f6" label="recovering" />
              <Legend swatch="#4b5b70" label="truth (withheld)" dashed />
            </div>
          </div>

          {/* Caption tracks the phase, so the picture is never unexplained. */}
          <div className="border-t border-white/[0.07] bg-[#080b11] px-5 py-4">
            <h2 className="text-[13px] font-semibold" style={{ color }}>
              {caption.title}
            </h2>
            <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-neutral-500">
              {caption.body}
            </p>
          </div>

          {/*
            ★ BREAK IT YOURSELF ★
            The strongest evidence this project has is not a number, it is that
            the estimate degrades in the specific way the physics predicts the
            moment a constraint is removed — and recovers when it is put back.
            A recorded animation never breaks on request. Putting the switches
            on the landing page hands that proof to the reader instead of
            asking them to take it on trust.
          */}
          <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.07] bg-[#070a10] px-5 py-3.5">
            <span className="mr-1 text-[10.5px] uppercase tracking-wide text-neutral-500">
              Break it live
            </span>
            {CONSTRAINT_INFO.map(({ key, label, hint }) => (
              <button
                key={key}
                type="button"
                title={hint}
                aria-pressed={constraints[key]}
                onClick={() =>
                  setConstraints((c) => ({ ...c, [key]: !c[key] }))
                }
                className={`pp-press rounded-lg border px-2.5 py-1.5 font-mono text-[11px] ${
                  constraints[key]
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-red-400/40 bg-red-500/10 text-red-300 line-through'
                }`}
              >
                {label}
              </button>
            ))}
            <span
              className={`ml-auto text-[11px] transition-opacity ${
                anyOff ? 'text-amber-300 opacity-100' : 'opacity-0'
              }`}
            >
              constraint removed — watch the estimate leave the road
            </span>
          </div>
        </div>

        {/*
          ★ THE CLAIM THAT MAKES THE HERO WORTH HAVING ★
          Said directly under it, because a visitor's default assumption about
          any landing-page animation is that it is a video — and for this
          project in particular, an unexamined animation would undercut the
          one thing the whole submission argues.
        */}
        <p className="pp-fade pp-delay-4 mt-4 max-w-3xl text-[11.5px] leading-relaxed text-neutral-500">
          <span className="font-semibold text-neutral-300">
            This is not a video.
          </span>{' '}
          It is the same <code className="text-neutral-400">NavigationEngine</code>{' '}
          the Android app runs, executing in your browser against a
          deterministic simulated drive, with satellite fixes deleted for a
          60-second window exactly as our evaluation harness deletes them. The
          orange stretch is real dead reckoning, and the gap to the dashed line
          is real drift. The outage is scripted; the physics is not.
        </p>

        <div className="pp-fade pp-delay-4 mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <div className="w-full sm:w-[340px]">
            <DownloadCta variant="compact" />
          </div>
          <Link
            href="/"
            className="pp-press shrink-0 rounded-xl border border-white/12 px-5 py-3.5 text-[14px] text-neutral-300 hover:bg-white/5"
          >
            Open the browser demo
          </Link>
        </div>
      </div>
    </header>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-neutral-600">{k}</span>
      <span className="text-neutral-200">{v}</span>
    </div>
  );
}

function Legend({
  swatch,
  label,
  dashed,
}: {
  swatch: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-[2px] w-4"
        style={{
          backgroundColor: dashed ? 'transparent' : swatch,
          backgroundImage: dashed
            ? `repeating-linear-gradient(90deg, ${swatch} 0 4px, transparent 4px 7px)`
            : undefined,
        }}
      />
      {label}
    </span>
  );
}
