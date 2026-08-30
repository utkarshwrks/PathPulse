'use client';

interface WelcomeProps {
  onTour: () => void;
  onSkip: () => void;
  buildId: string;
}

/**
 * First-run landing screen.
 *
 * ★ THE FIRST FIFTEEN SECONDS ★
 * Before this, opening the app gave you a dark map, a wall of numbers and no
 * idea what any of it was for. A judge with a phone in their hand and thirty
 * other stands to visit does not read a HUD to find out what a project does.
 *
 * So: one sentence on the problem, one on the answer, and two buttons. It
 * shows once — the tour marks itself seen — and never nags again.
 *
 * It also states the honest headline up front rather than burying it three
 * screens deep, because that number is the project and the caveat travels with
 * it everywhere else it appears.
 */
export default function Welcome({ onTour, onSkip, buildId }: WelcomeProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#080b10] p-5">
      <div className="w-full max-w-md">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-sky-400">
          SIH26168 · ISRO · Team Avinya
        </p>
        <h1 className="mt-2 text-3xl font-bold leading-tight text-neutral-50">PathPulse</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Navigation that keeps working when the satellites stop.
        </p>

        <div className="mt-5 space-y-3 text-[13px] leading-relaxed text-neutral-300">
          <p>
            <span className="font-semibold text-neutral-100">The problem.</span> In a tunnel,
            a basement or between tall buildings there is no sky, so there is no satellite
            fix. The blue dot freezes or scatters — exactly where a driver most needs it.
          </p>
          <p>
            <span className="font-semibold text-neutral-100">What this does.</span> It keeps
            navigating from the phone’s own accelerometer and gyroscope, constrained by what
            a vehicle can physically do and by where the roads are. No internet, no cloud, no
            mobile signal.
          </p>
        </div>

        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="font-mono text-lg font-semibold text-emerald-300">
            10.0% mean drift
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-neutral-400">
            over 12 runs, measured against withheld ground truth. Median 6.4%, p90 22.6% —
            the mean sits on the &lt;10% target rather than under it, and every log so far is
            simulated. The app shows you the whole table.
          </p>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onTour}
            className="w-full rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-400"
          >
            Show me around
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="w-full rounded-xl border border-white/15 px-4 py-3 text-sm text-neutral-300 transition hover:bg-white/10"
          >
            Skip — go straight to the map
          </button>
        </div>

        <p className="mt-4 text-center font-mono text-[10px] text-neutral-600">
          build {buildId}
        </p>
      </div>
    </div>
  );
}
