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
 * The public "get the app" page — the single link meant for a slide, a QR
 * code, or the SIH deck.
 *
 * ★ WHY A PAGE AND NOT A RAW .apk LINK ★
 * A link that ends in `.apk` and downloads a binary the instant it is tapped
 * is exactly the shape a phishing link takes, and a judge — or their phone —
 * is right to distrust it. This page is the trust layer: it names the project
 * and its owners, shows the size, build date and SHA-256 of the file before it
 * arrives, and says in advance that Android will ask permission to install
 * from the browser. Everything a careful person checks before installing an
 * app from outside the Play Store is answered on screen first. The download
 * still starts on its own, so the one-tap experience is intact — the page just
 * makes the tap an informed one.
 *
 * The manifest (downloads/apk.json) is an enhancement, not a dependency: if it
 * is missing the button still points at the known, fixed APK path and simply
 * omits the numbers it could not read. This is the same fallback the site was
 * hardened with after apk.json once 404'd and hid the only button that matters.
 */
export default function DownloadPage() {
  const [apk, setApk] = useState<ApkManifest | null>(null);
  const [checked, setChecked] = useState(false);
  const [started, setStarted] = useState(false);

  const file = apk?.file ?? 'downloads/PathPulse.apk';

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

  // Kick off the download on its own, once we know where the file is. A hidden
  // anchor with `download` asks the browser to save rather than navigate;
  // Android Chrome then hands the file to the package installer. If the browser
  // declines to auto-start without a tap, the visible button below is the
  // reliable path — so this is a convenience, never the only way through.
  useEffect(() => {
    if (!checked) return;
    const target = apk?.file ?? 'downloads/PathPulse.apk';
    const a = document.createElement('a');
    a.href = target;
    a.setAttribute('download', 'PathPulse.apk');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setStarted(true);
  }, [checked, apk]);

  const built = new Date(apk?.builtAt ?? NaN);
  const date = Number.isNaN(built.getTime())
    ? null
    : built.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#05070b] px-7 text-neutral-300">
      <div className="pp-splash-glow pointer-events-none absolute" />

      <div className="relative flex w-full max-w-sm flex-col items-center text-center">
        {/* The mark, so the page is recognisably the same project as the app. */}
        <div className="pp-mark relative mb-6 flex h-20 w-20 items-center justify-center rounded-[1.4rem] border border-sky-400/30 bg-[#0b1220]">
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

        <h1 className="text-[1.9rem] font-bold leading-none tracking-tight text-neutral-50">
          PathPulse for Android
        </h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-neutral-400">
          Navigation that keeps your blue dot moving in tunnels and basements —
          <span className="text-neutral-200"> without GPS.</span>
        </p>

        {/* Status line: honest about what is happening, so a download that the
            browser started silently is not mistaken for nothing happening. */}
        <p className="mt-6 h-4 text-[11px] text-neutral-500" aria-live="polite">
          {started ? 'Your download should be starting…' : ' '}
        </p>

        {/* The one action the page exists for. Same treatment as the landing
            CTA so it reads as the obvious next tap. */}
        <div className="relative mt-2 w-full">
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
            <span className="relative z-[2]">Download the app</span>
          </a>
        </div>

        {/* The checkable facts, shown before Android's warning appears. */}
        <p className="tabular mt-3 text-center font-mono text-[10.5px] text-neutral-500">
          {apk ? `${apk.sizeMb} MB · ${apk.package}` : 'Android · in.avinya.pathpulse'}
          {date ? ` · built ${date}` : ''}
        </p>
        {apk?.sha256 ? (
          <p className="tabular mt-1 break-all text-center font-mono text-[9.5px] leading-relaxed text-neutral-600">
            sha256 {apk.sha256}
          </p>
        ) : null}

        <p className="mt-4 max-w-xs text-center text-[10.5px] leading-snug text-neutral-500">
          Android will ask you to allow installing from your browser — that is
          normal for an app outside the Play Store.
        </p>

        <a
          href="about.html"
          className="pp-press mt-7 text-[11px] text-neutral-500 underline decoration-neutral-700 underline-offset-4 hover:text-neutral-300"
        >
          What is PathPulse?
        </a>

        <p className="mt-8 text-[9.5px] uppercase tracking-[0.18em] text-neutral-700">
          SIH26168 · ISRO · Team Avinya
        </p>
      </div>
    </main>
  );
}
