import { describe, expect, it, vi } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import { RecordingWrapper, ReplaySource } from '../src/index.js';
import type { SensorSource, SensorSourceCapabilities } from '../src/types.js';

const G = 9.80665;

function sample(t: number, withGnss = false): SensorSample {
  const s: SensorSample = {
    t,
    imu: { ax: 0.1, ay: 0.2, az: G, gx: 0.001, gy: 0, gz: -0.01 },
  };
  if (withGnss) {
    s.gnss = { lat: 28.6315, lon: 77.2167, accuracyM: 5, speedMps: 12, headingDeg: 90 };
  }
  return s;
}

function jsonl(samples: SensorSample[]): string {
  return samples.map((s) => JSON.stringify(s)).join('\n');
}

/** A source we can drive by hand, to test the recording wrapper around it. */
class FakeSource implements SensorSource {
  private listeners: Array<(s: SensorSample) => void> = [];
  running = false;
  readonly capabilities: SensorSourceCapabilities = {
    hasGnss: true,
    hasImu: true,
    hasBaro: false,
    imuRateHz: 50,
    gnssRateHz: 1,
    name: 'Fake',
  };
  onSample(cb: (s: SensorSample) => void): void {
    this.listeners.push(cb);
  }
  async start(): Promise<void> {
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  emit(s: SensorSample): void {
    for (const cb of this.listeners) cb(s);
  }
}

describe('ReplaySource — Golden Rule #8 depends on this being honest', () => {
  it('parses JSONL and replays in order', () => {
    const src = ReplaySource.fromJsonl(jsonl([sample(0), sample(20), sample(40)]));
    const seen: SensorSample[] = [];
    src.onSample((s) => seen.push(s));
    while (src.stepOnce()) {
      /* drain */
    }
    expect(seen.map((s) => s.t)).toEqual([0, 20, 40]);
  });

  it('sorts samples that arrive out of order', () => {
    // A recording written from several callbacks can interleave. Replaying it
    // out of order would feed the engine a backwards clock, which it rejects —
    // so the samples would silently vanish rather than fail loudly.
    const src = ReplaySource.fromJsonl(jsonl([sample(40), sample(0), sample(20)]));
    const seen: number[] = [];
    src.onSample((s) => seen.push(s.t));
    while (src.stepOnce()) {
      /* drain */
    }
    expect(seen).toEqual([0, 20, 40]);
  });

  it('tolerates a truncated final line', () => {
    // Killing the app mid-write is the normal way a recording ends.
    const src = ReplaySource.fromJsonl(`${jsonl([sample(0), sample(20)])}\n{"t":40,"imu":{"ax":0.1`);
    expect(src.capabilities.name).toContain('2 samples');
  });

  it('ignores blank lines and whitespace', () => {
    const src = ReplaySource.fromJsonl(`\n${JSON.stringify(sample(0))}\n\n  \n${JSON.stringify(sample(20))}\n`);
    expect(src.capabilities.name).toContain('2 samples');
  });

  it('reports zero samples for empty input rather than throwing', () => {
    expect(ReplaySource.fromJsonl('').capabilities.name).toContain('0 samples');
    expect(ReplaySource.fromJsonl('   \n\n').capabilities.name).toContain('0 samples');
  });

  it('stepOnce returns null once exhausted', () => {
    const src = ReplaySource.fromJsonl(jsonl([sample(0)]));
    expect(src.stepOnce()).not.toBeNull();
    expect(src.stepOnce()).toBeNull();
  });

  it('replays at the original timing, scaled by playback rate', async () => {
    vi.useFakeTimers();
    try {
      // 1 s apart in the recording, replayed at 4x, is 250 ms of wall clock.
      const src = ReplaySource.fromJsonl(jsonl([sample(0, true), sample(1000, true), sample(2000, true)]));
      const seen: number[] = [];
      src.onSample((s) => seen.push(s.t));
      src.setPlaybackRate(4);
      void src.start();

      expect(seen).toEqual([0]);
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([0, 1000]);
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([0, 1000, 2000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on its own at the end of the recording', async () => {
    vi.useFakeTimers();
    try {
      const src = ReplaySource.fromJsonl(jsonl([sample(0), sample(100)]));
      const seen: number[] = [];
      src.onSample((s) => seen.push(s.t));
      void src.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).toEqual([0, 100]);
      // Nothing further is scheduled once the recording is exhausted.
      await vi.advanceTimersByTimeAsync(5000);
      expect(seen).toEqual([0, 100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports progress through the recording', () => {
    const src = ReplaySource.fromJsonl(jsonl([sample(0), sample(20), sample(40), sample(60)]));
    expect(src.progressFraction).toBe(0);
    src.stepOnce();
    src.stepOnce();
    expect(src.progressFraction).toBeGreaterThan(0);
    while (src.stepOnce()) {
      /* drain */
    }
    expect(src.progressFraction).toBeCloseTo(1, 5);
  });
});

describe('RecordingWrapper — the eval harness eats what this writes', () => {
  it('passes samples through untouched', () => {
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    const seen: SensorSample[] = [];
    rec.onSample((s) => seen.push(s));

    const s = sample(0, true);
    inner.emit(s);
    expect(seen).toHaveLength(1);
    // Identity, not a copy: a wrapper that reshaped samples would make the
    // recording a record of the wrapper rather than of the sensors.
    expect(seen[0]).toBe(s);
  });

  it('records verbatim, and round-trips through ReplaySource', () => {
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    const written = [sample(0, true), sample(20), sample(40, true)];
    for (const s of written) inner.emit(s);

    expect(rec.sampleCount).toBe(3);

    const replayed: SensorSample[] = [];
    const replay = ReplaySource.fromJsonl(rec.toJsonl());
    replay.onSample((s) => replayed.push(s));
    while (replay.stepOnce()) {
      /* drain */
    }
    expect(replayed).toEqual(written);
  });

  it('records even when nobody has subscribed', () => {
    // ★ REGRESSION ★ Recording used to start only when onSample was called, so
    // a wrapper nobody listened to silently recorded nothing.
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    inner.emit(sample(0));
    inner.emit(sample(20));
    expect(rec.sampleCount).toBe(2);
  });

  it('records each sample once however many listeners there are', () => {
    // ★ REGRESSION ★ Every subscriber used to add its own recording callback,
    // so two listeners duplicated every sample. The log still looked plausible
    // — same timestamps, just twice each — which is the worst kind of wrong.
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    const a: SensorSample[] = [];
    const b: SensorSample[] = [];
    rec.onSample((s) => a.push(s));
    rec.onSample((s) => b.push(s));

    inner.emit(sample(0));
    inner.emit(sample(20));

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(rec.sampleCount).toBe(2);
  });

  it('pauses and resumes recording without dropping listeners', () => {
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    const seen: SensorSample[] = [];
    rec.onSample((s) => seen.push(s));

    inner.emit(sample(0));
    rec.pauseRecording();
    inner.emit(sample(20));
    rec.resumeRecording();
    inner.emit(sample(40));

    // Recorded 2, but the consumer still saw all 3 — pausing the recording
    // must not pause the navigation.
    expect(rec.sampleCount).toBe(2);
    expect(seen).toHaveLength(3);
    expect(rec.samples.map((s) => s.t)).toEqual([0, 40]);
  });

  it('forwards start and stop to the wrapped source', async () => {
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    await rec.start();
    expect(inner.running).toBe(true);
    rec.stop();
    expect(inner.running).toBe(false);
  });

  it('exposes the wrapped source capabilities', () => {
    const inner = new FakeSource();
    expect(new RecordingWrapper(inner).capabilities.name).toBe('Fake');
  });

  it('produces one JSON object per line', () => {
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    inner.emit(sample(0));
    inner.emit(sample(20));
    const lines = rec.toJsonl().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('clears its buffer on request', () => {
    const inner = new FakeSource();
    const rec = new RecordingWrapper(inner);
    inner.emit(sample(0));
    rec.clear();
    expect(rec.sampleCount).toBe(0);
    expect(rec.toJsonl()).toBe('');
  });
});
