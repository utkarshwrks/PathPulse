'use client';

import DownloadApk from './DownloadApk';

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
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-[#05070b] px-7">
      <div className="pp-splash-glow pointer-events-none absolute" />

      <div className="relative flex w-full max-w-xs flex-col items-center text-center">
        <div className="relative mb-7 flex h-28 w-28 items-center justify-center">
          <span className="pp-ring" style={{ animationDelay: '0s' }} />
          <span className="pp-ring" style={{ animationDelay: '1.2s' }} />
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

        <h1 className="pp-fade text-[2rem] font-bold leading-none tracking-tight text-neutral-50">
          PathPulse
        </h1>
        <p className="pp-fade pp-delay-1 mt-3 text-[13.5px] leading-relaxed text-neutral-400">
          Your blue dot freezes in tunnels and basements.
          <br />
          <span className="text-neutral-200">This keeps it moving — without GPS.</span>
        </p>

        <div className="pp-fade pp-delay-2 mt-7 flex w-full flex-col gap-2.5">
          <button
            type="button"
            onClick={onTour}
            className="w-full rounded-2xl bg-sky-500 px-4 py-3.5 text-[14px] font-semibold text-white shadow-lg shadow-sky-500/20 transition active:scale-[0.98] hover:bg-sky-400"
          >
            Take the tour · 20 sec
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="w-full rounded-2xl border border-white/10 px-4 py-3.5 text-[14px] text-neutral-300 transition active:scale-[0.98] hover:bg-white/5"
          >
            Skip
          </button>
        </div>

        {/*
          Offered on the landing screen because someone who reached this URL on
          a phone browser is one tap from having the real app, and the browser
          build cannot give them background sensors or native location. It sits
          BELOW the tour rather than above it: the person already here came to
          look, and a download prompt as the first thing on screen reads as a
          wall rather than an offer.
        */}
        <div className="pp-fade pp-delay-3 mt-7 w-full border-t border-white/[0.07] pt-6">
          <DownloadApk />
        </div>

        {/*
          A way out to the written explanation, for the reader who wants the
          numbers and the caveats before they touch a map they cannot yet
          interpret. Deliberately quiet: it is a footnote, not a call to action.
        */}
        <a
          href="about.html"
          className="pp-press pp-fade pp-delay-4 mt-6 text-[11px] text-neutral-500 underline decoration-neutral-700 underline-offset-4 hover:text-neutral-300"
        >
          What is PathPulse?
        </a>

        <p className="pp-fade pp-delay-4 mt-7 text-[9.5px] uppercase tracking-[0.18em] text-neutral-700">
          SIH26168 · ISRO · Team Avinya
        </p>
        <p className="pp-fade pp-delay-4 mt-1.5 font-mono text-[9.5px] text-neutral-800">
          build {buildId}
        </p>
      </div>
    </div>
  );
}
