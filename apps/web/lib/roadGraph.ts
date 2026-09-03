import type { RoadGraph } from '@pathpulse/nav-core';
import { bboxContains, listStoredGraphs, loadStoredGraph } from '@/lib/roadGraphStore';

export interface RoadGraphEntry {
  name: string;
  /** Asset path for a bundled graph; empty for one downloaded on this device. */
  file: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  ways: number;
  sizeKb: number;
  /**
   * Where this graph came from.
   *
   * Surfaced rather than inferred, because "downloaded" and "shipped with the
   * app" have different failure modes and the offline screen has to be able to
   * say which one is covering you.
   */
  source: 'bundled' | 'downloaded';
}

interface Manifest {
  graphs: RoadGraphEntry[];
}

/**
 * Loads the road graph covering wherever the app happens to be.
 *
 * ★ WHY A MANIFEST AND NOT ONE BUNDLED GRAPH ★
 * A graph is a few hundred kilobytes per couple of square kilometres, so
 * bundling "everywhere" is not an option and bundling one fixed area means the
 * feature silently does nothing the moment anyone tests outside it — which is
 * exactly what happens when the demo routes are in Delhi and the developer is
 * not. The manifest lists what is available with its bounding box, so the right
 * one is chosen from the first fix and the absence of one can be *reported*
 * rather than mistaken for road snapping being broken.
 *
 * Everything is served from the app's own assets, so this works offline once
 * the APK is installed. Nothing here calls Overpass at runtime.
 */

let manifestPromise: Promise<Manifest | null> | null = null;
const graphCache = new Map<string, RoadGraph>();

async function loadManifest(): Promise<Manifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch('maps/index.json')
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .catch(() => null);
  }
  return manifestPromise;
}

function contains(bbox: RoadGraphEntry['bbox'], lat: number, lon: number): boolean {
  return bboxContains(bbox, lat, lon);
}

/** Every graph the build produced, plus everything downloaded on this device. */
export async function listRoadGraphs(): Promise<RoadGraphEntry[]> {
  const bundled = ((await loadManifest())?.graphs ?? []).map((g) => ({
    ...g,
    source: 'bundled' as const,
  }));
  const stored = (await listStoredGraphs()).map((g) => ({
    name: g.name,
    file: '',
    bbox: g.bbox,
    ways: g.ways,
    sizeKb: g.sizeKb,
    source: 'downloaded' as const,
  }));
  return [...bundled, ...stored];
}

/** The entry covering a position, or null if none does. */
export async function findGraphFor(lat: number, lon: number): Promise<RoadGraphEntry | null> {
  const graphs = await listRoadGraphs();
  // Smallest matching bbox wins: a tight local extract is a better match than a
  // wide one that merely happens to overlap.
  const matches = graphs.filter((g) => contains(g.bbox, lat, lon));
  if (matches.length === 0) return null;
  return matches.reduce((best, g) => (area(g.bbox) < area(best.bbox) ? g : best));
}

function area(b: RoadGraphEntry['bbox']): number {
  return Math.abs((b[2] - b[0]) * (b[3] - b[1]));
}

/** Fetch and cache a graph by entry, from app assets or from device storage. */
export async function loadRoadGraph(entry: RoadGraphEntry): Promise<RoadGraph | null> {
  if (entry.source === 'downloaded') {
    const stored = await loadStoredGraph(entry.name);
    return stored;
  }
  const cached = graphCache.get(entry.file);
  if (cached) return cached;
  try {
    const res = await fetch(`maps/${entry.file}`);
    if (!res.ok) return null;
    const graph = (await res.json()) as RoadGraph;
    graphCache.set(entry.file, graph);
    return graph;
  } catch {
    // Offline with no cached copy, or a corrupt asset. Road snapping simply
    // does not engage; it must never take the rest of the app down with it.
    return null;
  }
}

/** Convenience: find and load in one step. */
export async function loadRoadGraphFor(
  lat: number,
  lon: number,
): Promise<{ entry: RoadGraphEntry; graph: RoadGraph } | null> {
  const entry = await findGraphFor(lat, lon);
  if (!entry) return null;
  const graph = await loadRoadGraph(entry);
  return graph ? { entry, graph } : null;
}
