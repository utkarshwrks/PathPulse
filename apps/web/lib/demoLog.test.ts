import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_SCRIPT, DEMO_TOTAL_MS } from './demoScript';

/**
 * The backup demo log.
 *
 * ★ A BACKUP THAT HAS NEVER BEEN CHECKED IS NOT A BACKUP ★
 * This file exists to be played on the one day everything else has gone wrong.
 * If the outage window in it has drifted from the script, or a regeneration
 * trimmed it short, nobody finds out until exactly the moment it matters. It
 * is a build artefact, so it is asserted like one.
 */

// A plain path, not import.meta.url: the jsdom environment resolves that to
// an http URL and readFileSync refuses it.
const LOG = resolve(process.cwd(), 'public/replay/demo.jsonl');

interface Sample {
  t: number;
  gnss?: { lat: number; lon: number };
  imu?: { ax: number };
}

const samples: Sample[] = readFileSync(LOG, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Sample);

describe('demo.jsonl', () => {
  it('is present and substantial', () => {
    expect(samples.length).toBeGreaterThan(1000);
  });

  it('★ has a real GNSS gap where the script expects the outage', () => {
    const outage = DEMO_SCRIPT.find((p) => p.kind === 'OUTAGE')!;
    const recovery = DEMO_SCRIPT.find((p) => p.kind === 'RECOVERY')!;
    const inWindow = samples.filter(
      (s) => s.t >= outage.atMs && s.t < recovery.atMs && s.gnss,
    );
    expect(inWindow).toHaveLength(0);
  });

  it('★ has GNSS before and after the outage, or there is nothing to recover to', () => {
    const outage = DEMO_SCRIPT.find((p) => p.kind === 'OUTAGE')!;
    const recovery = DEMO_SCRIPT.find((p) => p.kind === 'RECOVERY')!;
    expect(samples.some((s) => s.t < outage.atMs && s.gnss)).toBe(true);
    expect(samples.some((s) => s.t >= recovery.atMs && s.gnss)).toBe(true);
  });

  it('★ outlasts the script, so the demo does not stop mid-sentence', () => {
    const last = samples[samples.length - 1]!;
    expect(last.t).toBeGreaterThan(DEMO_TOTAL_MS);
  });

  it('keeps the IMU through the outage — dead reckoning needs something to run on', () => {
    const outage = DEMO_SCRIPT.find((p) => p.kind === 'OUTAGE')!;
    const imuInWindow = samples.filter((s) => s.t >= outage.atMs && s.t < outage.atMs + 5000 && s.imu);
    expect(imuInWindow.length).toBeGreaterThan(100);
  });

  it('is monotonic in time', () => {
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.t).toBeGreaterThanOrEqual(samples[i - 1]!.t);
    }
  });

  it('carries no non-finite coordinate', () => {
    for (const s of samples) {
      if (!s.gnss) continue;
      expect(Number.isFinite(s.gnss.lat)).toBe(true);
      expect(Number.isFinite(s.gnss.lon)).toBe(true);
    }
  });
});
