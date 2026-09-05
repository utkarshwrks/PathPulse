import type { RoadGraph } from '@pathpulse/nav-core';
import {
  approxDistanceM,
  cellCentre,
  cellKey,
  cellsCovering,
  INNER_RADIUS_M,
  OUTER_RADIUS_M,
  type CellId,
  type Lod,
} from './graphCells';
import type { GraphCellStore } from './graphCellStore';

/**
 * Background acquisition of offline coverage.
 *
 * ★ THE REQUIREMENT, IN THE TESTER'S WORDS ★
 * "I stuck in a area where is no internet, I just click on live then it
 * correctly show my all the things." And: "they don't directly show that we
 * are downloading 50 MB — we have to do something that user don't know, but
 * back and back loads all the things."
 *
 * So: no prompt, no modal, no progress bar demanding attention. Coverage is
 * acquired while there is signal, so that when there is none the answer is
 * already on the device.
 *
 * ★ WHY EVERY REQUEST IS SERIALISED ★
 * Overpass is a free, shared, volunteer-run service. A burst of parallel
 * requests is the fastest way to get an app rate-limited, and a rate-limited
 * app has no offline coverage at all — so this is a correctness requirement,
 * not politeness. One request in flight, ever, with a pause between and
 * exponential backoff on refusal. `concurrency never exceeds 1` is asserted by
 * test rather than left to inspection, because it is the kind of property a
 * later refactor breaks without noticing.
 */

export interface PrefetchTask {
  cell: CellId;
  lod: Lod;
  /** Lower sorts first. */
  priority: number;
}

export interface PrefetchDeps {
  store: GraphCellStore;
  /** Fetch one cell. Throws on failure; may carry `status` for backoff. */
  fetchCell: (cell: CellId, lod: Lod, signal: AbortSignal) => Promise<RoadGraph>;
  /** Wall clock, injected so tests are not real-time. */
  now?: () => number;
  /** Delay, injected for the same reason. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** True when the connection is metered and we should not spend the user's data. */
  isMetered?: () => boolean;
  /** Whether prefetching on a metered connection is permitted anyway. */
  allowMetered?: () => boolean;
}

export interface PrefetchStats {
  queued: number;
  fetched: number;
  failed: number;
  skipped: number;
  running: boolean;
  lastError: string | null;
}

/** Pause between successful requests. Not a rate limit — a courtesy margin. */
export const REQUEST_SPACING_MS = 1200;
/** First backoff step; doubles up to the ceiling. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** Attempts before a cell is set aside for this session. */
export const MAX_ATTEMPTS = 4;

/**
 * The ordered list of cells that should be on the device.
 *
 * ★ ORDER IS THE FEATURE ★
 * All of these will be fetched eventually, and "eventually" for the full inner
 * ring is several minutes. What decides whether the app is useful in that
 * window is which cells arrive first, so the sequence is: the cell you are
 * standing in, then the ones ahead of you along your heading, then the rest of
 * the inner ring by distance, then the outer ring. A vehicle is going
 * somewhere; coverage should lead it rather than surround it evenly.
 */
export function planCells(
  lat: number,
  lon: number,
  headingDeg: number | null,
  innerRadiusM = INNER_RADIUS_M,
  outerRadiusM = OUTER_RADIUS_M,
): PrefetchTask[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const tasks: PrefetchTask[] = [];
  const seen = new Set<string>();

  const headingRad =
    headingDeg === null || !Number.isFinite(headingDeg) ? null : (headingDeg * Math.PI) / 180;

  const push = (cell: CellId, lod: Lod, priority: number) => {
    const key = cellKey(cell, lod);
    if (seen.has(key)) return;
    seen.add(key);
    tasks.push({ cell, lod, priority });
  };

  for (const cell of cellsCovering(lat, lon, innerRadiusM, 'full')) {
    const c = cellCentre(cell);
    const distanceM = approxDistanceM(lat, lon, c.lat, c.lon);

    // "Ahead" is the component of the offset along the heading, normalised by
    // distance — +1 directly ahead, -1 directly behind. Cells behind are still
    // fetched, just last: a vehicle can turn round, and the road it came in on
    // is the one it is most likely to leave by.
    let ahead = 0;
    if (headingRad !== null && distanceM > 1) {
      const dNorth = (c.lat - lat) * 110_574;
      const dEast = (c.lon - lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
      const fNorth = Math.cos(headingRad);
      const fEast = Math.sin(headingRad);
      ahead = (dNorth * fNorth + dEast * fEast) / Math.hypot(dNorth, dEast);
    }

    // Distance dominates; the heading term is worth up to half the inner radius
    // of "virtual closeness", which reorders neighbours without ever promoting a
    // far cell over the one underfoot.
    push(cell, 'full', distanceM - ahead * innerRadiusM * 0.5);
  }

  // The outer ring always sorts after the whole inner ring: majors are cheap
  // but they are useless until the streets around the vehicle are covered.
  const outerBase = innerRadiusM * 10;
  for (const cell of cellsCovering(lat, lon, outerRadiusM, 'major')) {
    const c = cellCentre(cell);
    push(cell, 'major', outerBase + approxDistanceM(lat, lon, c.lat, c.lon));
  }

  return tasks.sort((a, b) => a.priority - b.priority);
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : null;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

export class GraphPrefetcher {
  private readonly deps: Required<Omit<PrefetchDeps, 'store' | 'fetchCell'>> &
    Pick<PrefetchDeps, 'store' | 'fetchCell'>;
  private queue: PrefetchTask[] = [];
  private attempts = new Map<string, number>();
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private stats: PrefetchStats = {
    queued: 0,
    fetched: 0,
    failed: 0,
    skipped: 0,
    running: false,
    lastError: null,
  };
  /** Guards the single-flight invariant. */
  private inFlight = 0;
  private maxObservedInFlight = 0;

  constructor(deps: PrefetchDeps) {
    this.deps = {
      now: () => Date.now(),
      sleep: defaultSleep,
      isMetered: () => false,
      allowMetered: () => false,
      ...deps,
    };
  }

  get snapshot(): PrefetchStats & { peakConcurrency: number } {
    return { ...this.stats, queued: this.queue.length, peakConcurrency: this.maxObservedInFlight };
  }

  /**
   * Set the coverage target and start working toward it.
   *
   * Replacing the queue rather than appending is deliberate: the plan is a
   * function of where the vehicle is now, and a queue built around a position
   * 30 km back is work nobody wants done first.
   */
  setTarget(lat: number, lon: number, headingDeg: number | null): void {
    this.queue = planCells(lat, lon, headingDeg);
    this.stats.queued = this.queue.length;
    this.start();
  }

  start(): void {
    if (this.loop) return;
    this.controller = new AbortController();
    this.stats.running = true;
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.stats.running = false;
    });
  }

  /** Cancel everything in flight and leave no pending work. */
  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.queue = [];
    this.stats.queued = 0;
    this.stats.running = false;
  }

  private async run(): Promise<void> {
    const signal = this.controller!.signal;
    let backoff = BACKOFF_BASE_MS;

    while (this.queue.length > 0 && !signal.aborted) {
      if (this.deps.isMetered() && !this.deps.allowMetered()) {
        // Not an error and not a failure: there is simply nothing we are
        // willing to spend here. Stop rather than spin.
        this.stats.skipped += this.queue.length;
        this.queue = [];
        break;
      }

      const task = this.queue.shift()!;
      const key = cellKey(task.cell, task.lod);

      if (await this.deps.store.has(task.cell, task.lod)) continue;

      try {
        this.inFlight++;
        this.maxObservedInFlight = Math.max(this.maxObservedInFlight, this.inFlight);
        const graph = await this.deps.fetchCell(task.cell, task.lod, signal);
        this.inFlight--;
        await this.deps.store.put(task.cell, task.lod, graph, this.deps.now());
        this.stats.fetched++;
        this.attempts.delete(key);
        backoff = BACKOFF_BASE_MS;
        if (this.queue.length > 0) await this.deps.sleep(REQUEST_SPACING_MS, signal);
      } catch (err) {
        this.inFlight--;
        if (signal.aborted) break;

        const attempts = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, attempts);
        this.stats.lastError = err instanceof Error ? err.message : String(err);

        const status = statusOf(err);
        // 429 is "you are asking too fast" and 504 is "I could not finish in
        // time" — both mean wait and try again, not give up. Anything else is
        // most likely a box with nothing in it or a malformed query, which
        // retrying cannot fix.
        const retryable = status === 429 || status === 504 || status === null;

        if (retryable && attempts < MAX_ATTEMPTS) {
          this.queue.push(task); // back of the queue: never block the rest
          try {
            await this.deps.sleep(backoff, signal);
          } catch {
            break;
          }
          backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        } else {
          this.stats.failed++;
        }
      }
    }
  }
}
