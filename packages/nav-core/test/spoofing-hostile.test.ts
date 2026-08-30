import { describe, expect, it } from 'vitest';
import { SpoofingDetector, type SpoofingInput } from '../src/index.js';

/**
 * Phase 9D, assumed broken.
 *
 * The detector's own tests check that it fires on the right things and stays
 * quiet on the wrong ones. These check what happens when a condition PERSISTS,
 * which is the state no single-shot test visits — a jammer does not jam for one
 * sample, and the event log a judge is invited to read has a fixed capacity.
 */

const BASE = { lat: 23.1815, lon: 79.9864 };

function east(metres: number): number {
  return BASE.lon + metres / (111_320 * Math.cos((BASE.lat * Math.PI) / 180));
}

function input(patch: Partial<SpoofingInput> & { t: number }): SpoofingInput {
  return { drSpeedMps: 0, stationary: true, ...patch };
}

describe('9D hostile — a sustained anomaly must not flood the event log', () => {
  it('★ reports a continuing constellation anomaly once, not once per fix', () => {
    // The event log holds 200 entries and is one of the anti-fake features:
    // every mode change with its reason, exportable for a judge to check. A
    // detector that emits on every sample while a condition holds evicts the
    // entire history behind it — the log a judge opens shows nothing but the
    // same line repeated, and the outage it was meant to document is gone.
    const d = new SpoofingDetector();
    for (let t = 0; t < 5000; t += 1000) {
      d.update(input({ t, gnss: { ...BASE, accuracyM: 5, satCount: 12, meanCn0: 42 } }));
    }

    let fired = 0;
    // The jamming continues for a minute at a 1 Hz fix rate.
    for (let t = 5000; t < 65_000; t += 1000) {
      const e = d.update(
        input({ t, gnss: { ...BASE, accuracyM: 5, satCount: 3, meanCn0: 44 } }),
      );
      if (e) fired++;
    }
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThanOrEqual(8);
  });

  it('★ reports a continuing static hold at a readable rate', () => {
    const d = new SpoofingDetector();
    let fired = 0;
    for (let t = 0; t < 120_000; t += 1000) {
      const e = d.update(
        input({
          t,
          gnss: { ...BASE, accuracyM: 5, speedMps: 0 },
          drSpeedMps: 14,
          stationary: false,
        }),
      );
      if (e) fired++;
    }
    // Two minutes of being held still is worth saying more than once and far
    // less than 120 times.
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThanOrEqual(20);
  });

  it('can still report a NEW kind while another is being displayed', () => {
    // Suppressing repeats must not suppress a different, genuinely new
    // finding — that would hide the second half of an attack.
    const d = new SpoofingDetector();
    for (let t = 0; t < 5000; t += 1000) {
      d.update(input({ t, gnss: { ...BASE, accuracyM: 5, satCount: 12, meanCn0: 42 } }));
    }
    const first = d.update(
      input({ t: 5000, gnss: { ...BASE, accuracyM: 5, satCount: 3, meanCn0: 44 } }),
    );
    expect(first?.kind).toBe('CONSTELLATION');

    const jump = d.update(
      input({
        t: 6000,
        gnss: { lat: BASE.lat, lon: east(500), accuracyM: 5, satCount: 3, meanCn0: 44 },
      }),
    );
    expect(jump?.kind).toBe('IMPLAUSIBLE_JUMP');
  });

  it('reports again once the anomaly has cleared and returned', () => {
    const d = new SpoofingDetector();
    for (let t = 0; t < 5000; t += 1000) {
      d.update(input({ t, gnss: { ...BASE, accuracyM: 5, satCount: 12, meanCn0: 42 } }));
    }
    expect(
      d.update(input({ t: 5000, gnss: { ...BASE, accuracyM: 5, satCount: 3, meanCn0: 44 } })),
    ).not.toBeNull();

    // Healthy again for a good while.
    for (let t = 20_000; t < 40_000; t += 1000) {
      d.update(input({ t, gnss: { ...BASE, accuracyM: 5, satCount: 12, meanCn0: 42 } }));
    }
    // And jammed again — this is a new event, not a repeat.
    const again = d.update(
      input({ t: 41_000, gnss: { ...BASE, accuracyM: 5, satCount: 3, meanCn0: 44 } }),
    );
    expect(again?.kind).toBe('CONSTELLATION');
  });
});

describe('9D hostile — state tracking under short-circuit', () => {
  it('★ keeps the satellite baseline current even when another check fires', () => {
    // The three checks are chained with ?? , so the first to return a value
    // stops the rest running — and the constellation check is the one that
    // maintains the satellite baseline. A run of jumps would leave that
    // baseline frozen at a stale value, so the constellation check would then
    // judge against a number from minutes ago.
    const d = new SpoofingDetector();

    // Establish a healthy baseline of 12.
    for (let t = 0; t < 5000; t += 1000) {
      d.update(input({ t, gnss: { ...BASE, accuracyM: 5, satCount: 12, meanCn0: 42 } }));
    }

    // Now a run of teleports, each of which fires the jump check first. The
    // satellite count genuinely falls to 5 across them — a real, gradual
    // decline that the baseline should follow.
    let t = 5000;
    for (let i = 0; i < 12; i++) {
      t += 1000;
      d.update(
        input({
          t,
          gnss: {
            lat: BASE.lat,
            lon: east(500 * (i + 1)),
            accuracyM: 5,
            satCount: 5,
            meanCn0: 42,
          },
        }),
      );
    }

    // Settle: a fix 10 m from the last one, so the jump check is silent and
    // cannot mask the answer. (An earlier version of this test ended on a
    // teleport, so IMPLAUSIBLE_JUMP was returned and the assertion passed
    // without ever exercising the baseline at all.)
    t += 1000;
    const settle = d.update(
      input({
        t,
        gnss: { lat: BASE.lat, lon: east(500 * 12 + 10), accuracyM: 5, satCount: 5, meanCn0: 42 },
      }),
    );
    expect(settle).toBeNull();

    // 5 satellites is now normal. Reporting it as a collapse from 12 would be
    // judging against a baseline that stopped updating twelve fixes ago.
    t += 1000;
    const found = d.update(
      input({
        t,
        gnss: { lat: BASE.lat, lon: east(500 * 12 + 20), accuracyM: 5, satCount: 5, meanCn0: 42 },
      }),
    );
    expect(found).toBeNull();
  });

  it('keeps the previous fix current for the jump check', () => {
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 5 } }));
    // A teleport, which fires.
    expect(
      d.update(input({ t: 1000, gnss: { lat: BASE.lat, lon: east(500), accuracyM: 5 } })),
    ).not.toBeNull();
    // Staying put at the new location is not another jump: lastFix must have
    // advanced to the teleported position rather than staying at the old one.
    expect(
      d.update(input({ t: 2000, gnss: { lat: BASE.lat, lon: east(505), accuracyM: 5 } })),
    ).toBeNull();
  });
});

describe('9D hostile — the walking-mode demo', () => {
  it('does not accuse the receiver while someone walks a corridor', () => {
    // Walking Mode exists so the engine can be shown on foot indoors, where
    // GNSS is poor and often reports near-zero speed. At 1.4 m/s the IMU is
    // moving and GNSS may well say zero — precisely the static-hold shape,
    // and precisely not an attack.
    const d = new SpoofingDetector();
    let fired = 0;
    for (let t = 0; t < 60_000; t += 1000) {
      const e = d.update(
        input({
          t,
          gnss: { ...BASE, accuracyM: 30, speedMps: 0 },
          drSpeedMps: 1.4,
          stationary: false,
        }),
      );
      if (e) fired++;
    }
    expect(fired).toBe(0);
  });
});
