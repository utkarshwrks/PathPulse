import { describe, expect, it, vi } from 'vitest';
import type { RoadGraph } from '@pathpulse/nav-core';
import { GraphPrefetcher, planCells, type PrefetchDeps } from './graphPrefetch';
import { GraphCellStore, MemoryCellBackend } from './graphCellStore';
import { cellKey, cellCentre, approxDistanceM, LOD_ZOOM } from './graphCells';

/**
 * The background prefetcher.
 *
 * ★ THE ONE PROPERTY THAT MUST NOT BREAK ★
 * Exactly one Overpass request in flight at a time. Overpass is a free, shared
 * service; a parallel burst gets the app rate-limited, and a rate-limited app
 * has no offline coverage at all. It is asserted here by counting, not by
 * reading the code, because it is precisely the kind of invariant a later
 * refactor breaks silently.
 */

const JABALPUR = { lat: 23.1686, lon: 79.9339 };

function graph(): RoadGraph {
  return {
    bbox: [79.8, 23.1, 80.0, 23.3],
    ways: [{ id: 'w1', coords: [[79.9, 23.1], [79.95, 23.15]], highway: 'primary' }],
  };
}

/** No real timers: every delay resolves immediately, ordering preserved. */
const instantSleep = (_ms: number, signal: AbortSignal) =>
  signal.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve();

function harness(over: Partial<PrefetchDeps> = {}) {
  const store = new GraphCellStore(new MemoryCellBackend());
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const deps: PrefetchDeps = {
    store,
    sleep: instantSleep,
    fetchCell: async (cell, lod) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      order.push(cellKey(cell, lod));
      // Yield twice, so any accidental parallelism has a real chance to overlap.
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return graph();
    },
    ...over,
  };
  return { store, deps, order, peak: () => peak };
}

describe('planCells', () => {
  it('puts the cell under the vehicle first', () => {
    const tasks = planCells(JABALPUR.lat, JABALPUR.lon, null);
    expect(tasks.length).toBeGreaterThan(1);
    const first = tasks[0]!;
    const c = cellCentre(first.cell);
    const d = approxDistanceM(JABALPUR.lat, JABALPUR.lon, c.lat, c.lon);
    for (const t of tasks.slice(1, 20)) {
      if (t.lod !== 'full') continue;
      const cc = cellCentre(t.cell);
      expect(d).toBeLessThanOrEqual(
        approxDistanceM(JABALPUR.lat, JABALPUR.lon, cc.lat, cc.lon) + 1,
      );
    }
  });

  it('★ prefers cells ahead of the vehicle over cells behind it', () => {
    // A vehicle is going somewhere. Coverage should lead it rather than
    // surround it evenly, because the whole inner ring takes minutes and what
    // matters is which cells land in the first of them.
    const north = planCells(JABALPUR.lat, JABALPUR.lon, 0);
    const rank = (t: (typeof north)[number]) => cellCentre(t.cell).lat;
    const fullOnly = north.filter((t) => t.lod === 'full').slice(0, 8);
    const aheadCount = fullOnly.filter((t) => rank(t) > JABALPUR.lat).length;
    const behindCount = fullOnly.filter((t) => rank(t) < JABALPUR.lat).length;
    expect(aheadCount).toBeGreaterThan(behindCount);
  });

  it('reverses that preference when the heading reverses', () => {
    const south = planCells(JABALPUR.lat, JABALPUR.lon, 180);
    const fullOnly = south.filter((t) => t.lod === 'full').slice(0, 8);
    const ahead = fullOnly.filter((t) => cellCentre(t.cell).lat < JABALPUR.lat).length;
    const behind = fullOnly.filter((t) => cellCentre(t.cell).lat > JABALPUR.lat).length;
    expect(ahead).toBeGreaterThan(behind);
  });

  it('★ orders the entire inner ring before any of the outer ring', () => {
    // Majors are cheap, but they are useless until the streets around the
    // vehicle are covered — that is where it actually is.
    const tasks = planCells(JABALPUR.lat, JABALPUR.lon, 45);
    const firstMajor = tasks.findIndex((t) => t.lod === 'major');
    const lastFull = tasks.map((t) => t.lod).lastIndexOf('full');
    expect(firstMajor).toBeGreaterThan(lastFull);
  });

  it('uses the measured zooms for each ring', () => {
    const tasks = planCells(JABALPUR.lat, JABALPUR.lon, null);
    expect(tasks.find((t) => t.lod === 'full')!.cell.z).toBe(LOD_ZOOM.full);
    expect(tasks.find((t) => t.lod === 'major')!.cell.z).toBe(LOD_ZOOM.major);
  });

  it('keeps the outer ring to a handful of cells, not hundreds', () => {
    // The measurement that made rolling coverage affordable: a major-only query
    // over 10,000 km² returns 3.1 MB in 2 s, so outer cells are z9 rather than
    // z11. At z11 this was ~97 requests.
    const majors = planCells(JABALPUR.lat, JABALPUR.lon, null).filter((t) => t.lod === 'major');
    expect(majors.length).toBeLessThan(30);
  });

  it('★ covers a 100 km radius in under 150 requests', () => {
    // The blocking problem this workstream had to solve first. A uniform 25 km²
    // grid over 31,400 km² is more than twelve hundred Overpass requests, which
    // at any polite rate is hours and would be refused long before finishing.
    // Splitting the area cap by query class — measured, a major-only query over
    // 10,000 km² returns 3.1 MB in 2.0 s — lets the outer ring use z9 cells and
    // collapses the total.
    const tasks = planCells(JABALPUR.lat, JABALPUR.lon, 0);
    const full = tasks.filter((t) => t.lod === 'full').length;
    const major = tasks.filter((t) => t.lod === 'major').length;
    // eslint-disable-next-line no-console
    console.log(`100 km radius plan: ${full} full + ${major} major = ${tasks.length} requests`);
    expect(tasks.length).toBeLessThan(150);
  });

  it('returns nothing for a position it cannot use', () => {
    expect(planCells(Number.NaN, 0, null)).toEqual([]);
  });

  it('never plans the same cell twice', () => {
    const tasks = planCells(JABALPUR.lat, JABALPUR.lon, 90);
    const keys = tasks.map((t) => cellKey(t.cell, t.lod));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('GraphPrefetcher', () => {
  it('★ never has more than one request in flight', async () => {
    const h = harness();
    const p = new GraphPrefetcher(h.deps);
    p.setTarget(JABALPUR.lat, JABALPUR.lon, 0);
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(h.peak()).toBe(1);
    expect(p.snapshot.peakConcurrency).toBe(1);
    expect(p.snapshot.fetched).toBeGreaterThan(0);
  }, 30_000);

  it('fetches in the planned order', async () => {
    const h = harness();
    const p = new GraphPrefetcher(h.deps);
    const planned = planCells(JABALPUR.lat, JABALPUR.lon, 0).map((t) => cellKey(t.cell, t.lod));
    p.setTarget(JABALPUR.lat, JABALPUR.lon, 0);
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(h.order.slice(0, 5)).toEqual(planned.slice(0, 5));
  }, 30_000);

  it('does not refetch a cell already in the store', async () => {
    const h = harness();
    const planned = planCells(JABALPUR.lat, JABALPUR.lon, null);
    const first = planned[0]!;
    await h.store.put(first.cell, first.lod, graph());

    const p = new GraphPrefetcher(h.deps);
    p.setTarget(JABALPUR.lat, JABALPUR.lon, null);
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(h.order).not.toContain(cellKey(first.cell, first.lod));
  }, 30_000);

  it('★ backs off and retries on 429 rather than dropping the cell', async () => {
    let calls = 0;
    const failures: number[] = [];
    const h = harness({
      fetchCell: async (cell, lod) => {
        calls++;
        if (calls <= 2) {
          failures.push(calls);
          const e = Object.assign(new Error('rate limited'), { status: 429 });
          throw e;
        }
        return graph();
      },
    });
    const p = new GraphPrefetcher(h.deps);
    p.setTarget(JABALPUR.lat, JABALPUR.lon, null);
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(failures).toEqual([1, 2]);
    // It kept going and did real work afterwards, rather than giving up.
    expect(p.snapshot.fetched).toBeGreaterThan(0);
  }, 30_000);

  it('gives up on a cell after repeated non-retryable failures', async () => {
    const h = harness({
      fetchCell: async () => {
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
    });
    const p = new GraphPrefetcher(h.deps);
    p.setTarget(JABALPUR.lat, JABALPUR.lon, null);
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(p.snapshot.failed).toBeGreaterThan(0);
    expect(p.snapshot.queued).toBe(0);
  }, 30_000);

  it('★ leaves no pending work after stop()', async () => {
    const h = harness();
    const p = new GraphPrefetcher(h.deps);
    p.setTarget(JABALPUR.lat, JABALPUR.lon, null);
    p.stop();
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(p.snapshot.queued).toBe(0);
  }, 30_000);

  it('★ spends nothing on a metered connection by default', async () => {
    // The tester's phone is on mobile data most of the time. Silently
    // downloading a coverage disc over it would be the other way to lose
    // someone's trust.
    const h = harness({ isMetered: () => true });
    const p = new GraphPrefetcher(h.deps);
    p.setTarget(JABALPUR.lat, JABALPUR.lon, null);
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(h.order).toHaveLength(0);
    expect(p.snapshot.skipped).toBeGreaterThan(0);
  }, 30_000);

  it('does use a metered connection when the user has allowed it', async () => {
    const h = harness({ isMetered: () => true, allowMetered: () => true });
    const p = new GraphPrefetcher(h.deps);
    p.setTarget(JABALPUR.lat, JABALPUR.lon, null);
    await vi.waitFor(() => expect(p.snapshot.running).toBe(false), { timeout: 20_000 });
    expect(h.order.length).toBeGreaterThan(0);
  }, 30_000);
});
