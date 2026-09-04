import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NavigationState } from '@pathpulse/nav-core';
import { UdpImuSource } from '../src/sources/UdpImuSource.js';
import { parseSerialLine } from '../src/sources/SerialImuSource.js';
import { FanOutSink, FileSink, UdpSink } from '../src/output.js';

/**
 * Phase 16 — the input adapters and output sinks that make this an ENGINE.
 *
 * ★ WHY THESE MATTER MORE THAN THEY LOOK ★
 * An edge deliverable that can only read a file it shipped with and only write
 * a file nobody reads is a demo. Being able to take an inertial stream off a
 * wire and hand the estimate to another process is the difference between a
 * program and something a manufacturer could embed — which is precisely what
 * the problem statement asks for.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const state = (t: number): NavigationState =>
  ({
    t,
    mode: 'GNSS',
    position: { lat: 23.16, lon: 79.93 },
    velocityMps: 12,
    headingDeg: 90,
    covariance: { alongM: 5, crossM: 5, headingDeg: 1 },
    confidence: 1,
    distanceTravelledM: t,
    timeSinceGnssMs: 0,
    estimatedDriftM: 0,
    biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
  }) as NavigationState;

/** Free port, chosen high to avoid anything a developer machine is running. */
const port = () => 41_000 + Math.floor(Math.random() * 20_000);

describe('UdpImuSource', () => {
  it('receives a datagram and hands it to the runner', async () => {
    const p = port();
    const source = new UdpImuSource(p);
    await source.open();
    cleanups.push(() => source.close());

    const client = createSocket('udp4');
    cleanups.push(() => client.close());
    const pending = source.next();
    client.send(
      Buffer.from(JSON.stringify({ t: 1234, imu: { ax: 1, ay: 2, az: 9.8, gx: 0, gy: 0, gz: 0 } })),
      p,
      '127.0.0.1',
    );

    const sample = await pending;
    expect(sample).not.toBeNull();
    expect(sample!.t).toBe(1234);
    expect(sample!.imu!.ax).toBeCloseTo(1, 6);
  });

  it('queues datagrams that arrive before anybody asks', async () => {
    const p = port();
    const source = new UdpImuSource(p);
    await source.open();
    cleanups.push(() => source.close());

    const client = createSocket('udp4');
    cleanups.push(() => client.close());
    for (let i = 0; i < 3; i++) {
      client.send(Buffer.from(JSON.stringify({ t: i, imu: { ax: 0, ay: 0, az: 9.8, gx: 0, gy: 0, gz: 0 } })), p, '127.0.0.1');
    }
    await new Promise((r) => setTimeout(r, 120));

    expect((await source.next())!.t).toBe(0);
    expect((await source.next())!.t).toBe(1);
    expect((await source.next())!.t).toBe(2);
  });

  it('★ counts a malformed datagram rather than crashing on it', async () => {
    // A UDP port is open to whatever is on the network. A stray packet, a
    // truncated one, or somebody else's protocol must not take the navigation
    // engine down — and must not be silently indistinguishable from a gap.
    const p = port();
    const source = new UdpImuSource(p);
    await source.open();
    cleanups.push(() => source.close());

    const client = createSocket('udp4');
    cleanups.push(() => client.close());
    client.send(Buffer.from('not json at all'), p, '127.0.0.1');
    client.send(Buffer.from(JSON.stringify({ imu: { ax: 1 } })), p, '127.0.0.1'); // no timestamp
    await new Promise((r) => setTimeout(r, 120));

    expect(source.stats.malformed).toBe(2);
    expect(source.stats.queued).toBe(0);
  });

  it('returns null once closed, so the runner exits instead of hanging', async () => {
    const source = new UdpImuSource(port());
    await source.open();
    const pending = source.next();
    source.close();
    expect(await pending).toBeNull();
    expect(source.next()).toBeNull();
  });
});

describe('the serial wire format', () => {
  it('reads the CSV a microcontroller emits by default', () => {
    // t,ax,ay,az,gx,gy,gz — what a board bridging an IMU to UART sends when
    // nobody has told it otherwise. A format that needs a firmware change
    // before it can be tested is a format tested the night before the demo.
    const s = parseSerialLine('1000,0.1,0.2,9.81,0.01,0,-0.02');
    expect(s!.t).toBe(1000);
    expect(s!.imu!.az).toBeCloseTo(9.81, 6);
    expect(s!.imu!.gz).toBeCloseTo(-0.02, 6);
  });

  it('reads whitespace-separated values too', () => {
    expect(parseSerialLine('2000 0 0 9.8 0 0 0')!.t).toBe(2000);
  });

  it('reads the same JSON the UDP path uses', () => {
    const s = parseSerialLine('{"t":3000,"imu":{"ax":0,"ay":0,"az":9.8,"gx":0,"gy":0,"gz":0}}');
    expect(s!.t).toBe(3000);
  });

  it('rejects a truncated line rather than inventing a sample', () => {
    // Serial reads land mid-line far more often than not.
    expect(parseSerialLine('1000,0.1,0.2')).toBeNull();
    expect(parseSerialLine('1000,0.1,0.2,9.81,0.01,0,abc')).toBeNull();
    expect(parseSerialLine('')).toBeNull();
    expect(parseSerialLine('{"t":')).toBeNull();
  });
});

describe('output sinks', () => {
  it('writes JSON lines to a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathpulse-edge-'));
    const path = join(dir, 'states.jsonl');
    const sink = new FileSink(path, 2);
    for (let i = 0; i < 5; i++) sink.write(state(i));
    sink.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[4]!).t).toBe(4);
  });

  it('★ flushes on close, so an interrupted run is not an empty file', () => {
    // The buffer exists because 200 Hz of syscalls is 200 Hz of syscalls. It
    // must not mean that anything short of a full buffer is lost.
    const dir = mkdtempSync(join(tmpdir(), 'pathpulse-edge-'));
    const path = join(dir, 'partial.jsonl');
    const sink = new FileSink(path, 1000);
    sink.write(state(1));
    sink.close();
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('broadcasts a NavigationState over UDP', async () => {
    const p = port();
    const listener = createSocket('udp4');
    cleanups.push(() => listener.close());
    const received = new Promise<string>((resolve) => {
      listener.on('message', (b) => resolve(b.toString('utf8')));
    });
    await new Promise<void>((resolve) => listener.bind(p, resolve));

    const sink = new UdpSink(p, '127.0.0.1');
    sink.write(state(42));
    const payload = JSON.parse(await received);
    expect(payload.t).toBe(42);
    expect(payload.position.lat).toBeCloseTo(23.16, 6);
    sink.close();
  });

  it('fans out to several sinks at once, which is the usual case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathpulse-edge-'));
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    const sink = new FanOutSink([new FileSink(a, 1), new FileSink(b, 1)]);
    sink.write(state(7));
    sink.close();
    expect(readFileSync(a, 'utf8')).toContain('"t":7');
    expect(readFileSync(b, 'utf8')).toContain('"t":7');
    expect(sink.name).toContain('+');
  });
});
