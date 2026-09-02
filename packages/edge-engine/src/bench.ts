#!/usr/bin/env tsx
/**
 * The edge engine's demo artefact: the same drive, at three sensor grades.
 *
 * ★ WHAT THIS IS EVIDENCE FOR, AND WHAT IT IS NOT ★
 * It shows that sensor grade is a *configuration* of this engine rather than a
 * different engine — one navigation core, three noise models, and the error
 * falling as the hardware improves exactly as the physics says it should.
 *
 * It is NOT a claim about real fibre-optic hardware. Every row is simulated,
 * the table says so on its face, and the FOG row in particular is a datasheet
 * noise model rather than a measurement. Publishing it any other way would
 * repeat the mistake this project has spent its whole documentation avoiding.
 *
 * Ground truth is the simulator's own integrated path, which the estimator
 * never sees — the same withheld-truth method the mobile ablation uses.
 */
import { writeFileSync } from 'node:fs';
import { haversineDistance, NavigationEngine } from '@pathpulse/nav-core';
import { GRADES, gyroBiasDegPerHour, type ImuGrade } from './grades.js';
import { FogSimulatorSource } from './sources/FogSimulatorSource.js';

interface Row {
  grade: ImuGrade;
  label: string;
  rateHz: number;
  finalErrorM: number;
  distanceM: number;
  driftPct: number;
  /** Error along the direction of travel — dominated by speed error. */
  alongM: number;
  /** Error across it — dominated by heading error, i.e. by gyro bias. */
  crossM: number;
  headingErrDeg: number;
  meanLatencyMs: number;
  sustainedHz: number;
}

/** Seconds of GNSS aiding before the outage, and outage length. */
const WARMUP_S = 20;
const OUTAGE_S = 60;

function runGrade(grade: ImuGrade): Row {
  const profile = GRADES[grade];
  const rateHz = profile.nominalRateHz;
  const periodMs = 1000 / rateHz;
  const sim = new FogSimulatorSource({ grade, periodMs, gnssIntervalMs: 1000 });
  const engine = new NavigationEngine();

  const originLat = 23.1815;
  const originLon = 79.9864;
  const total = Math.round((WARMUP_S + OUTAGE_S) * rateHz);
  const outageStart = Math.round(WARMUP_S * rateHz);

  let latencySum = 0;
  let lastState = null as ReturnType<NavigationEngine['update']> | null;
  const wall0 = performance.now();

  for (let i = 0; i < total; i++) {
    const sample = sim.next(i * periodMs);
    // Delete GNSS for the outage window BEFORE the estimator sees it — the
    // field is removed, never zeroed, which is the shape a tunnel produces.
    if (i >= outageStart) delete sample.gnss;
    const t0 = performance.now();
    lastState = engine.update(sample);
    latencySum += performance.now() - t0;
  }

  const wallSeconds = (performance.now() - wall0) / 1000;

  // Truth at the end of the run, in the same lat/lon frame the engine reports.
  const truth = sim.truthEnu;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((originLat * Math.PI) / 180);
  const truthLat = originLat + truth.n / mPerDegLat;
  const truthLon = originLon + truth.e / mPerDegLon;

  const finalErrorM = lastState
    ? haversineDistance(lastState.position.lat, lastState.position.lon, truthLat, truthLon)
    : Number.NaN;

  // ★ DECOMPOSE, BECAUSE A SINGLE FIGURE HIDES THE GRADE EFFECT ★
  // Along-track error comes from not knowing the speed, and no gyroscope fixes
  // that — during an unaided outage it is the same problem at every grade, and
  // it is large enough to swamp the total. Cross-track error comes from not
  // knowing the heading, and heading error is dominated by residual gyro bias,
  // which is precisely what separates these three parts. Quoting only the
  // total would report that sensor grade barely matters, which is false; it
  // matters enormously for the half of the error a gyroscope is responsible
  // for. The same split the mobile ablation reports, for the same reason.
  let alongM = Number.NaN;
  let crossM = Number.NaN;
  let headingErrDeg = Number.NaN;
  if (lastState) {
    const errE = (lastState.position.lon - truthLon) * mPerDegLon;
    const errN = (lastState.position.lat - truthLat) * mPerDegLat;
    const hRad = (sim.truthHeadingDeg * Math.PI) / 180;
    const alongE = Math.sin(hRad);
    const alongN = Math.cos(hRad);
    alongM = Math.abs(errE * alongE + errN * alongN);
    crossM = Math.abs(errE * alongN - errN * alongE);
    headingErrDeg = Math.abs(
      ((lastState.headingDeg - sim.truthHeadingDeg + 540) % 360) - 180,
    );
  }
  // Distance travelled during the outage, from truth rather than from the
  // estimate's own opinion of how far it went — otherwise a configuration that
  // under-estimates its speed would flatter itself twice.
  const distanceM = 16.7 * OUTAGE_S;

  return {
    grade,
    label: profile.label,
    rateHz,
    finalErrorM,
    distanceM,
    driftPct: (finalErrorM / distanceM) * 100,
    alongM,
    crossM,
    headingErrDeg,
    meanLatencyMs: latencySum / total,
    sustainedHz: wallSeconds > 0 ? total / wallSeconds : Number.NaN,
  };
}

function main(): void {
  const rows: Row[] = (['PHONE_MEMS', 'TACTICAL', 'FOG'] as ImuGrade[]).map(runGrade);

  console.log(`\n  Edge engine — one nav-core, three sensor grades`);
  console.log(`  ${WARMUP_S}s GNSS aiding, then a ${OUTAGE_S}s total outage at 60 km/h\n`);
  const pad = (s: string, n: number) => s.padEnd(n);
  const rpad = (s: string, n: number) => s.padStart(n);
  console.log(
    `  ${pad('grade', 20)}${rpad('rate', 7)}${rpad('drift %', 9)}${rpad('along m', 9)}${rpad('cross m', 9)}${rpad('hdg err', 9)}${rpad('latency', 10)}${rpad('sustained', 12)}`,
  );
  for (const r of rows) {
    console.log(
      `  ${pad(r.label, 20)}${rpad(String(r.rateHz) + ' Hz', 7)}${rpad(r.driftPct.toFixed(1), 9)}${rpad(r.alongM.toFixed(1), 9)}${rpad(r.crossM.toFixed(1), 9)}${rpad(r.headingErrDeg.toFixed(2) + '°', 9)}${rpad(r.meanLatencyMs.toFixed(4), 10)}${rpad(Math.round(r.sustainedHz) + ' Hz', 12)}`,
    );
  }

  const md = [
    '# Edge engine — sensor grade comparison',
    '',
    '**Generated by `pnpm --filter @pathpulse/edge-engine bench`. Do not edit by hand.**',
    '',
    'The same `nav-core` estimator, driven from an external inertial stream at three',
    'sensor grades. Only the noise and bias model changes between rows; not one line',
    'of navigation mathematics differs.',
    '',
    `Each run is ${WARMUP_S}s of GNSS aiding followed by a ${OUTAGE_S}s total outage at 60 km/h.`,
    'Ground truth is the simulator\'s own integrated path, withheld from the estimator.',
    '',
    '> ⚠️ **Every row is SIMULATED.** We do not own a fibre-optic or tactical-grade',
    '> IMU; those rows are datasheet-class noise models, not recordings of hardware.',
    '> These figures demonstrate that sensor grade is a configuration of this engine.',
    '> They are not a measurement of any real external IMU.',
    '',
    '| Grade | Rate | Gyro bias | Drift % | Along m | Cross m | Heading err | Latency ms | Sustained |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => {
      const g = GRADES[r.grade];
      return (
        `| ${r.label} | ${r.rateHz} Hz | ${gyroBiasDegPerHour(g).toFixed(3)} °/hr | ` +
        `${r.driftPct.toFixed(1)} | ${r.alongM.toFixed(1)} | **${r.crossM.toFixed(1)}** | ` +
        `**${r.headingErrDeg.toFixed(2)}°** | ${r.meanLatencyMs.toFixed(4)} | ` +
        `${Math.round(r.sustainedHz).toLocaleString('en-US')} Hz |`
      );
    }),
    '',
    '## What this shows',
    '',
    '- **The estimator is not the bottleneck.** Mean update latency is microseconds,',
    '  so 200 Hz is met with orders of magnitude of headroom. Whether a given IMU can',
    '  be *read* at 200 Hz is a property of that IMU, not of this engine.',
    '- **Read the cross-track and heading columns, not the total.** Along-track error',
    '  comes from not knowing the speed, and no gyroscope fixes that — unaided, it is',
    '  the same problem at every grade and it dominates the total. Cross-track error',
    '  comes from heading, heading comes from the gyroscope, and that is where three',
    '  orders of magnitude of bias show up. Quoting only the total would say sensor',
    '  grade barely matters, which is false for the half of the error it governs.',
    '- **One codebase, two deployment targets.** The mobile app and this engine run',
    '  identical navigation code; only the adapters around it differ.',
    '',
  ].join('\n');

  writeFileSync(new URL('../../../docs/edge-benchmarks.md', import.meta.url), md);
  console.log(`\n  wrote docs/edge-benchmarks.md`);
  console.log(`  ⚠️  every row is SIMULATED — no external IMU hardware was used\n`);
}

main();
