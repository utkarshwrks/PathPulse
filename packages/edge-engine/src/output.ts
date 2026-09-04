import { createSocket } from 'node:dgram';
import { appendFileSync, writeFileSync } from 'node:fs';
import type { NavigationState } from '@pathpulse/nav-core';

/**
 * Where the engine's output goes.
 *
 * The problem statement asks for "NavigationState 200 Hz pe, JSON stdout / UDP
 * / file". Three sinks, one interface, because an edge deliverable that can
 * only write a file is one that cannot be plugged into anything.
 *
 * ★ EACH SINK EXISTS FOR A DIFFERENT CONSUMER ★
 *   file    the eval harness and anyone reading the run afterwards
 *   stdout  a pipe — `pathpulse-edge ... | jq`, or a supervisor that reads it
 *   udp     a vehicle bus, a display head unit, or another process on another
 *           machine. This is the one that makes it an ENGINE rather than a
 *           program: something else can consume the estimate live.
 */
export interface StateSink {
  readonly name: string;
  write(state: NavigationState): void;
  close(): void;
}

/** JSON lines to a file. Buffered, because 200 Hz of syscalls is 200 Hz of syscalls. */
export class FileSink implements StateSink {
  readonly name: string;
  private buffer: string[] = [];

  constructor(
    private readonly path: string,
    private readonly flushEvery = 500,
  ) {
    this.name = `file ${path}`;
    writeFileSync(path, '');
  }

  write(state: NavigationState): void {
    this.buffer.push(JSON.stringify(state));
    if (this.buffer.length >= this.flushEvery) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    appendFileSync(this.path, `${this.buffer.join('\n')}\n`);
    this.buffer = [];
  }

  close(): void {
    this.flush();
  }
}

/** JSON lines to stdout, for piping. */
export class StdoutSink implements StateSink {
  readonly name = 'stdout';

  write(state: NavigationState): void {
    process.stdout.write(`${JSON.stringify(state)}\n`);
  }

  close(): void {
    // Nothing to release. Deliberately does NOT end stdout: the CLI still has
    // its report to print, and closing the stream here would swallow it.
  }
}

/**
 * JSON datagrams to a UDP endpoint.
 *
 * ★ FIRE AND FORGET, ON PURPOSE ★ The estimate is perishable: a consumer that
 * missed the state from 5 ms ago wants the current one, not a retransmission
 * of a stale one. Send errors are counted rather than thrown, because a
 * navigation engine must not stop navigating because a display went away.
 */
export class UdpSink implements StateSink {
  readonly name: string;
  private readonly socket = createSocket('udp4');
  private failures = 0;
  private sent = 0;

  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1',
  ) {
    this.name = `udp ${host}:${port}`;
    this.socket.on('error', () => {
      this.failures++;
    });
  }

  write(state: NavigationState): void {
    const payload = Buffer.from(JSON.stringify(state));
    this.socket.send(payload, this.port, this.host, (err) => {
      if (err) this.failures++;
      else this.sent++;
    });
  }

  get stats(): { sent: number; failures: number } {
    return { sent: this.sent, failures: this.failures };
  }

  close(): void {
    this.socket.close();
  }
}

/** Several sinks at once — write to a file AND broadcast, which is the usual case. */
export class FanOutSink implements StateSink {
  readonly name: string;

  constructor(private readonly sinks: StateSink[]) {
    this.name = sinks.map((s) => s.name).join(' + ');
  }

  write(state: NavigationState): void {
    for (const sink of this.sinks) sink.write(state);
  }

  close(): void {
    for (const sink of this.sinks) sink.close();
  }
}
