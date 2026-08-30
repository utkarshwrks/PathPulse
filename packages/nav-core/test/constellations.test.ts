import { describe, expect, it } from 'vitest';
import {
  canClaimNavIC,
  CONSTELLATION_ORDER,
  summariseConstellations,
} from '../src/index.js';

/**
 * The constellation breakdown.
 *
 * ★ EVERY TEST HERE IS ABOUT PROVENANCE, NOT ARITHMETIC ★
 * Counting satellites is trivial. The thing that can actually lose a judge is
 * a panel that reads "NavIC: 4" without saying whether that 4 was measured,
 * simulated, or absent — and on real hardware today it is absent, because the
 * Capacitor WebView reports nothing. So what is tested is that the summary can
 * never quietly present invented numbers as measured ones.
 */

describe('summariseConstellations', () => {
  it('puts NavIC first, because that is the one ISRO will look for', () => {
    expect(CONSTELLATION_ORDER[0]).toBe('NAVIC');
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: 4, GALILEO: 3 },
    });
    expect(s.rows[0]?.id).toBe('NAVIC');
  });

  it('reports a real breakdown as measured', () => {
    const s = summariseConstellations({ constellations: { GPS: 7, NAVIC: 4 } });
    expect(s.provenance).toBe('measured');
    expect(s.total).toBe(11);
    expect(s.navicCount).toBe(4);
  });

  it('★ marks the simulator’s sky as simulated, with the same numbers', () => {
    // The simulator is the ONLY source that can produce a breakdown today.
    // Rendering its output unlabelled would be presenting an invented sky as a
    // measurement — the exact thing Golden Rule #8 exists to prevent.
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: 4 },
      simulated: true,
    });
    expect(s.provenance).toBe('simulated');
    expect(s.navicCount).toBe(4);
    expect(s.note).toMatch(/not a measurement/i);
  });

  it('★ never claims NavIC from a simulated sky', () => {
    const simulated = summariseConstellations({
      constellations: { NAVIC: 4 },
      simulated: true,
    });
    expect(canClaimNavIC(simulated)).toBe(false);

    const measured = summariseConstellations({ constellations: { NAVIC: 4 } });
    expect(canClaimNavIC(measured)).toBe(true);
  });

  it('★ falls back to a total, and says the breakdown is missing', () => {
    const s = summariseConstellations({ satCount: 9 });
    expect(s.provenance).toBe('total-only');
    expect(s.total).toBe(9);
    expect(s.rows).toEqual([]);
    // Not zero. Zero would read as "no NavIC satellites in view", which is a
    // measurement we have not made.
    expect(s.navicCount).toBeNull();
    expect(s.note).toMatch(/GnssStatus|Phase 15/);
  });

  it('★ reports nothing at all as unavailable, never as zero satellites', () => {
    const s = summariseConstellations({});
    expect(s.provenance).toBe('unavailable');
    expect(s.total).toBeNull();
    expect(s.navicCount).toBeNull();
    expect(s.note).toMatch(/Phase 15/);
  });

  it('ignores junk counts rather than rendering them', () => {
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: NaN, GALILEO: -2, BEIDOU: undefined },
    });
    expect(s.rows.map((r) => r.id)).toEqual(['GPS']);
    expect(s.total).toBe(7);
  });

  it('treats a genuine zero as a real measurement', () => {
    // Zero NavIC satellites is a legitimate reading outside their coverage.
    const s = summariseConstellations({ constellations: { GPS: 8, NAVIC: 0 } });
    expect(s.navicCount).toBe(0);
    expect(s.rows.find((r) => r.id === 'NAVIC')?.count).toBe(0);
  });

  it('★ reports the platform’s larger total, and how much of it is unnamed', () => {
    // REVISED during deep test pass 8. This test used to assert the opposite —
    // that a breakdown summing to 11 beats a reported total of 13 — on the
    // reasoning that the breakdown is the more specific claim. That rule
    // silently discards satellites: a receiver tracking SBAS or some system
    // this file does not name would show TOTAL 11 directly beneath a
    // SATELLITES row reading 13, with nothing explaining the gap. Reporting
    // the platform's total and stating the unnamed remainder is the honest
    // version of the same information.
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: 4 },
      satCount: 13,
    });
    expect(s.total).toBe(13);
    expect(s.unlistedCount).toBe(2);
  });

  it('does not invent an unlisted count when the numbers agree', () => {
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: 4 },
      satCount: 11,
    });
    expect(s.total).toBe(11);
    expect(s.unlistedCount).toBe(0);
  });

  it('ignores a total smaller than the breakdown rather than losing satellites', () => {
    const s = summariseConstellations({ constellations: { GPS: 7, NAVIC: 4 }, satCount: 2 });
    expect(s.total).toBe(11);
    expect(s.unlistedCount).toBe(0);
  });

  it('never throws on missing or malformed input', () => {
    expect(() => summariseConstellations()).not.toThrow();
    expect(summariseConstellations({ satCount: NaN }).provenance).toBe('unavailable');
    expect(summariseConstellations({ constellations: {} }).provenance).toBe('unavailable');
  });

  it('always returns a note, whatever the state', () => {
    for (const input of [
      {},
      { satCount: 9 },
      { constellations: { GPS: 7 } },
      { constellations: { GPS: 7 }, simulated: true },
    ]) {
      expect(summariseConstellations(input).note.length).toBeGreaterThan(10);
    }
  });
});
