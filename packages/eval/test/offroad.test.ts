import { beforeAll, describe, expect, it } from 'vitest';
import { measureOffRoad, type OffRoadStats } from '../src/offroad.js';
import { listLogs } from '../src/paths.js';

/**
 * ★ THE FIELD BUG, AS A GUARD ★
 *
 * Reported from a real drive: "when it goes to dead reckoning it goes off the
 * road, into the plots". The build it was reported against measured 10 % mean
 * drift, which is inside target — both statements were true at once, because
 * drift measures distance-to-truth and says nothing about which SIDE of the
 * truth the error is on. 30 m along a road is invisible; 30 m across it is in
 * a field.
 *
 * Nothing measured that, so nothing caught it. This does. It is deliberately a
 * separate assertion from the ablation: a change that improved drift while
 * putting the marker back in the plots would pass every other test in the
 * repository.
 */

let full: OffRoadStats;
let noSnap: OffRoadStats;

describe('the drawn marker stays on a road while dead reckoning', () => {
  beforeAll(() => {
    expect(listLogs().length, 'run `pnpm eval:record` first').toBeGreaterThan(0);
    full = measureOffRoad('full');
    noSnap = measureOffRoad('highpass');
  }, 600_000);

  it('scores a meaningful number of drawn samples', () => {
    expect(full.samples).toBeGreaterThan(10_000);
    expect(full.samples).toBe(noSnap.samples);
  });

  it('is typically ON the road, not near it', () => {
    // Measured 0.0 m. A median that is not essentially zero means the snap is
    // partial again, which is how this bug looked the first time.
    expect(full.medianM).toBeLessThan(1);
    expect(full.meanM).toBeLessThan(2);
  });

  it('almost never draws the vehicle in a field', () => {
    // Measured 2.8 % beyond 10 m and 0.8 % beyond 25 m, against 35.2 % and
    // 21.9 % with snapping off.
    expect(full.beyond10M).toBeLessThan(0.06);
    expect(full.beyond25M).toBeLessThan(0.02);
  });

  it('bounds the worst excursion, which is the price of never teleporting', () => {
    // ★ AN HONEST LIMIT, NOT A HIDDEN ONE ★
    // The worst case is ~71 m and it is brief: it happens while the marker is
    // SLIDING between two roads after the matched way changes. The snap
    // correction is rate-limited to 60 m/s precisely so that transition is a
    // slide and not a jump, and a marker in motion between two roads is
    // momentarily further from either than the estimate was. The alternative
    // is a teleport, which this codebase does not permit.
    //
    // The distribution is what matters: the median is 0 m and the p90 is 0 m.
    expect(full.maxM).toBeLessThan(90);
    expect(full.p90M).toBeLessThan(3);
  });

  it('shows that road snapping is what does it', () => {
    // Without this the numbers above could be an accident of these logs.
    expect(noSnap.beyond10M).toBeGreaterThan(0.2);
    expect(full.meanM).toBeLessThan(noSnap.meanM / 5);
  });
});
