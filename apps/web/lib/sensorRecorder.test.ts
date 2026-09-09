import { describe, expect, it } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import { MAX_SAMPLES, SensorRecorder } from './sensorRecorder';

function sample(t: number, withGnss = false): SensorSample {
  const s: SensorSample = {
    t,
    imu: {
      ax: -0.000029710598293206253,
      ay: 1.5391234,
      az: 9.8338,
      gx: 0.0001,
      gy: -0.0002,
      gz: -0.0606999902546159,
    },
  };
  if (withGnss) {
    s.gnss = { lat: 23.1686123456, lon: 79.9339987654, accuracyM: 3, speedMps: 8.31, headingDeg: 187.4 };
  }
  return s;
}

describe('SensorRecorder', () => {
  it('keeps nothing until it is started', () => {
    const r = new SensorRecorder();
    r.push(sample(0));
    expect(r.state.samples).toBe(0);
    expect(r.toJsonl()).toBe('');
  });

  it('★ writes the replay format, one object per line', () => {
    const r = new SensorRecorder();
    r.start();
    r.push(sample(100));
    r.push(sample(200, true));
    const lines = r.toJsonl().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    expect(a.t).toBe(100);
    expect(typeof a.imu.ax).toBe('number');
    expect(a.gnss).toBeUndefined();
    expect(b.gnss.lat).toBeCloseTo(23.1686123, 6);
    expect(b.gnss.speedMps).toBeCloseTo(8.31, 3);
  });

  it('★ rounds to what the sensor actually resolved', () => {
    // A raw double prints as twenty-four characters carrying about four bits
    // of real information. On a phone the difference is a share sheet that
    // works and one that hangs.
    const r = new SensorRecorder();
    r.start();
    r.push(sample(100));
    const raw = JSON.stringify({ t: 100, imu: sample(100).imu });
    expect(r.toJsonl().length).toBeLessThan(raw.length);
    expect(r.toJsonl()).not.toContain('0.000029710598293206253');
  });

  it('keeps the OLDEST samples when it fills, not the newest', () => {
    // A dead-reckoning log is only meaningful from the start: the outage has
    // to be preceded by the GNSS that seeded it.
    const r = new SensorRecorder();
    r.start();
    for (let i = 0; i < MAX_SAMPLES + 50; i++) r.push(sample(i));
    expect(r.state.samples).toBe(MAX_SAMPLES);
    expect(r.state.truncated).toBe(true);
    expect(JSON.parse(r.toJsonl().split('\n')[0]!).t).toBe(0);
  });

  it('stops and starts cleanly', () => {
    const r = new SensorRecorder();
    r.start();
    r.push(sample(1));
    r.stop();
    r.push(sample(2));
    expect(r.state.samples).toBe(1);
    r.start();
    expect(r.state.samples).toBe(0);
  });

  it('★ names the file so tierOf() classifies it Tier F', () => {
    // The drive_ prefix is load-bearing, not decorative.
    const r = new SensorRecorder();
    r.start();
    expect(r.fileName()).toMatch(/^drive_\d{8}_\d{4}\.jsonl$/);
  });

  it('a malformed sample costs one line, not the ride', () => {
    const r = new SensorRecorder();
    r.start();
    r.push(sample(1));
    r.push({ t: 2, imu: { ax: NaN, ay: NaN, az: NaN, gx: NaN, gy: NaN, gz: NaN } });
    r.push(sample(3));
    expect(r.state.samples).toBe(3);
    for (const l of r.toJsonl().trimEnd().split('\n')) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  it('reports a size the rider can act on', () => {
    const r = new SensorRecorder();
    r.start();
    for (let i = 0; i < 1000; i++) r.push(sample(i));
    expect(r.state.bytes).toBeGreaterThan(1000);
    expect(r.state.bytes / r.state.samples).toBeLessThan(200);
  });
});
