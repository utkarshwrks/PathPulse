import { describe, expect, it } from 'vitest';
import type { RoadGraph } from '@pathpulse/nav-core';
import {
  RollingCoverage,
  RETARGET_DISTANCE_M,
  MIN_REANCHOR_INTERVAL_MS,
  ANCHOR_LEAD_M,
} from './rollingCoverage';
import { GraphCellStore, MemoryCellBackend } from './graphCellStore';
import {
  approxDistanceM,
  cellsCovering,
  cellKey,
  OUTER_RADIUS_M,
  type Lod,
} from './graphCells';

/**
 * Rolling coverage.
 *
 * ★ WHAT THESE TESTS ARE ACTUALLY FOR ★
 * The failure this guards against takes a two-hundred-kilometre drive to
 * reproduce on a phone and about a millisecond here: storage that grows for
 * every kilometre travelled until the device runs out. The other one — a
 * re-anchor storm — takes a U-turn at exactly the wrong moment, and produces a
 * stream of Overpass requests that would get the application blocked rather
 * than anything a user would notice locally.
 */

const START = { lat: 23.1686, lon: 79.9339 };

function graphAt(lat: number, lon: number): RoadGraph {
  // A few ways, so a stored cell has non-trivial size.
  const ways = [];
  for (let i = 0; i < 20; i++) {
    ways.push({
      id: `w${Math.round(lat * 1e4)}_${Math.round(lon * 1e4)}_${i}`,
      coords: [
        [lon + i * 1e-4, lat],
        [lon + i * 1e-4, lat + 1e-3],
        [lon + i * 1e-4 + 1e-3, lat + 1e-3],
      ] as Array<[number, number]>,
      highway: 'residential',
    });
  }
  return { bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1], ways };
}

/** Move north by `metres`. */
function north(from: { lat: number; lon: number }, metres: number) {
  return { lat: from.lat + metres / 110_574, lon: from.lon };
}

function newStore(maxBytes?: number) {
  return new GraphCellStore(new MemoryCellBackend(), maxBytes);
}

describe('shouldReanchor', () => {
  it('anchors immediately when there is no anchor yet', () => {
    const rc = new RollingCoverage(newStore());
    expect(rc.shouldReanchor(START.lat, START.lon, 0)).toBe(true);
  });

  it('does not re-anchor for small movements', async () => {
    const rc = new RollingCoverage(newStore());
    await rc.roll(START.lat, START.lon, 0, 0);
    const near = north(START, 5_000);
    expect(rc.shouldReanchor(near.lat, near.lon, MIN_REANCHOR_INTERVAL_MS + 1)).toBe(false);
  });

  it('re-anchors once the vehicle is far enough away, and enough time has passed', () => {
    const rc = new RollingCoverage(newStore());
    void rc.roll(START.lat, START.lon, null, 0);
    const far = north(START, RETARGET_DISTANCE_M + 5_000);
    expect(rc.shouldReanchor(far.lat, far.lon, 1_000)).toBe(false); // too soon
    expect(rc.shouldReanchor(far.lat, far.lon, MIN_REANCHOR_INTERVAL_MS + 1)).toBe(true);
  });
});

describe('anchorFor', () => {
  it('★ places the anchor ahead along the heading, not on the vehicle', () => {
    // Anchoring on the current position spends half the disc on ground already
    // driven. Only the part ahead can still be needed.
    const rc = new RollingCoverage(newStore());
    const a = rc.anchorFor(START.lat, START.lon, 0, 0); // due north
    expect(a.lat).toBeGreaterThan(START.lat);
    expect(approxDistanceM(START.lat, START.lon, a.lat, a.lon)).toBeGreaterThan(
      ANCHOR_LEAD_M * 0.9,
    );
  });

  it('anchors on the vehicle when the heading is unknown', () => {
    const rc = new RollingCoverage(newStore());
    const a = rc.anchorFor(START.lat, START.lon, null, 0);
    expect(a.lat).toBeCloseTo(START.lat, 6);
    expect(a.lon).toBeCloseTo(START.lon, 6);
  });

  it('leads east when heading east', () => {
    const rc = new RollingCoverage(newStore());
    const a = rc.anchorFor(START.lat, START.lon, 90, 0);
    expect(a.lon).toBeGreaterThan(START.lon);
    expect(a.lat).toBeCloseTo(START.lat, 3);
  });
});

describe('roll — eviction', () => {
  it('★ storage plateaus over a 200 km drive rather than growing', async () => {
    // The whole point. On a phone this takes a two-hundred-kilometre drive to
    // discover; here it takes a millisecond, and the failure it catches is a
    // device that fills up on a long journey.
    const store = newStore();
    const rc = new RollingCoverage(store);

    const sizes: number[] = [];
    let pos = { ...START };
    for (let km = 0; km <= 200; km += 10) {
      pos = north(START, km * 1000);
      // Store the cells the vehicle is actually passing through.
      for (const lod of ['full', 'major'] as Lod[]) {
        for (const cell of cellsCovering(pos.lat, pos.lon, 3_000, lod)) {
          if (!(await store.has(cell, lod))) {
            await store.put(cell, lod, graphAt(pos.lat, pos.lon), km * 60_000);
          }
        }
      }
      await rc.roll(pos.lat, pos.lon, 0, km * 60_000);
      sizes.push(await store.totalBytes());
    }

    // Measured series, KB, at 10 km intervals:
    //   0:4  10:9  20:11  30:14  40:17  50:21  60:24  70:27  80:30  90:34
    //   100:36  110:36  120:34  130:36  140:36  150:36  160:34  170:36 ... 200:34
    //
    // The shape is the result: it climbs while the 100 km disc fills and then
    // stops dead. Growth in the first half is correct and must not be asserted
    // against — the disc is supposed to fill. What must never happen is growth
    // that tracks distance travelled, so the assertion is that the SECOND half
    // is flat.
    const half = Math.floor(sizes.length / 2);
    const tail = sizes.slice(half);
    const tailMin = Math.min(...tail);
    const tailMax = Math.max(...tail);
    expect(tailMax).toBeLessThanOrEqual(tailMin * 1.1);
    // And that the plateau is a plateau, not a still-rising line sampled twice.
    expect(sizes[sizes.length - 1]!).toBeLessThanOrEqual(sizes[half]! * 1.1);
  });

  it('★ never evicts the cell the vehicle is standing in', async () => {
    // Even under a cap of one byte. Losing this cell disengages snapping
    // mid-drive with nothing on screen to explain it.
    const store = newStore(1);
    const rc = new RollingCoverage(store);
    const here = cellsCovering(START.lat, START.lon, 1, 'full')[0]!;
    await store.put(here, 'full', graphAt(START.lat, START.lon));
    await rc.roll(START.lat, START.lon, null, 0);
    expect(await store.has(here, 'full')).toBe(true);
  });

  it('evicts cells left far behind', async () => {
    const store = newStore();
    const rc = new RollingCoverage(store);
    const behind = cellsCovering(START.lat, START.lon, 1, 'full')[0]!;
    await store.put(behind, 'full', graphAt(START.lat, START.lon));

    const farAway = north(START, OUTER_RADIUS_M + 50_000);
    const res = await rc.roll(farAway.lat, farAway.lon, 0, MIN_REANCHOR_INTERVAL_MS * 2);
    expect(res.evicted).toBeGreaterThan(0);
    expect(await store.has(behind, 'full')).toBe(false);
  });

  it('keeps cells still inside the disc', async () => {
    const store = newStore();
    const rc = new RollingCoverage(store);
    const cell = cellsCovering(START.lat, START.lon, 1, 'full')[0]!;
    await store.put(cell, 'full', graphAt(START.lat, START.lon));
    const nearby = north(START, 30_000);
    await rc.roll(nearby.lat, nearby.lon, 0, MIN_REANCHOR_INTERVAL_MS * 2);
    expect(await store.has(cell, 'full')).toBe(true);
  });
});

describe('roll — re-anchor storms', () => {
  it('★ does not re-anchor repeatedly while oscillating across the boundary', async () => {
    // A vehicle turning round just after a re-anchor is immediately moving away
    // from an anchor placed ahead of its OLD heading. Without the interval
    // guard each crossing rebuilds the queue, and the prefetcher issues a
    // steady stream of requests while never finishing a cell.
    const store = newStore();
    const rc = new RollingCoverage(store);
    let reanchors = 0;
    let t = 0;

    await rc.roll(START.lat, START.lon, 0, t);
    for (let i = 0; i < 40; i++) {
      // Straddle the retarget boundary, forwards and back, every 10 seconds.
      const d = i % 2 === 0 ? RETARGET_DISTANCE_M + 2_000 : RETARGET_DISTANCE_M - 2_000;
      const pos = north(START, d);
      t += 10_000;
      const res = await rc.roll(pos.lat, pos.lon, i % 2 === 0 ? 0 : 180, t);
      if (res.reanchored) reanchors++;
    }

    // 400 s of oscillation at a 120 s floor can justify a handful, not forty.
    expect(reanchors).toBeLessThanOrEqual(4);
  });

  it('still re-anchors on a genuine long drive', async () => {
    const store = newStore();
    const rc = new RollingCoverage(store);
    let reanchors = 0;
    let t = 0;
    await rc.roll(START.lat, START.lon, 0, t);
    for (let km = 20; km <= 200; km += 20) {
      t += MIN_REANCHOR_INTERVAL_MS * 2;
      const pos = north(START, km * 1000);
      if ((await rc.roll(pos.lat, pos.lon, 0, t)).reanchored) reanchors++;
    }
    expect(reanchors).toBeGreaterThan(3);
  });
});

describe('the anchor itself', () => {
  it('is reported so the caller can plan around it', async () => {
    const store = newStore();
    const rc = new RollingCoverage(store);
    const res = await rc.roll(START.lat, START.lon, 0, 0);
    expect(res.anchor).not.toBeNull();
    expect(rc.current).toEqual(res.anchor);
  });

  it('clears on reset', async () => {
    const rc = new RollingCoverage(newStore());
    await rc.roll(START.lat, START.lon, 0, 0);
    rc.reset();
    expect(rc.current).toBeNull();
    expect(rc.shouldReanchor(START.lat, START.lon, 0)).toBe(true);
  });
});
