import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CITY_VEHICLE,
  HIGHWAY_VEHICLE,
  SimulationSource,
  type RouteGeoJson,
} from '@pathpulse/sensor-sources';
import { ROOT, parseArgs } from './paths.js';

/**
 * Record deterministic replay logs from the simulator into data/replay/.
 *
 *   pnpm eval:record
 *   pnpm eval:record -- --route city --seed 4242 --duration 180
 *
 * ★ THESE ARE SIMULATED, NOT DRIVEN ★
 * Every filename starts with `sim_`, because a benchmark run against simulated
 * data and presented as a road result would be the most damaging thing in this
 * project. Real drive logs live in the same folder as `drive_*.jsonl` once they
 * exist, and the harness treats both identically — which is the whole point of
 * having a format rather than a special case.
 *
 * The logs are committed so the numbers in docs/benchmarks.md are reproducible
 * from the repository alone, by anyone, without a phone or a network.
 */

const JOBS_DEFAULT = [
  { route: 'city', seed: 4242 },
  { route: 'city', seed: 1337 },
  { route: 'highway', seed: 4242 },
  { route: 'highway', seed: 1337 },
] as const;

function main(): void {
  const args = parseArgs(process.argv);
  const durationS = Number(args.duration ?? 180);
  const jobs = args.route
    ? [{ route: String(args.route), seed: Number(args.seed ?? 4242) }]
    : JOBS_DEFAULT;

  const outDir = join(ROOT, 'data', 'replay');
  mkdirSync(outDir, { recursive: true });

  console.log('');
  for (const job of jobs) {
    const route = JSON.parse(
      readFileSync(join(ROOT, 'data', 'routes', `route_${job.route}.json`), 'utf8'),
    ) as RouteGeoJson;

    const sim = new SimulationSource({
      route,
      seed: job.seed,
      vehicle: job.route === 'highway' ? HIGHWAY_VEHICLE : CITY_VEHICLE,
    });

    const lines: string[] = [];
    let imu = 0;
    let gnss = 0;
    for (const s of sim.advance(durationS * 1000)) {
      lines.push(JSON.stringify(s));
      if (s.imu) imu++;
      if (s.gnss) gnss++;
    }

    const name = `sim_${job.route}_${job.seed}.jsonl`;
    const body = `${lines.join('\n')}\n`;
    writeFileSync(join(outDir, name), body);
    console.log(
      `  ${name.padEnd(26)} ${String(lines.length).padStart(5)} samples  ` +
        `${String(imu).padStart(5)} imu  ${String(gnss).padStart(4)} gnss  ` +
        `${durationS}s  ${(body.length / 1024).toFixed(0)} KB`,
    );
  }

  console.log(`\n  wrote ${jobs.length} log(s) to data/replay/`);
  console.log('  SIMULATED — real drive logs belong alongside them as drive_*.jsonl\n');
}

main();
