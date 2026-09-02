'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const SECTIONS = [
  ['problem', 'Problem'],
  ['how', 'How it works'],
  ['results', 'Results'],
  ['maps', 'Maps'],
  ['ai', 'AI'],
  ['edge', 'Edge engine'],
  ['honest', 'What is built'],
] as const;

/**
 * Sticky navigation with a reading-progress rule.
 *
 * ★ WHY A LANDING PAGE THIS LONG NEEDS ONE ★
 * The page argues in order — problem, mechanism, evidence, honest position —
 * and a reader who lands halfway down from a shared anchor has no idea how
 * much argument sits above them. The progress rule answers "how long is this",
 * and the active section answers "where am I", and both are questions people
 * silently give up over rather than ask.
 *
 * Section tracking uses one IntersectionObserver rather than a scroll handler:
 * a scroll listener firing at 60 Hz to recompute offsets is exactly the kind of
 * thing that makes a page feel heavy on a mid-range phone, which is the device
 * this whole project is about.
 */
export default function SiteNav() {
  const [progress, setProgress] = useState(0);
  const [active, setActive] = useState<string>('');
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const h = document.documentElement;
        const max = h.scrollHeight - h.clientHeight;
        setProgress(max > 0 ? Math.min(1, h.scrollTop / max) : 0);
        setSolid(h.scrollTop > 24);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        // The topmost intersecting section wins, so a tall section does not
        // hand the highlight to a short one that has merely crept into view.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  return (
    <div
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        solid ? 'pp-nav-solid' : ''
      }`}
    >
      <nav className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
        <a href="#top" className="pp-press flex items-center gap-2.5 shrink-0">
          <span className="relative flex h-6 w-6 items-center justify-center">
            <span className="absolute inset-0 rounded-md bg-sky-500/20" />
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
          </span>
          <span className="text-[13.5px] font-semibold tracking-tight text-neutral-100">
            PathPulse
          </span>
        </a>

        <div className="ml-2 hidden flex-1 items-center gap-1 lg:flex">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={`rounded-lg px-2.5 py-1.5 text-[12px] transition-colors ${
                active === id
                  ? 'bg-white/[0.07] text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {label}
            </a>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/"
            className="pp-press rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-neutral-300 hover:bg-white/5"
          >
            Live demo
          </Link>
          <a
            href="#get"
            className="pp-press rounded-lg bg-sky-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-sky-400"
          >
            Get the app
          </a>
        </div>
      </nav>

      {/* Reading progress. One transform, no layout, so it costs nothing. */}
      <div className="h-px w-full bg-white/[0.06]">
        <div
          className="h-full origin-left bg-sky-400/80"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>
    </div>
  );
}
