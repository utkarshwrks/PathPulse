'use client';

import { useEffect, useState } from 'react';

interface Row {
  config: string;
  description: string;
  runs: number;
  meanDriftPct: number;
  medianDriftPct: number;
  p90DriftPct: number;
  meanAlongM: number;
  meanCrossM: number;
}

/**
 * The ablation table, fetched from the file the tooling generates.
 *
 * ★ NOT TYPED BY HAND, AND THAT IS THE POINT ★
 * `pnpm ablation` writes public/benchmarks/benchmarks.json. This reads it. So
 * the table on the landing page cannot drift from the table in the repository,
 * and nobody can quietly improve a number by editing a page — which is exactly
 * the failure mode that makes a results table on a marketing site worthless.
 *
 * Each row differs from the one above by exactly one component, so every
 * improvement is attributable to something specific. The last row is a
 * component that measured WORSE and is shipped disabled; it stays in the table
 * because a team that publishes its own failed experiment is a team whose
 * successful numbers can be believed.
 */
export default function AblationTable() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let dead = false;
    fetch('benchmarks/benchmarks.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('missing'))))
      .then((d: { rows: Row[] }) => !dead && setRows(d.rows))
      .catch(() => !dead && setErr(true));
    return () => {
      dead = true;
    };
  }, []);

  if (err) {
    return (
      <p className="text-[12px] text-neutral-500">
        Benchmarks not bundled — run <code>pnpm ablation</code>.
      </p>
    );
  }
  if (!rows) {
    return <div className="h-48 animate-pulse rounded-xl bg-white/[0.03]" />;
  }

  const worst = Math.max(...rows.map((r) => r.meanDriftPct));

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full min-w-[560px] border-collapse bg-[#080b11] text-left">
          <thead>
            <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wide text-neutral-500">
              <th className="px-4 py-3 font-medium">Configuration</th>
              <th className="px-3 py-3 text-right font-medium">Mean %</th>
              <th className="px-3 py-3 text-right font-medium">Median</th>
              <th className="px-3 py-3 text-right font-medium">p90</th>
              <th className="px-3 py-3 text-right font-medium">Along m</th>
              <th className="px-4 py-3 text-right font-medium">Cross m</th>
            </tr>
          </thead>
          <tbody className="tabular font-mono text-[11.5px]">
            {rows.map((r) => {
              const shipped = r.config === 'full';
              const negative = r.config === 'full_forwardbias';
              return (
                <tr
                  key={r.config}
                  className={`border-b border-white/[0.05] last:border-0 ${
                    shipped ? 'bg-sky-500/[0.07]' : ''
                  }`}
                  title={r.description}
                >
                  <td className="px-4 py-2.5">
                    <span className={shipped ? 'font-semibold text-sky-300' : 'text-neutral-300'}>
                      {r.config}
                    </span>
                    {shipped ? (
                      <span className="ml-2 rounded bg-sky-500/20 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-sky-300">
                        shipped
                      </span>
                    ) : null}
                    {negative ? (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300">
                        off — measured worse
                      </span>
                    ) : null}
                    {/* A bar, so the collapse from 61% to 10% is visible rather
                        than something the reader has to compute. */}
                    <div className="mt-1.5 h-[3px] w-full max-w-[190px] overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(r.meanDriftPct / worst) * 100}%`,
                          backgroundColor: shipped
                            ? '#38bdf8'
                            : negative
                              ? '#f59e0b'
                              : '#475569',
                        }}
                      />
                    </div>
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right ${
                      shipped ? 'font-semibold text-white' : 'text-neutral-300'
                    }`}
                  >
                    {r.meanDriftPct.toFixed(1)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-neutral-400">
                    {r.medianDriftPct.toFixed(1)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-neutral-400">
                    {r.p90DriftPct.toFixed(1)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-neutral-500">
                    {r.meanAlongM.toFixed(0)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-neutral-500">
                    {r.meanCrossM.toFixed(0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
        Read from <code className="text-neutral-400">benchmarks.json</code>,
        which <code className="text-neutral-400">pnpm ablation</code> generates
        by running the software. Nobody types these numbers, and this page
        cannot disagree with the repository. Hover a row for what it changes.
      </p>
    </div>
  );
}
