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
 * The install button for someone who reached the site on their phone.
 *
 * ★ WHY IT SHOWS THE SIZE, DATE AND HASH ★
 * Android will warn that this file comes from outside the Play Store, and it
 * is right to. A page that answers "how big, how old, and is it the file you
 * think" before the warning appears is the difference between a download
 * somebody completes and one they abandon at the dialog. It is the same
 * argument as putting numbers on the HUD: the claim is checkable or it is not
 * worth making.
 *
 * The manifest is written by scripts/publish-apk.mjs. When it is missing —
 * which is the normal state of a fresh clone, because a 6 MB binary is not
 * committed — the button says the build is not published rather than offering
 * a link that 404s.
 */
export default function DownloadApk({ compact = false }: { compact?: boolean }) {
  const [apk, setApk] = useState<ApkManifest | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('downloads/apk.json', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<ApkManifest>) : null))
      .then((m) => {
        if (!cancelled) {
          setApk(m);
          setChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!checked) return null;

  if (!apk) {
    return (
      <p className="text-[11px] leading-snug text-neutral-500">
        No APK published for this build yet — run{' '}
        <code className="rounded bg-white/10 px-1">pnpm build:android</code> then{' '}
        <code className="rounded bg-white/10 px-1">node scripts/publish-apk.mjs</code>.
      </p>
    );
  }

  const built = new Date(apk.builtAt);
  const dateLabel = Number.isNaN(built.getTime())
    ? null
    : built.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className={compact ? '' : 'w-full'}>
      <a
        href={apk.file}
        // `download` asks the browser to save rather than navigate. Android
        // Chrome then hands the file to the package installer, which is the
        // one-tap path for someone holding the phone they want it on.
        download="PathPulse.apk"
        className="pp-press group flex w-full items-center justify-center gap-2.5 rounded-xl border border-sky-400/30 bg-sky-500/15 px-4 py-3 font-semibold text-sky-200 hover:border-sky-400/50 hover:bg-sky-500/25"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none">
          <path
            d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Download the Android app
      </a>
      <p className="tabular mt-2 text-center font-mono text-[10px] leading-relaxed text-neutral-500">
        {apk.sizeMb} MB · {apk.package}
        {dateLabel ? ` · built ${dateLabel}` : ''}
        <br />
        <span className="text-neutral-600">sha256 {apk.sha256.slice(0, 16)}…</span>
      </p>
      {/*
        Said before Android says it, and phrased as the routine step it is.
        A user who meets "install unknown apps" with no warning assumes
        something is wrong with the file rather than with the distribution
        channel, and stops.
      */}
      <p className="mt-1.5 text-center text-[10px] leading-snug text-neutral-500">
        Android will ask you to allow installing from your browser — that is
        normal for an app outside the Play Store.
      </p>
    </div>
  );
}
