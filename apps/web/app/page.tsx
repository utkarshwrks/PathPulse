'use client';

import { useMemo } from 'react';
import {
  bearingDeg,
  haversineDistance,
  latLonToEnu,
  enuToLatLon,
} from '@pathpulse/nav-core';

const INDIA_GATE = { lat: 28.6129, lon: 77.2295 };
const RED_FORT = { lat: 28.6562, lon: 77.241 };

/**
 * Phase 0 landing page. Deliberately not the real UI — it exists to prove the
 * workspace wiring end to end: the app imports pure nav-core math, runs it in
 * the browser, and still satisfies `output: 'export'`.
 * Phase 1 replaces this with the full-screen map.
 */
export default function Home() {
  const check = useMemo(() => {
    const distanceM = haversineDistance(
      INDIA_GATE.lat,
      INDIA_GATE.lon,
      RED_FORT.lat,
      RED_FORT.lon,
    );
    const bearing = bearingDeg(INDIA_GATE.lat, INDIA_GATE.lon, RED_FORT.lat, RED_FORT.lon);
    const enu = latLonToEnu(RED_FORT.lat, RED_FORT.lon, INDIA_GATE.lat, INDIA_GATE.lon);
    const roundTrip = enuToLatLon(enu.e, enu.n, INDIA_GATE.lat, INDIA_GATE.lon);
    const roundTripErrorM = haversineDistance(
      RED_FORT.lat,
      RED_FORT.lon,
      roundTrip.lat,
      roundTrip.lon,
    );
    return { distanceM, bearing, enu, roundTripErrorM };
  }, []);

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-8 p-8">
      <header className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">PathPulse</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Intelligent dead reckoning for seamless navigation
        </p>
        <p className="mt-1 text-xs text-neutral-600">SIH26168 · ISRO · Team Avinya</p>
      </header>

      <section className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900/60 p-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
          nav-core self check
        </h2>
        <dl className="tabular space-y-2 font-mono text-sm">
          <Row label="India Gate → Red Fort" value={`${check.distanceM.toFixed(1)} m`} />
          <Row label="bearing" value={`${check.bearing.toFixed(2)}°`} />
          <Row
            label="ENU offset"
            value={`E ${check.enu.e.toFixed(1)}  N ${check.enu.n.toFixed(1)}`}
          />
          <Row
            label="round-trip error"
            value={`${(check.roundTripErrorM * 1000).toFixed(4)} mm`}
          />
        </dl>
      </section>

      <p className="max-w-md text-center text-xs leading-relaxed text-neutral-600">
        Phase 0 complete. These numbers come from{' '}
        <code className="text-neutral-500">@pathpulse/nav-core</code>, which contains no browser
        APIs — the same code will run in the APK, in replay tests, and in the Part B edge engine.
      </p>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-100">{value}</dd>
    </div>
  );
}
