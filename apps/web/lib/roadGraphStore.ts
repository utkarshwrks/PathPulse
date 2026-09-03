import type { RoadGraph } from '@pathpulse/nav-core';
import type { BBox } from '@/lib/roadGraphFetch';

/**
 * Road graphs downloaded on this device, kept in IndexedDB.
 *
 * ★ WHY INDEXEDDB AND NOT localStorage OR THE CACHE API ★
 * A city graph is one to three megabytes of JSON. localStorage is synchronous,
 * capped around five megabytes for the whole origin, and would block the
 * render thread parsing it — on the one screen that must stay at 10 Hz.
 * The Cache API stores Responses and is already owned by the tile worker;
 * putting a synthetic non-tile entry in there would break its allowlist
 * invariant. IndexedDB is the one built for large structured values.
 */

const DB_NAME = 'pathpulse-maps';
const DB_VERSION = 1;
const STORE = 'graphs';

export interface StoredGraphMeta {
  name: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  ways: number;
  sizeKb: number;
  downloadedAt: number;
}

interface StoredGraph extends StoredGraphMeta {
  graph: RoadGraph;
}

function supported(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** A name a person can recognise later, from the box's centre. */
export function nameForBBox(b: BBox): string {
  const lat = ((b.minLat + b.maxLat) / 2).toFixed(3);
  const lon = ((b.minLon + b.maxLon) / 2).toFixed(3);
  return `${lat},${lon}`;
}

export async function saveGraph(b: BBox, graph: RoadGraph): Promise<StoredGraphMeta> {
  const meta: StoredGraphMeta = {
    name: nameForBBox(b),
    bbox: [b.minLon, b.minLat, b.maxLon, b.maxLat],
    ways: graph.ways.length,
    sizeKb: Math.round(JSON.stringify(graph).length / 1024),
    downloadedAt: Date.now(),
  };
  if (!supported()) return meta;
  const record: StoredGraph = { ...meta, graph };
  await tx('readwrite', (s) => s.put(record) as unknown as IDBRequest<IDBValidKey>);
  return meta;
}

export async function listStoredGraphs(): Promise<StoredGraphMeta[]> {
  if (!supported()) return [];
  try {
    const all = await tx<StoredGraph[]>('readonly', (s) => s.getAll() as IDBRequest<StoredGraph[]>);
    // Strip the graphs themselves — callers listing what is stored do not want
    // several megabytes of coordinates handed to them to count.
    return all.map(({ graph: _g, ...meta }) => meta);
  } catch {
    return [];
  }
}

export async function loadStoredGraph(name: string): Promise<RoadGraph | null> {
  if (!supported()) return null;
  try {
    const rec = await tx<StoredGraph | undefined>(
      'readonly',
      (s) => s.get(name) as IDBRequest<StoredGraph | undefined>,
    );
    return rec?.graph ?? null;
  } catch {
    return null;
  }
}

export async function deleteStoredGraphs(): Promise<void> {
  if (!supported()) return;
  try {
    await tx('readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>);
  } catch {
    // Nothing stored, or storage denied. Either way there is nothing to clear.
  }
}

export function bboxContains(bbox: StoredGraphMeta['bbox'], lat: number, lon: number): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}
