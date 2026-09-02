'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Fades a section in the first time it is scrolled to.
 *
 * ★ WHY NOT A SCROLL LIBRARY ★
 * One IntersectionObserver and one CSS transition do the whole job in twenty
 * lines. Pulling in an animation framework for this would add more bytes than
 * three.js is spending on the hero, to move some text nine pixels.
 *
 * It reveals once and then disconnects — content that re-animates every time
 * it scrolls past is the thing that makes a page feel like a template. And
 * anyone who has asked for reduced motion simply gets the content, already
 * visible, with no transition at all.
 */
export default function Reveal({
  children,
  className = '',
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      // Fire a little before the edge, so the transition has finished by the
      // time the reader's eye actually arrives.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(14px)',
        transition: `opacity 620ms cubic-bezier(0.16,1,0.3,1) ${delayMs}ms, transform 620ms cubic-bezier(0.16,1,0.3,1) ${delayMs}ms`,
      }}
    >
      {children}
    </div>
  );
}
