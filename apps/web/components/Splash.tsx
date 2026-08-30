'use client';

interface SplashProps {
  /** 0..1. Drives the bar; the rings run on their own. */
  progress?: number;
  label?: string;
}

/**
 * The loading screen.
 *
 * ★ THE MOTIF IS THE PRODUCT ★
 * Expanding rings from a fixed point — a position being broadcast and lost.
 * It is the same shape as the confidence ellipse growing during an outage,
 * so the first thing the app ever shows is the idea it is built around.
 *
 * Pure CSS keyframes: no timers, no animation frames, nothing competing with
 * the engine for the main thread while the map and the ONNX model load. On a
 * mid-range phone that matters — this is exactly the moment the app is busiest.
 */
export default function Splash({ progress, label = 'Starting up' }: SplashProps) {
  return (
    <div className="pp-splash absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-[#05070b]">
      {/* Depth behind the mark. */}
      <div className="pp-splash-glow pointer-events-none absolute" />

      <div className="relative flex h-44 w-44 items-center justify-center">
        <span className="pp-ring" style={{ animationDelay: '0s' }} />
        <span className="pp-ring" style={{ animationDelay: '0.8s' }} />
        <span className="pp-ring" style={{ animationDelay: '1.6s' }} />

        <div className="pp-mark relative flex h-20 w-20 items-center justify-center rounded-[1.4rem] border border-sky-400/30 bg-[#0b1220]">
          <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
            <path
              d="M12 2 L20 21 L12 16.5 L4 21 Z"
              fill="#38bdf8"
              stroke="#0b1220"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      <h1 className="pp-fade mt-6 text-[1.7rem] font-bold tracking-tight text-neutral-50">
        PathPulse
      </h1>
      <p className="pp-fade pp-delay-1 mt-1 text-[11px] font-medium uppercase tracking-[0.22em] text-sky-400/80">
        Navigation without GPS
      </p>

      <div className="pp-fade pp-delay-2 mt-8 w-40">
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={progress === undefined ? 'pp-bar h-full bg-sky-400' : 'h-full bg-sky-400 transition-[width] duration-300'}
            style={progress === undefined ? undefined : { width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-center text-[10px] tracking-wide text-neutral-600">{label}</p>
      </div>

      <p className="pp-fade pp-delay-3 absolute bottom-7 text-[9.5px] uppercase tracking-[0.18em] text-neutral-700">
        SIH26168 · ISRO · Team Avinya
      </p>
    </div>
  );
}
