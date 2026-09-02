'use client';

import { useEffect, type ReactNode } from 'react';

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional line under the title. */
  subtitle?: string;
}

/**
 * The one and only overlay shell.
 *
 * ★ WHY EVERY PANEL NOW GOES THROUGH HERE ★
 * Panels were added one at a time over ten phases, and each picked its own
 * corner and its own z-index. The result: the source picker sat on top of the
 * Demo button, the menu and the debug panel shared a layer, and six
 * independent booleans meant several could be open at once, stacked. Nothing
 * was individually wrong; the absence of a rule was.
 *
 * So there is a rule now. One shell, one position, one layer, one close
 * button, and — enforced by the caller holding a single `activePanel` rather
 * than six flags — one open at a time. Overlap stops being a bug to hunt and
 * becomes impossible to express.
 *
 * Full-height on a phone with its own scroll, because a panel that overflows
 * off-screen with no way to reach the rest is the same failure in a different
 * costume.
 */
export default function Sheet({ title, subtitle, onClose, children }: SheetProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/65 backdrop-blur-[3px]"
      />

      <div className="pp-surface-raised pp-sheet-in relative m-2 flex max-h-[88vh] flex-col overflow-hidden">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/[0.08] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-neutral-50">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 text-[11px] leading-snug text-neutral-400">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="pp-press -mr-1 -mt-1 shrink-0 rounded-lg px-2.5 py-1.5 text-sm text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
