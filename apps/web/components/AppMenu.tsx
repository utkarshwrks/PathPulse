'use client';

import { useEffect } from 'react';

export interface MenuItem {
  id: string;
  icon: string;
  label: string;
  /** One line. What it does, not why it exists. */
  hint: string;
  onSelect: () => void;
  /** Rendered in the accent colour — the thing to press first. */
  primary?: boolean;
}

interface AppMenuProps {
  items: readonly MenuItem[];
  onClose: () => void;
}

/**
 * Everything that is not the map, behind one button.
 *
 * ★ WHY THIS REPLACED THE BUTTON ROW ★
 * The controls had grown to five buttons pinned top-right, on the same line as
 * a HUD up to 359 px wide — on a 390 px phone they physically could not
 * coexist, and they overlapped. Each feature had been added by appending one
 * more button to a row that was already full.
 *
 * A sheet costs one tap and gives every entry a name and a line of
 * explanation, which the icons never had room for.
 */
export default function AppMenu({ items, onClose }: AppMenuProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end bg-black/65 backdrop-blur-[3px]">
      <button
        type="button"
        aria-label="Close menu"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <div className="pp-surface-raised pp-sheet-in relative m-2 overflow-hidden p-2">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
            PathPulse
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <div className="mt-0.5">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={`pp-press flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.07] ${
                item.primary ? 'bg-emerald-500/10' : ''
              }`}
            >
              <span className="mt-0.5 w-5 shrink-0 text-center text-base leading-none">
                {item.icon}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-[13px] font-semibold ${
                    item.primary ? 'text-emerald-300' : 'text-neutral-100'
                  }`}
                >
                  {item.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">
                  {item.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
