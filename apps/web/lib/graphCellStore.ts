import { decodeGraph, encodeGraph, type RoadGraph } from '@pathpulse/nav-core';
import {
  approxDistanceM,
  cellCentre,
  cellKey,
  parseCellKey,
  type CellId,
  type Lod,
} from './graphCells';

/**
 * Where offline coverage is kept.
 *
 * ★ THE BACKEND IS INJECTED, AND THAT IS THE POINT ★
 * The interesting behaviour here — what to keep, what to evict, in what order,
 * and never the cell you are standing in — is arithmetic over metadata. Binding
 * it to IndexedDB would make all of it testable only in a browser, which in
 * practice means untested; the existing lib/roadGraphStore.ts has no tests for
 * exactly that reason. A tiny interface moves every decision into a headless
 * test and leaves IndexedDB as the boring part.
 */

export interface CellRecord {
  key: string;
  lod: Lod;
  bytes: Uint8Array;
  fetchedAt: number;
  lastUsedAt: number;
}

export type CellMeta = Omit<CellRecord, 'bytes'> & { size: number };

export interface CellBackend {
  get(key: string): Promise<CellRecord | null>;
  put(rec: CellRecord): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  list(): Promise<CellMeta[]>;
  clear(): Promise<void>;
}

/** An in-memory backend. Used by tests, and as the fallback when IDB is absent. */
export class MemoryCellBackend implements CellBackend {
  private readonly map = new Map<string, CellRecord>();

  async get(key: string): Promise<CellRecord | null> {
    return this.map.get(key) ?? null;
  }
  async put(rec: CellRecord): Promise<void> {
    this.map.set(rec.key, rec);
  }
  async delete(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.map.delete(k);
  }
  async list(): Promise<CellMeta[]> {
    return [...this.map.values()].map(({ bytes, ...rest }) => ({ ...rest, size: bytes.length }));
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
}

/**
 * Default storage ceiling, bytes.
 *
 * Generous on purpose: measured, a 100 km radius under the two-ring LOD scheme
 * is about 3.5 MB at dense-city density and less in real terrain, so 50 MB is
 * roughly a decade of headroom rather than a limit anyone will meet. It exists
 * because unbounded growth on someone else's phone is a bug that surfaces as a
 * storage-full error weeks later, on a device you cannot inspect.
 */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export class GraphCellStore {
  constructor(
    private readonly backend: CellBackend,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  async has(cell: CellId, lod: Lod): Promise<boolean> {
    return (await this.backend.get(cellKey(cell, lod))) !== null;
  }

  /** Store a cell, encoding it with the compact codec. */
  async put(cell: CellId, lod: Lod, graph: RoadGraph, now = Date.now()): Promise<void> {
    await this.backend.put({
      key: cellKey(cell, lod),
      lod,
      bytes: encodeGraph(graph),
      fetchedAt: now,
      lastUsedAt: now,
    });
  }

  /**
   * Load and decode a cell, marking it used.
   *
   * A cell that fails to decode is DELETED rather than returned or kept. It can
   * only be a truncated or corrupted write, the codec refuses to guess at those
   * by design, and leaving it in place would mean the prefetcher believes the
   * area is covered while every read of it throws.
   */
  async get(cell: CellId, lod: Lod, now = Date.now()): Promise<RoadGraph | null> {
    const key = cellKey(cell, lod);
    const rec = await this.backend.get(key);
    if (!rec) return null;
    try {
      const graph = decodeGraph(rec.bytes);
      await this.backend.put({ ...rec, lastUsedAt: now });
      return graph;
    } catch {
      await this.backend.delete([key]);
      return null;
    }
  }

  async totalBytes(): Promise<number> {
    return (await this.backend.list()).reduce((sum, m) => sum + m.size, 0);
  }

  async list(): Promise<CellMeta[]> {
    return this.backend.list();
  }

  /**
   * Drop everything outside the coverage radius, then trim to the size cap.
   *
   * ★ THE CELL UNDER THE VEHICLE IS NEVER EVICTED ★
   * Whatever the cap says. Evicting it would remove the graph the estimator is
   * snapping to at that instant, and the visible result — snapping disengaging
   * mid-drive for no reason a user could observe — is far worse than being a
   * few hundred kilobytes over a self-imposed limit for one more cell.
   */
  async evict(
    lat: number,
    lon: number,
    radiusM: number,
    opts: { keep?: readonly string[] } = {},
  ): Promise<{ removed: number; bytesAfter: number }> {
    const metas = await this.backend.list();
    const keep = new Set(opts.keep ?? []);

    const distanceOf = (m: CellMeta): number => {
      const parsed = parseCellKey(m.key);
      if (!parsed) return Infinity; // unparseable: not ours, drop it
      const c = cellCentre(parsed.cell);
      return approxDistanceM(lat, lon, c.lat, c.lon);
    };

    const doomed: string[] = [];
    const survivors: Array<CellMeta & { distanceM: number }> = [];
    for (const m of metas) {
      const d = distanceOf(m);
      if (!keep.has(m.key) && d > radiusM) doomed.push(m.key);
      else survivors.push({ ...m, distanceM: d });
    }

    // Then the size cap, oldest-used first. Distance is the primary signal for
    // relevance and recency the tie-break, because a cell just behind you and a
    // cell just ahead are the same distance and the one you have not touched is
    // the one you are leaving.
    let total = survivors.reduce((s, m) => s + m.size, 0);
    if (total > this.maxBytes) {
      const byAge = survivors
        .filter((m) => !keep.has(m.key))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || b.distanceM - a.distanceM);
      for (const m of byAge) {
        if (total <= this.maxBytes) break;
        doomed.push(m.key);
        total -= m.size;
      }
    }

    if (doomed.length > 0) await this.backend.delete(doomed);
    return { removed: doomed.length, bytesAfter: total };
  }

  async clear(): Promise<void> {
    await this.backend.clear();
  }
}

/**
 * Ask the browser to keep this origin's storage.
 *
 * ★ WITHOUT THIS, COVERAGE CAN VANISH MID-DRIVE ★
 * Browsers evict "best effort" origin storage under disk pressure, with no
 * warning and no event. For an ordinary web app that means a slow reload; here
 * it means the user is in a tunnel with no signal and the roads have gone —
 * the exact scenario the whole feature exists for, failing silently at the
 * worst possible moment.
 *
 * Refusal is normal and is not an error: Chrome grants persistence on
 * engagement heuristics, and an installed PWA or the Capacitor WebView usually
 * qualifies while a first visit does not. The caller surfaces the answer rather
 * than retrying, because there is nothing to retry — it is the browser's call.
 */
export async function requestPersistentStorage(): Promise<'granted' | 'denied' | 'unsupported'> {
  try {
    const storage = (navigator as Navigator & { storage?: StorageManager }).storage;
    if (!storage?.persist || !storage.persisted) return 'unsupported';
    if (await storage.persisted()) return 'granted';
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

const DB_NAME = 'pathpulse-cells';
const STORE = 'cells';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

/** IndexedDB backend. localStorage is not an option — a city cell is ~300 KB. */
export class IdbCellBackend implements CellBackend {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async get(key: string): Promise<CellRecord | null> {
    const store = await this.tx('readonly');
    return (await promisify(store.get(key))) ?? null;
  }

  async put(rec: CellRecord): Promise<void> {
    const store = await this.tx('readwrite');
    await promisify(store.put(rec));
  }

  async delete(keys: readonly string[]): Promise<void> {
    const store = await this.tx('readwrite');
    await Promise.all(keys.map((k) => promisify(store.delete(k))));
  }

  async list(): Promise<CellMeta[]> {
    const store = await this.tx('readonly');
    const all = (await promisify(store.getAll())) as CellRecord[];
    return all.map(({ bytes, ...rest }) => ({ ...rest, size: bytes.byteLength }));
  }

  async clear(): Promise<void> {
    const store = await this.tx('readwrite');
    await promisify(store.clear());
  }
}

/** IndexedDB where available, memory where not, so tests and SSR never throw. */
export function createCellBackend(): CellBackend {
  if (typeof indexedDB === 'undefined') return new MemoryCellBackend();
  return new IdbCellBackend();
}

let shared: GraphCellStore | null = null;

/**
 * The one store the whole app shares.
 *
 * ★ TWO INSTANCES WOULD LOOK LIKE THE FEATURE NOT WORKING ★
 * The prefetcher writes cells and the navigation engine reads them. Backed by
 * the same IndexedDB they would eventually agree, but each instance caches
 * nothing and re-opens the database, and — worse — the eviction bookkeeping
 * (lastUsedAt, the size cap) would be computed twice over the same rows from
 * two different ideas of what had been touched. A module singleton is the
 * smallest thing that makes "the prefetcher filled it, the engine found it"
 * true by construction rather than by timing.
 */
export function getSharedCellStore(): GraphCellStore {
  shared ??= new GraphCellStore(createCellBackend());
  return shared;
}
