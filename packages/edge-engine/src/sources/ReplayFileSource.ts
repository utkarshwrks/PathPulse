import { readFileSync } from 'node:fs';
import type { SensorSample } from '@pathpulse/nav-core';
import type { EdgeSource } from './types.js';

/**
 * A recorded IMU log, replayed as fast as the engine can consume it.
 *
 * Accepts the project's own JSONL (one SensorSample per line), so a log
 * recorded on a phone and a log from an external logger go through the exact
 * same code path — which is the property that makes the edge engine a port of
 * the mobile pipeline rather than a parallel implementation of it.
 *
 * Also accepts plain CSV, because most external IMUs and lab loggers emit that
 * and requiring them to be converted first would put a translation step
 * between us and the only real external data we are likely to get.
 */
export class ReplayFileSource implements EdgeSource {
  readonly name: string;
  private samples: SensorSample[] = [];
  private i = 0;

  constructor(private readonly path: string) {
    this.name = `replay:${path.split('/').pop() ?? path}`;
  }

  open(): void {
    const text = readFileSync(this.path, 'utf8').trim();
    if (!text) throw new Error(`${this.path} is empty`);
    this.samples = this.path.toLowerCase().endsWith('.csv')
      ? parseCsv(text)
      : parseJsonl(text);
    if (this.samples.length === 0) {
      throw new Error(`${this.path} produced no usable samples`);
    }
  }

  next(): SensorSample | null {
    return this.i < this.samples.length ? this.samples[this.i++]! : null;
  }

  get total(): number {
    return this.samples.length;
  }
}

export function parseJsonl(text: string): SensorSample[] {
  const out: SensorSample[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s) as SensorSample;
      if (typeof parsed.t === 'number' && Number.isFinite(parsed.t)) out.push(parsed);
    } catch {
      // One malformed line must not lose the rest of a long recording. The
      // count is reported, so a file that is largely junk is visible rather
      // than silently producing a short run.
    }
  }
  return out;
}

/**
 * CSV with a header row. Recognised columns, case-insensitive:
 *   t | time | timestamp        ms, monotonic
 *   ax, ay, az                  specific force, m/s^2, INCLUDING gravity
 *   gx, gy, gz                  angular rate, rad/s, right-hand rule
 *   lat, lon, acc               optional GNSS
 *
 * ★ UNITS ARE NOT GUESSED ★
 * A logger emitting deg/s or g would be silently wrong by a factor of 57 or
 * 9.81, and the estimator would produce confident nonsense. There is no
 * sniffing here: the contract is documented, and `--gyro-deg` / `--accel-g`
 * convert explicitly when the operator says so.
 */
export function parseCsv(
  text: string,
  opts: { gyroDeg?: boolean; accelG?: boolean } = {},
): SensorSample[] {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iT = col('t', 'time', 'timestamp', 'time_ms');
  const iAx = col('ax', 'accel_x');
  const iAy = col('ay', 'accel_y');
  const iAz = col('az', 'accel_z');
  const iGx = col('gx', 'gyro_x');
  const iGy = col('gy', 'gyro_y');
  const iGz = col('gz', 'gyro_z');
  const iLat = col('lat', 'latitude');
  const iLon = col('lon', 'longitude');
  const iAcc = col('acc', 'accuracy', 'accuracym');

  if (iT < 0 || iAx < 0 || iGz < 0) {
    throw new Error(
      'CSV needs at least a time column (t/time/timestamp), ax/ay/az and gx/gy/gz',
    );
  }

  const gyroScale = opts.gyroDeg ? Math.PI / 180 : 1;
  const accelScale = opts.accelG ? 9.80665 : 1;
  const num = (parts: string[], i: number): number =>
    i >= 0 ? Number(parts[i]) : Number.NaN;

  const out: SensorSample[] = [];
  for (let r = 1; r < lines.length; r++) {
    const parts = lines[r]!.split(',');
    const t = num(parts, iT);
    if (!Number.isFinite(t)) continue;
    const sample: SensorSample = {
      t,
      imu: {
        ax: num(parts, iAx) * accelScale,
        ay: num(parts, iAy) * accelScale,
        az: num(parts, iAz) * accelScale,
        gx: num(parts, iGx) * gyroScale,
        gy: num(parts, iGy) * gyroScale,
        gz: num(parts, iGz) * gyroScale,
      },
    };
    const lat = num(parts, iLat);
    const lon = num(parts, iLon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const acc = num(parts, iAcc);
      sample.gnss = { lat, lon, accuracyM: Number.isFinite(acc) ? acc : 5 };
    }
    out.push(sample);
  }
  return out;
}
