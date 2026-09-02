'use client';

import { useEffect, useState } from 'react';

interface ApkManifest {
  file: string;
  sizeMb: number;
  sha256: string;
  builtAt: string;
  package: string;
}

/**
 * The page's single conversion.
 *
 * ★ WHY THIS IS THE ONLY THING THAT ANIMATES CONTINUOUSLY ★
 * Everything else on the site settles once it has been read. This does not,
 * because it is the one action the page exists to produce, and a reader
 * scanning past needs it to catch peripheral vision. A sheen every few
 * seconds and a breathing ring is enough to be noticed and slow enough not to
 * nag — anything faster reads as an advertisement and gets ignored on purpose.
 *
 * It still shows size, build date and hash. Android will warn that this comes
 * from outside the Play Store and it is right to; a page that answers "how
 * big, how old, is this the right file" before the warning appears is the
 * difference between a download completed and one abandoned at the dialog.
 */
export default function DownloadCta({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const [apk, setApk] = useState<ApkManifest | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let dead = false;
    fetch('downloads/apk.json', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<ApkManifest>) : null))
      .then((m) => {
        if (dead) return;
        setApk(m);
        setChecked(true);
      })
      .catch(() => !dead && setChecked(true));
    return () => {
      dead = true;
    };
  }, []);

  if (!checked) return <div className="h-14 w-full animate-pulse rounded-2xl bg-white/[0.04]" />;

  /*
   * ★ THE MANIFEST IS AN ENHANCEMENT, NOT A DEPENDENCY ★
   * The deployed site served the APK correctly while apk.json 404'd, and the
   * button hid itself — the one action the page exists for, disabled by a
   * missing 239-byte metadata file. The APK path is fixed and known, so fall
   * back to it and simply omit the size and hash we could not read.
   */
  const file = apk?.file ?? 'downloads/PathPulse.apk';

  const built = new Date(apk?.builtAt ?? NaN);
  const date = Number.isNaN(built.getTime())
    ? null
    : built.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  return (
    <div className={variant === 'full' ? 'w-full max-w-md' : 'w-full'}>
      <div className="relative">
        {/* The breathing ring sits behind, so it never intercepts the tap. */}
        <span
          aria-hidden="true"
          className="pp-cta-ring pointer-events-none absolute inset-0 rounded-2xl border border-sky-400/50"
        />
        <a
          href={file}
          download="PathPulse.apk"
          className="pp-cta pp-press relative flex items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-sky-500 via-cyan-400 to-sky-500 px-6 py-4 text-[15px] font-bold text-[#04121c] shadow-[0_10px_40px_-8px_rgba(56,189,248,0.55)]"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none">
            <path
              d="M12 3v11m0 0 4.5-4.5M12 14l-4.5-4.5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="relative z-[2]">Download the Android app</span>
        </a>
      </div>

      <p className="tabular mt-2.5 text-center font-mono text-[10.5px] text-neutral-500">
        {apk ? `${apk.sizeMb} MB · ${apk.package}` : 'Android · in.avinya.pathpulse'}
        {date ? ` · built ${date}` : ''}
      </p>
      <p className="mt-1 text-center text-[10.5px] leading-snug text-neutral-600">
        Android asks you to allow installing from your browser — normal outside
        the Play Store.
      </p>
    </div>
  );
}
