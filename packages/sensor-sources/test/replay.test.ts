import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import {
  RecordingWrapper,
  ReplaySource,
  SimulationSource,
  type RouteGeoJson,
} from '../src/index.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const city = JSON.parse(
  readFileSync(ROOT + 'data/routes/route_city.json', 'utf8'),
) as RouteGeoJson;

describe('ReplaySource', () => {
  const samples: SensorSample[] = [
    { t: 0, imu: { ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 } },
    { t: 20, imu: { ax: 1, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 } },
    { t: 40, imu: { ax: 2, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }, gnss: { lat: 28.6, lon: 77.2, accuracyM: 4 } },
  ];

  it('replays samples in order', () => {
    const src = new ReplaySource(samples);
    const seen: number[] = [];
    src.onSample((s) => seen.push(s.t));
    src.stepOnce();
    src.stepOnce();
    src.stepOnce();
    expect(seen).toEqual([0, 20, 40]);
  });

  it('returns null past the end instead of throwing', () => {
    const src = new ReplaySource(samples);
    for (let i = 0; i < samples.length; i++) src.stepOnce();
    expect(src.stepOnce()).toBeNull();
  });

  it('derives capabilities from the log contents', () => {
    const src = new ReplaySource(samples);
    expect(src.capabilities.hasImu).toBe(true);
    expect(src.capabilities.hasGnss).toBe(true);
    expect(src.capabilities.hasBaro).toBe(false);
  });

  it('parses JSONL and skips a truncated final line', () => {
    // A recording cut short mid-write must not make the whole log unusable.
    const jsonl =
      samples.map((s) => JSON.stringify(s)).join('\n') + '\n{"t":60,"imu":{"ax"';
    const src = ReplaySource.fromJsonl(jsonl);
    expect(src.capabilities.name).toContain('3 samples');
  });

  it('sorts out-of-order samples by timestamp', () => {
    const jsonl = [
      JSON.stringify({ t: 40 }),
      JSON.stringify({ t: 0 }),
      JSON.stringify({ t: 20 }),
    ].join('\n');
    const src = ReplaySource.fromJsonl(jsonl);
    const seen: number[] = [];
    src.onSample((s) => seen.push(s.t));
    src.stepOnce();
    src.stepOnce();
    src.stepOnce();
    expect(seen).toEqual([0, 20, 40]);
  });

  it('reset() rewinds to the start', () => {
    const src = new ReplaySource(samples);
    src.stepOnce();
    src.stepOnce();
    src.reset();
    const seen: number[] = [];
    src.onSample((s) => seen.push(s.t));
    src.stepOnce();
    expect(seen).toEqual([0]);
  });
});

describe('RecordingWrapper', () => {
  it('records every sample and passes them through untouched', () => {
    const sim = new SimulationSource({ route: city, seed: 21 });
    const rec = new RecordingWrapper(sim);
    const seen: SensorSample[] = [];
    rec.onSample((s) => seen.push(s));

    sim.advance(2000);

    expect(rec.sampleCount).toBe(seen.length);
    expect(rec.sampleCount).toBeGreaterThan(50);
    expect(rec.samples[0]).toEqual(seen[0]);
  });

  it('round-trips through JSONL into a ReplaySource', () => {
    // This is the eval-harness contract: record a drive, replay it exactly.
    const sim = new SimulationSource({ route: city, seed: 22 });
    const rec = new RecordingWrapper(sim);
    rec.onSample(() => {});
    sim.advance(1000);

    const replay = ReplaySource.fromJsonl(rec.toJsonl());
    const replayed: SensorSample[] = [];
    replay.onSample((s) => replayed.push(s));
    for (let i = 0; i < rec.sampleCount; i++) replay.stepOnce();

    expect(replayed).toHaveLength(rec.sampleCount);
    expect(replayed).toEqual([...rec.samples]);
  });

  it('emits one JSON object per line', () => {
    const sim = new SimulationSource({ route: city, seed: 23 });
    const rec = new RecordingWrapper(sim);
    rec.onSample(() => {});
    sim.advance(500);
    const lines = rec.toJsonl().trim().split('\n');
    expect(lines).toHaveLength(rec.sampleCount);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('honours pause and clear', () => {
    const sim = new SimulationSource({ route: city, seed: 24 });
    const rec = new RecordingWrapper(sim);
    rec.onSample(() => {});
    sim.advance(500);
    const first = rec.sampleCount;
    rec.pauseRecording();
    sim.advance(500);
    expect(rec.sampleCount).toBe(first);
    rec.clear();
    expect(rec.sampleCount).toBe(0);
  });

  it('exposes the inner source capabilities', () => {
    const sim = new SimulationSource({ route: city, seed: 25 });
    expect(new RecordingWrapper(sim).capabilities.name).toContain('Simulation');
  });
});
