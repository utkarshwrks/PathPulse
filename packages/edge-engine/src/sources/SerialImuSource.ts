import type { SensorSample } from '@pathpulse/nav-core';
import type { EdgeSource } from './types.js';

/**
 * An external IMU on a serial port (UART), the way most inertial units ship.
 *
 * ★ WHY serialport IS AN OPTIONAL DEPENDENCY ★
 *
 * `serialport` contains a native binding that is compiled per platform and per
 * Node ABI. Making it a hard dependency means every clone, every CI run and
 * every Docker build compiles a C++ addon in order to run tests that never
 * open a serial port — and it means the whole edge engine fails to install on
 * any platform where that build breaks.
 *
 * So it is imported at runtime, only when a serial port is actually asked for,
 * and its absence is a clear message rather than a crash on import:
 *
 *     pnpm add serialport --filter @pathpulse/edge-engine
 *
 * ★ THE WIRE FORMAT ★
 * Newline-delimited, one reading per line, either JSON (as UDP uses) or a
 * bare CSV of `t,ax,ay,az,gx,gy,gz`. CSV is there because that is what a
 * microcontroller bridging an IMU to UART emits when nobody has told it
 * otherwise, and a format that needs firmware changes before you can test it
 * is a format that gets tested the night before the demo.
 */
export interface SerialImuOptions {
  path: string;
  baudRate?: number;
  /** Milliseconds of silence before the stream is treated as finished. */
  idleTimeoutMs?: number;
}

export function parseSerialLine(line: string): SensorSample | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as SensorSample;
      return typeof parsed?.t === 'number' && Number.isFinite(parsed.t) ? parsed : null;
    } catch {
      return null;
    }
  }

  // t,ax,ay,az,gx,gy,gz
  const parts = trimmed.split(/[,\s]+/).map(Number);
  if (parts.length < 7 || parts.some((v) => !Number.isFinite(v))) return null;
  const [t, ax, ay, az, gx, gy, gz] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { t, imu: { ax, ay, az, gx, gy, gz } };
}

export class SerialImuSource implements EdgeSource {
  readonly name: string;
  private port: { close(cb?: () => void): void } | null = null;
  private readonly queue: SensorSample[] = [];
  private waiting: Array<(s: SensorSample | null) => void> = [];
  private buffer = '';
  private closed = false;
  private malformed = 0;

  constructor(private readonly options: SerialImuOptions) {
    this.name = `serial ${options.path} @ ${options.baudRate ?? 921_600}`;
  }

  async open(): Promise<void> {
    let SerialPortCtor: new (opts: { path: string; baudRate: number }) => {
      on(event: string, cb: (chunk: Buffer) => void): void;
      close(cb?: () => void): void;
    };
    try {
      // Dynamic AND through a variable, so the package installs, typechecks
      // and tests without the native module present. A literal import
      // specifier would make `tsc` demand the types of a package that is
      // deliberately not installed.
      const specifier = 'serialport';
      const mod = (await import(specifier)) as { SerialPort: typeof SerialPortCtor };
      SerialPortCtor = mod.SerialPort;
    } catch {
      throw new Error(
        'serial input needs the optional `serialport` package:\n' +
          '  pnpm add serialport --filter @pathpulse/edge-engine\n' +
          'It is optional because it builds a native addon, and the engine must ' +
          'install and test on machines that will never open a serial port.',
      );
    }

    const port = new SerialPortCtor({
      path: this.options.path,
      // 921600 is what most tactical-grade units default to at 200 Hz; below
      // about 460800 a six-axis stream at that rate does not fit on the wire.
      baudRate: this.options.baudRate ?? 921_600,
    });
    this.port = port;
    port.on('data', (chunk: Buffer) => this.ingest(chunk));
    port.on('close', () => {
      this.closed = true;
      this.flushWaiters();
    });
  }

  private ingest(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    // Split on newlines and keep the tail: a serial read lands mid-line far
    // more often than not, and parsing a half line silently drops the sample.
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const sample = parseSerialLine(line);
      if (!sample) {
        if (line.trim()) this.malformed++;
        continue;
      }
      const waiter = this.waiting.shift();
      if (waiter) waiter(sample);
      else this.queue.push(sample);
    }
  }

  next(): Promise<SensorSample | null> | SensorSample | null {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.closed) return null;
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      const timeout = this.options.idleTimeoutMs ?? 5000;
      // A port that has gone quiet is a finished stream, not a hang. Without
      // this the runner waits for a device that has been unplugged.
      setTimeout(() => {
        const index = this.waiting.indexOf(resolve);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          resolve(null);
        }
      }, timeout).unref?.();
    });
  }

  get stats(): { malformed: number; queued: number } {
    return { malformed: this.malformed, queued: this.queue.length };
  }

  close(): void {
    this.closed = true;
    this.flushWaiters();
    this.port?.close();
    this.port = null;
  }

  private flushWaiters(): void {
    const waiters = this.waiting;
    this.waiting = [];
    for (const resolve of waiters) resolve(null);
  }
}
