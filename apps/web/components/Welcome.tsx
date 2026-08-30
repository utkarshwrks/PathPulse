'use client';

interface WelcomeProps {
  onTour: () => void;
  onSkip: () => void;
  buildId: string;
}

/**
 * First-run landing screen.
 *
 * ★ TWO LINES, TWO BUTTONS ★
 * The first version of this put the problem statement on the opening screen —
 * three paragraphs, the drift figure and its caveats — before anyone had seen
 * the app do anything. That is a wall to climb, not a welcome, and the honest
 * numbers belong where they can be checked against something: the results
 * screen and the pitch deck, both one tap away, both of which state them in
 * full.
 *
 * What is left is the smallest thing that makes the next tap obvious.
 */
export default function Welcome({ onTour, onSkip, buildId }: WelcomeProps) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#080b10] p-6 text-center">
      <div className="w-full max-w-xs">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-400/30 bg-sky-500/10">
          <span className="text-3xl">📍</span>
        </div>

        <h1 className="text-2xl font-bold text-neutral-50">PathPulse</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-neutral-400">
          Your blue dot freezes in tunnels and basements.
          <br />
          This keeps it moving — without GPS.
        </p>

        <div className="mt-7 flex flex-col gap-2">
          <button
            type="button"
            onClick={onTour}
            className="w-full rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-400"
          >
            Quick tour · 20 sec
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="w-full rounded-xl px-4 py-3 text-sm text-neutral-400 transition hover:bg-white/5"
          >
            Skip
          </button>
        </div>

        <p className="mt-8 font-mono text-[10px] text-neutral-600">build {buildId}</p>
      </div>
    </div>
  );
}
