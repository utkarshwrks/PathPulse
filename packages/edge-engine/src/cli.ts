#!/usr/bin/env tsx
/**
 * pathpulse-edge — the edge-deployable navigation engine.
 *
 * The same @pathpulse/nav-core that runs inside the Android app, running
 * outside a phone against an external inertial stream. Required by SIH26168:
 * "The final deliverable must be a working mobile application AND an Edge
 * deployable software engine."
 */
import { runEdge } from './runner.js';
import { GRADES, gyroBiasDegPerHour, parseGrade, type ImuGrade } from './grades.js';
import { FogSimulatorSource } from './sources/FogSimulatorSource.js';
import { ReplayFileSource } from './sources/ReplayFileSource.js';
import { UdpImuSource } from './sources/UdpImuSource.js';
import { SerialImuSource } from './sources/SerialImuSource.js';
import { FanOutSink, FileSink, StdoutSink, UdpSink, type StateSink } from './output.js';
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
  pnpm edge --udp-in 5555 --rate 200 --udp-out 5556
  pnpm edge --serial /dev/ttyUSB0 --baud 921600 --rate 200 --stdout | jq .

INPUT  (exactly one; defaults to the simulator)
  --grade <name>     PHONE_MEMS | TACTICAL | FOG        (default FOG)
  --replay <file>    .jsonl or .csv of recorded IMU data
  --udp-in <port>    listen for JSON IMU datagrams
  --serial <path>    read an IMU from a serial port (needs the serialport pkg)
  --baud <rate>      serial baud rate                   (default 921600)

OUTPUT  (any combination; defaults to none but the summary)
  --json <file>      NavigationState as JSON lines
  --stdout           NavigationState as JSON lines on stdout, for piping
  --udp-out <port>   broadcast each NavigationState as a JSON datagram
  --udp-host <host>  where to send them                 (default 127.0.0.1)

OPTIONS
  --rate <hz>        target output rate                 (default: grade nominal)
  --seconds <s>      how much stream to run             (default 60)
  --gnss <ms>        emit a simulated fix this often; 0 = pure INS  (default 0)
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
  if (args['udp-in']) {
    // A live stream has no natural end, so the sample budget still bounds the
    // run — otherwise `--seconds` would be silently ignored on the one input
    // where a user is most likely to want it.
    source = new UdpImuSource(Number(args['udp-in']));
    maxSamples = Math.round(seconds * rateHz);
  } else if (args.serial) {
    source = new SerialImuSource({
      path: String(args.serial),
      ...(args.baud ? { baudRate: Number(args.baud) } : {}),
    });
    maxSamples = Math.round(seconds * rateHz);
  } else if (replay) {
    source = new ReplayFileSource(replay);
  } else {
    source = new FogSimulatorSource({
      grade,
      periodMs: 1000 / rateHz,
      gnssIntervalMs: args.gnss ? Number(args.gnss) : 0,
    });
    maxSamples = Math.round(seconds * rateHz);
  }

  // ★ SINKS ARE STREAMED, NOT ACCUMULATED ★ The first version collected every
  // NavigationState in an array and wrote it at the end. At 200 Hz a ten-minute
  // run is 120,000 objects held in memory for no reason, and a run that is
  // interrupted — which a live UDP or serial stream frequently is — wrote
  // nothing at all. Each sink now writes as it goes.
  const sinks: StateSink[] = [];
  if (args.json) sinks.push(new FileSink(String(args.json)));
  if (args.stdout) sinks.push(new StdoutSink());
  if (args['udp-out']) {
    sinks.push(
      new UdpSink(Number(args['udp-out']), args['udp-host'] ? String(args['udp-host']) : undefined),
    );
  }
  const sink: StateSink | null = sinks.length === 0 ? null : new FanOutSink(sinks);
  const onState = sink ? (s: NavigationState) => sink.write(s) : undefined;

  console.log(
    `\n  pathpulse-edge  ·  ${GRADES[grade].label}  ·  target ${rateHz} Hz  ·  ${source.name}`,
  );
  if (sink) console.log(`  output → ${sink.name}`);
  if (!replay && !args['udp-in'] && !args.serial) {
    console.log(`  SIMULATED inertial stream — not a recording of real hardware.`);
  }

  const report = await runEdge({ source, grade, rateHz, maxSamples, ...(onState ? { onState } : {}) });

  sink?.close();

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
  if (sink) console.log(`  output written to         ${sink.name}`);

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
