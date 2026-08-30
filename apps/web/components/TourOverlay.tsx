'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { TOUR_STEPS, stepAt } from '@/lib/tour';

interface TourOverlayProps {
  index: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where the highlighted element is, or null if the step has no anchor. */
function measure(anchor: string | null): Box | null {
  if (!anchor || typeof document === 'undefined') return null;
  const el = document.querySelector(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * The guided tour overlay.
 *
 * A dimmed backdrop with a hole cut around whatever the step is talking about,
 * and a card that keeps out of the way of it. The card sits at the bottom
 * unless the highlight is already there, in which case it moves to the top —
 * on a phone there are only really two places for it to be.
 *
 * A missing anchor degrades to a centred card rather than a ring drawn over
 * nothing. Elements come and go with state (the demo bar replaces the source
 * panel, for one), and a tour that breaks when the UI changes underneath it is
 * worse than a tour that simply says its piece.
 */
export default function TourOverlay({ index, onNext, onBack, onSkip }: TourOverlayProps) {
  const step = stepAt(index);
  const [box, setBox] = useState<Box | null>(null);

  useLayoutEffect(() => {
    const update = () => setBox(measure(step.anchor));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [step.anchor]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === 'Enter') onNext();
      else if (e.key === 'ArrowLeft') onBack();
      else if (e.key === 'Escape') onSkip();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNext, onBack, onSkip]);

  const isLast = index >= TOUR_STEPS.length - 1;
  // Keep the card away from the highlight: if the target is in the lower half
  // of the screen, the card goes up top.
  const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight;
  const cardAtTop = box !== null && box.top + box.height / 2 > viewportH * 0.55;

  return (
    <div className="absolute inset-0 z-50" data-testid="tour-overlay">
      {/* Backdrop. Pointer events are captured so a stray tap during the tour
          cannot fire a control the tour is currently describing. */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[3px]" onClick={onNext} />

      {box ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-sky-400"
          style={{
            top: box.top - 6,
            left: box.left - 6,
            width: box.width + 12,
            height: box.height + 12,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        />
      ) : null}

      <div
        className={`absolute left-1/2 w-[min(94vw,26rem)] -translate-x-1/2 rounded-2xl border border-white/15 bg-[#0d1117] p-4 shadow-2xl ${
          cardAtTop ? 'top-4' : 'bottom-4'
        }`}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-widest text-sky-400">
            Step {index + 1} of {TOUR_STEPS.length}
          </span>
          <button
            type="button"
            onClick={onSkip}
            className="rounded px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-white/10 hover:text-neutral-200"
          >
            Skip tour
          </button>
        </div>

        <h2 className="mt-1.5 text-base font-semibold text-neutral-50">{step.title}</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-300">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-1">
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 w-1.5 rounded-full ${
                  i === index ? 'bg-sky-400' : 'bg-white/20'
                }`}
              />
            ))}
          </div>
          <div className="ml-auto flex gap-1.5">
            <button
              type="button"
              onClick={onBack}
              disabled={index === 0}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-neutral-200 transition hover:bg-white/10 disabled:opacity-30"
            >
              Back
            </button>
            <button
              type="button"
              onClick={onNext}
              className="rounded-lg bg-sky-500 px-4 py-1.5 text-[11px] font-semibold text-white transition hover:bg-sky-400"
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
