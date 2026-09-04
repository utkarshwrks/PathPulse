import { createSocket, type Socket } from 'node:dgram';
import type { SensorSample } from '@pathpulse/nav-core';
import type { EdgeSource } from './types.js';

/**
 * An external IMU arriving over UDP.
 *
 * ★ WHY UDP IS THE RIGHT WIRE FOR THIS ★
 *
 * An inertial stream is a firehose of small, ordered, perishable messages. TCP
 * would retransmit a sample that arrived late — and a late IMU sample is not
 * useful, it is harmful: the engine's `dt` handling treats an out-of-order
 * timestamp as a clock jump and discards it, so the retransmission costs
 * latency and buys nothing. UDP drops it instead, which is the correct
 * behaviour, and the runner sees a rate slightly below nominal and says so.
 *
 * This is also what real inertial hardware speaks. A tactical-grade unit on a
 * vehicle bus emits UDP or serial, and rarely anything else.
 *
 * ★ THE WIRE FORMAT ★
 * One JSON object per datagram, matching `SensorSample`. JSON rather than a
 * packed binary struct on purpose: at 200 Hz it is a few hundred kilobytes a
 * second, which no link this runs on will notice, and a format you can read
 * with `nc -ul 5555` is a format you can debug on somebody else's hardware at
 * two in the morning. A binary codec is a worthwhile optimisation the day
 * somebody has a device that needs it.
 *
 *     { "t": 12345, "imu": { "ax": 0.1, "ay": 0, "az": 9.81,
 *                            "gx": 0, "gy": 0, "gz": 0.01 } }
 */
export class UdpImuSource implements EdgeSource {
  readonly name: string;
  private socket: Socket | null = null;
  private readonly queue: SensorSample[] = [];
  /** Resolvers waiting for a datagram that has not arrived yet. */
  private waiting: Array<(s: SensorSample | null) => void> = [];
  private closed = false;
  private dropped = 0;
  private malformed = 0;

  constructor(
    private readonly port = 5555,
    private readonly host = '0.0.0.0',
    /**
     * Ceiling on the queue.
     *
     * ★ AN UNBOUNDED QUEUE IS A CRASH WITH A DELAY ★ If the engine is slower
     * than the sender — which it is not, but the whole point of an edge
     * deliverable is that it runs on hardware nobody has described to us — an
     * unbounded queue grows until the process is killed. Dropping the OLDEST
     * is right: a navigation estimate wants the newest data, and the count is
     * reported so a drop is never silent.
     */
    private readonly maxQueue = 4000,
  ) {
    this.name = `UDP ${host}:${port}`;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;

      socket.on('message', (buffer) => this.ingest(buffer));
      socket.on('error', (err) => {
        // Resolve every waiter so the runner exits rather than hanging on a
        // socket that will never deliver again.
        this.closed = true;
        this.flushWaiters();
        reject(err);
      });
      socket.on('listening', () => resolve());
      socket.bind(this.port, this.host);
    });
  }

  private ingest(buffer: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      this.malformed++;
      return;
    }
    const sample = parsed as SensorSample;
    // A datagram with no usable timestamp cannot be placed in time, and the
    // engine would reject it anyway — count it rather than queue it.
    if (!sample || typeof sample.t !== 'number' || !Number.isFinite(sample.t)) {
      this.malformed++;
      return;
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(sample);
      return;
    }
    this.queue.push(sample);
    while (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
  }

  next(): Promise<SensorSample | null> | SensorSample | null {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.closed) return null;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Datagrams discarded, and why. Reported rather than hidden. */
  get stats(): { dropped: number; malformed: number; queued: number } {
    return { dropped: this.dropped, malformed: this.malformed, queued: this.queue.length };
  }

  close(): void {
    this.closed = true;
    this.flushWaiters();
    this.socket?.close();
    this.socket = null;
  }

  private flushWaiters(): void {
    const waiters = this.waiting;
    this.waiting = [];
    for (const resolve of waiters) resolve(null);
  }
}
