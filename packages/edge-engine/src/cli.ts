#!/usr/bin/env tsx
/**
 * pathpulse-edge — the edge-deployable navigation engine.
 *
 * The same @pathpulse/nav-core that runs inside the Android app, running
 * outside a phone against an external inertial stream. Required by SIH26168:
 * "The final deliverable must be a working mobile application AND an Edge
 * deployable software engine."
 */
import { writeFileSync } from 'node:fs';
import { runEdge } from './runner.js';
import { GRADES, gyroBiasDegPerHour, parseGrade, type ImuGrade } from './grades.js';
import { FogSimulatorSource } from './sources/FogSimulatorSource.js';
import { ReplayFileSource } from './sources/ReplayFileSource.js';
import type { EdgeSource } from './sources/types.js';
import type { NavigationState } from '@pathpulse/nav-core';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const USAGE = `
pathpulse-edge — edge-deployable navigation engine (SIH26168, Phase 16)

  Same nav-core as the mobile app, driven from an external IMU stream.

USAGE
  pnpm edge --grade FOG --rate 200 --seconds 60
  pnpm edge --replay ../../data/replay/sim_city_4242.jsonl --rate 200
  pnpm edge --grade TACTICAL --rate 100 --seconds 30 --json out.jsonl

OPTIONS
  --grade <name>     PHONE_MEMS | TACTICAL | FOG        (default FOG)
  --rate <hz>        target output rate                 (default: grade nominal)
  --seconds <s>      how much stream to run             (default 60)
  --replay <file>    .jsonl or .csv of recorded IMU data instead of the simulator
  --gnss <ms>        emit a simulated fix this often; 0 = pure INS  (default 0)
  --json <file>      write every NavigationState as JSON lines
  --quiet            report only, no per-second progress
  --list-grades      print the sensor models and exit
  --help
`.trim();

function printGrades(): void {
  console.log('\n  IMU grades\n');
  for (const g of Object.values(GRADES)) {
    console.log(`  ${g.label.padEnd(18)} ${String(g.nominalRateHz).padStart(4)} Hz`);
    console.log(
      `    gyro bias  ${g.gyroBiasRadS.toExponential(2)} rad/s ` +
        `(${gyroBiasDegPerHour(g).toFixed(3)} deg/hr)`,
    );
    console.log(`    accel bias ${g.accelBiasMps2.toExponential(2)} m/s^2`);
    console.log(`    ${g.note}\n`);
  }
  console.log(
    '  FOG figures are datasheet-class values driving a simulator — we do not\n' +
      '  own the hardware, and any number produced from them is a simulation.\n',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args['list-grades']) {
    printGrades();
    return;
  }

  const grade: ImuGrade = args.grade ? parseGrade(String(args.grade)) : 'FOG';
  const rateHz = args.rate ? Number(args.rate) : GRADES[grade].nominalRateHz;
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    console.error(`--rate must be a positive number, got "${String(args.rate)}"`);
    process.exitCode = 1;
    return;
  }
  const seconds = args.seconds ? Number(args.seconds) : 60;
  const replay = args.replay ? String(args.replay) : null;

  let source: EdgeSource;
  let maxSamples = 0;
  if (replay) {
    source = new ReplayFileSource(replay);
  } else {
    source = new FogSimulatorSource({
      grade,
      periodMs: 1000 / rateHz,
      gnssIntervalMs: args.gnss ? Number(args.gnss) : 0,
    });
    maxSamples = Math.round(seconds * rateHz);
  }

  const jsonPath = args.json ? String(args.json) : null;
  const jsonLines: string[] = [];
  const onState = jsonPath
    ? (s: NavigationState) => {
        jsonLines.push(JSON.stringify(s));
      }
    : undefined;

  console.log(
    `\n  pathpulse-edge  ·  ${GRADES[grade].label}  ·  target ${rateHz} Hz  ·  ${source.name}`,
  );
  if (!replay) {
    console.log(`  SIMULATED inertial stream — not a recording of real hardware.`);
  }

  const report = await runEdge({ source, grade, rateHz, maxSamples, ...(onState ? { onState } : {}) });

  if (jsonPath) {
    writeFileSync(jsonPath, jsonLines.join('\n') + '\n');
  }

  const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
  console.log('');
  console.log(`  samples processed         ${report.samples}`);
  console.log(`  stream duration           ${f(report.streamSeconds, 1)} s`);
  console.log(`  wall-clock time           ${f(report.wallSeconds, 3)} s`);
  console.log(`  SUSTAINED RATE            ${f(report.achievedRateHz, 0)} Hz`);
  console.log(`  target rate               ${rateHz} Hz`);
  console.log(`  real-time factor          ${f(report.realTimeFactor, 0)}x`);
  console.log(`  mean update latency       ${f(report.meanLatencyMs, 4)} ms`);
  console.log(`  p99 update latency        ${f(report.p99LatencyMs, 4)} ms`);
  console.log(`  max update latency        ${f(report.maxLatencyMs, 4)} ms`);
  if (report.finalState) {
    console.log(`  final mode                ${report.finalState.mode}`);
    console.log(`  distance travelled        ${f(report.finalState.distanceTravelledM, 1)} m`);
  }
  if (jsonPath) console.log(`  wrote                     ${jsonPath}`);

  const meets = report.achievedRateHz >= rateHz;
  console.log('');
  console.log(
    meets
      ? `  ✔ sustains ${rateHz} Hz — ${f(report.achievedRateHz / rateHz, 0)}x headroom on this machine`
      : `  ✗ does NOT sustain ${rateHz} Hz on this machine (${f(report.achievedRateHz, 0)} Hz)`,
  );
  console.log('');
  if (!meets) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
