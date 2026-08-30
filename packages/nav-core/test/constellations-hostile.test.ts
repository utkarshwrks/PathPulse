import { describe, expect, it } from 'vitest';
import { summariseConstellations } from '../src/index.js';

/**
 * Phase 9E, assumed broken.
 *
 * The feature's whole claim is that a viewer can tell a measured sky from an
 * invented one. So the failures worth hunting are not arithmetic errors — they
 * are the ways a real reading could go missing, or a total could end up
 * asserting something no source reported.
 */

describe('9E hostile — constellation naming', () => {
  it('★ recognises IRNSS, which is what NavIC is called in half the documentation', () => {
    // NavIC's system name is IRNSS and Android's own constants and much of
    // ISRO's material still use it. Dropping it silently would hide the one
    // constellation this whole panel exists to show — on a stand sponsored by
    // the organisation that operates it.
    const s = summariseConstellations({ constellations: { GPS: 7, IRNSS: 4 } });
    expect(s.navicCount).toBe(4);
    expect(s.rows.find((r) => r.id === 'NAVIC')?.count).toBe(4);
  });

  it('★ is not case-sensitive about constellation names', () => {
    // Nothing guarantees Phase 15's native layer will shout its enum names.
    const s = summariseConstellations({ constellations: { gps: 7, NavIC: 4 } });
    expect(s.navicCount).toBe(4);
    expect(s.total).toBe(11);
  });

  it('merges aliases rather than double-counting them', () => {
    const s = summariseConstellations({ constellations: { NAVIC: 3, IRNSS: 1 } });
    expect(s.navicCount).toBe(4);
    expect(s.rows.filter((r) => r.id === 'NAVIC')).toHaveLength(1);
  });

  it('accepts the other common spellings without inventing constellations', () => {
    const s = summariseConstellations({
      constellations: { 'BEIDOU': 2, 'Galileo': 3, 'GLONASS': 1, 'QZSS': 1 },
    });
    expect(s.rows.map((r) => r.id).sort()).toEqual(['BEIDOU', 'GALILEO', 'GLONASS', 'QZSS']);
  });
});

describe('9E hostile — totals that must not lie', () => {
  it('★ does not report a total that silently omits constellations it did not recognise', () => {
    // A receiver reporting SBAS or some future system would have those counts
    // dropped, and the "TOTAL" line would then be smaller than the satellites
    // actually tracked — a number contradicting the SATELLITES row directly
    // above it, with nothing saying why.
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: 4, SBAS: 2 },
      satCount: 13,
    });
    expect(s.total).toBe(13);
  });

  it('keeps the breakdown total when it is complete', () => {
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: 4 },
      satCount: 11,
    });
    expect(s.total).toBe(11);
  });
});

describe('9E hostile — provenance cannot be attached to the wrong data', () => {
  it('★ a simulated sky stays simulated regardless of what the caller claims', () => {
    // The UI used to join provenance to the counts at render time from a
    // separate source — the currently selected source kind. Switching from
    // simulation to live flips that flag one render before the stale simulated
    // fix is cleared, so for one painted frame the simulator's invented sky is
    // labelled MEASURED. Provenance now travels WITH the numbers.
    const s = summariseConstellations({
      constellations: { GPS: 7, NAVIC: 4 },
      constellationsSimulated: true,
      simulated: false,
    });
    expect(s.provenance).toBe('simulated');
  });

  it('treats data carrying no provenance marker as measured only when told', () => {
    const s = summariseConstellations({ constellations: { GPS: 7 }, simulated: true });
    expect(s.provenance).toBe('simulated');
  });
});
