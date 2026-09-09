import type { SensorSample } from '@pathpulse/nav-core';

/**
 * Record the raw sensor stream on the handset, in the format the replay
 * harness already reads.
 *
 * ★ WHY THIS HAS TO EXIST ★
 *
 * `pnpm eval:record` runs on a laptop. Nobody takes a laptop on a scooter, so
 * every real-world failure this project has fixed was diagnosed from
 * screenshots and a video — a rider reading numbers off a HUD at 40 km/h.
 * That works for "the badge says ON FOOT and it should not", and it cannot
 * work for anything quantitative: there is no way to replay a screenshot, no
 * way to score it, and no way to tell whether a change helped.
 *
 * MASTER.md §22 has said "what we have never measured: a drive with our own
 * phone, in our own vehicle, against surveyed ground truth" since it was
 * written, and Tier F has been the blocker on every dead-reckoning decision
 * since. Tier S is a simulator containing no flyovers, no dense grids, no
 * two-wheeler vibration and no mounted-phone ambiguity; it has already
 * overruled real-device evidence once and been wrong.
 *
 * The samples were always there. `useNavigationEngine.feed` is the single
 * point every one of them passes through. Nothing had to be sensed, only kept.
 *
 * ★ THE FORMAT IS THE REPLAY FORMAT, EXACTLY ★
 *
 * One JSON object per line, `{t, imu, gnss?}` — byte-compatible with
 * `data/replay/*.jsonl` and with `parseJsonl` in the eval harness. Not a new
 * format to convert: drop the file into `data/replay/` as `drive_*.jsonl` and
 * `tierOf()` classifies it Tier F and every existing tool reads it.
 */

/**
 * ★ A RIDE MUST NOT BE ABLE TO EXHAUST THE HANDSET ★
 *
 * The IMU arrives at about 127 Hz. A twenty-minute ride is 152,000 samples,
 * and at roughly 200 bytes of JSON each that is 30 MB held in a WebView that
 * is also running a map, a road graph and a neural network. Dropping the app
 * at minute nineteen of a twenty-minute ride would waste the whole ride, which
 * is worse than recording less of it.
 *
 * So the buffer is bounded and it keeps the OLDEST samples rather than the
 * newest. A dead-reckoning log is only meaningful from the start: the outage
 * has to be preceded by the GNSS that seeded it, and a ring buffer that
 * discarded the beginning would hand back the least useful half.
 */
export const MAX_SAMPLES = 240_000;

export interface RecorderState {
  recording: boolean;
  samples: number;
  /** Approximate size of the file this would write, bytes. */
  bytes: number;
  /** True once MAX_SAMPLES was hit and later samples were dropped. */
  truncated: boolean;
  startedAtMs: number | null;
}

const EMPTY: RecorderState = {
  recording: false,
  samples: 0,
  bytes: 0,
  truncated: false,
  startedAtMs: null,
};

/**
 * One line of the replay format.
 *
 * ★ ROUNDED, AND NOT FOR PRETTINESS ★ A raw double prints as
 * `-0.000029710598293206253` — twenty-four characters carrying about four
 * bits of real information, because the sensor's own resolution is nowhere
 * near that. Six decimal places on the IMU and seven on lat/lon keep
 * everything the hardware actually measured and take the file to a third of
 * the size, which on a phone is the difference between a share sheet that
 * works and one that hangs.
 */
function line(s: SensorSample): string {
  const n = (v: number, dp: number): number => {
    if (!Number.isFinite(v)) return 0;
    const f = 10 ** dp;
    return Math.round(v * f) / f;
  };
  // The IMU is optional on the type — a GNSS-only sample is legal — and a
  // replay line without one is legal too. Zeroing it would invent a reading.
  const imu = s.imu;
  const out: Record<string, unknown> = { t: Math.round(s.t) };
  if (imu) {
    out.imu = {
      ax: n(imu.ax, 6),
      ay: n(imu.ay, 6),
      az: n(imu.az, 6),
      gx: n(imu.gx, 6),
      gy: n(imu.gy, 6),
      gz: n(imu.gz, 6),
    };
  }
  if (s.mag) {
    // Kept when the handset reports it. The replay corpus has none — IO-VNBD
    // did not log a magnetometer — so every heading finding so far has been
    // made without one. A Tier F log that carries it is the first chance to
    // find out what it is worth.
    out.mag = { mx: n(s.mag.mx, 4), my: n(s.mag.my, 4), mz: n(s.mag.mz, 4) };
  }
  if (s.gnss) {
    const g: Record<string, number> = {
      lat: n(s.gnss.lat, 7),
      lon: n(s.gnss.lon, 7),
      accuracyM: n(s.gnss.accuracyM, 2),
    };
    if (s.gnss.speedMps !== undefined) g.speedMps = n(s.gnss.speedMps, 3);
    if (s.gnss.headingDeg !== undefined) g.headingDeg = n(s.gnss.headingDeg, 2);
    if (s.gnss.satCount !== undefined) g.satCount = Math.round(s.gnss.satCount);
    // Quality fields the GNSS classifier reads. Cheap to keep and impossible
    // to reconstruct afterwards.
    if (s.gnss.meanCn0 !== undefined) g.meanCn0 = n(s.gnss.meanCn0, 2);
    if (s.gnss.hdop !== undefined) g.hdop = n(s.gnss.hdop, 2);
    out.gnss = g;
  }
  return JSON.stringify(out);
}

/**
 * Buffers raw samples and writes them out as replay JSONL.
 *
 * Deliberately a plain class with no React in it: a recorder that re-rendered
 * on every sample would cost more than the recording.
 */
export class SensorRecorder {
  private lines: string[] = [];
  private bytes = 0;
  private isRecording = false;
  private truncated = false;
  private startedAtMs: number | null = null;

  get state(): RecorderState {
    return {
      recording: this.isRecording,
      samples: this.lines.length,
      bytes: this.bytes,
      truncated: this.truncated,
      startedAtMs: this.startedAtMs,
    };
  }

  start(): void {
    this.lines = [];
    this.bytes = 0;
    this.truncated = false;
    this.isRecording = true;
    this.startedAtMs = Date.now();
  }

  stop(): void {
    this.isRecording = false;
  }

  /**
   * Offer a sample. Cheap and total: called at 127 Hz on the same path the
   * estimator runs on, so it must never throw and never allocate more than the
   * one string it keeps.
   */
  push(sample: SensorSample): void {
    if (!this.isRecording) return;
    if (this.lines.length >= MAX_SAMPLES) {
      this.truncated = true;
      return;
    }
    try {
      const l = line(sample);
      this.lines.push(l);
      this.bytes += l.length + 1;
    } catch {
      // A malformed sample is one lost line, not a lost ride.
    }
  }

  /** The file contents, in replay JSONL. Empty string when nothing was kept. */
  toJsonl(): string {
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }

  /**
   * `drive_YYYYMMDD_HHMM.jsonl` — the `drive_` prefix is what `tierOf()` keys
   * on to classify a log as Tier F, so the name is load-bearing rather than
   * decorative.
   */
  fileName(): string {
    const d = new Date(this.startedAtMs ?? Date.now());
    const p = (v: number) => String(v).padStart(2, '0');
    return (
      `drive_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `_${p(d.getHours())}${p(d.getMinutes())}.jsonl`
    );
  }

  reset(): void {
    this.lines = [];
    this.bytes = 0;
    this.isRecording = false;
    this.truncated = false;
    this.startedAtMs = null;
  }
}

export const EMPTY_RECORDER_STATE = EMPTY;
