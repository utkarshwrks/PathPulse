import type { RoadGraph } from '@pathpulse/nav-core';
import { bboxContains, listStoredGraphs, loadStoredGraph } from '@/lib/roadGraphStore';
import { cellsCovering, mergeGraphs, type Lod } from '@/lib/graphCells';
import type { GraphCellStore } from '@/lib/graphCellStore';

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

/**
 * How much of the prefetched disc is actually handed to the estimator.
 *
 * ★ COVERAGE AND WORKING SET ARE DIFFERENT QUANTITIES ★
 * The prefetcher acquires 100 km so the data is on the device before the signal
 * goes. The estimator does not want 100 km: RoadIndex is rebuilt whenever the
 * graph changes, snapping searches 50 m, and the particle filter does a
 * positionAt lookup per particle per step. Handing it the whole disc would cost
 * a large rebuild for roads the vehicle cannot reach for an hour.
 *
 * So the working set is a smaller disc that travels with the vehicle: full
 * detail near it, majors far enough out that a motorway stays matched.
 */
export const FULL_WORKING_RADIUS_M = 12_000;
export const MAJOR_WORKING_RADIUS_M = 60_000;

/**
 * Build a graph from prefetched cells, if any cover this position.
 *
 * Inner cells are merged first, so where a full-detail cell and a major-only
 * cell both contain a road, the fuller copy is the one kept — see mergeGraphs,
 * which takes the first occurrence of each way id.
 */
export async function loadCellGraphFor(
  store: GraphCellStore,
  lat: number,
  lon: number,
): Promise<RoadGraph | null> {
  const parts: RoadGraph[] = [];
  const rings: Array<{ lod: Lod; radiusM: number }> = [
    { lod: 'full', radiusM: FULL_WORKING_RADIUS_M },
    { lod: 'major', radiusM: MAJOR_WORKING_RADIUS_M },
  ];

  for (const { lod, radiusM } of rings) {
    for (const cell of cellsCovering(lat, lon, radiusM, lod)) {
      const g = await store.get(cell, lod);
      if (g) parts.push(g);
    }
  }

  if (parts.length === 0) return null;
  const merged = mergeGraphs(parts);
  return merged.ways.length > 0 ? merged : null;
}

/**
 * Convenience: find and load in one step.
 *
 * ★ PREFETCHED CELLS WIN OVER A BUNDLED GRAPH ★
 * When both cover the position, the cells are the better answer: they are
 * centred on the vehicle rather than on whatever box someone drew at build
 * time, they are current, and they are the mechanism that works everywhere
 * rather than in the three areas this app happened to ship with. The bundled
 * manifest stays as the fallback, which is what makes the app useful on first
 * run before any prefetching has happened.
 */
export async function loadRoadGraphFor(
  lat: number,
  lon: number,
  cellStore?: GraphCellStore,
): Promise<{ entry: RoadGraphEntry; graph: RoadGraph } | null> {
  if (cellStore) {
    const graph = await loadCellGraphFor(cellStore, lat, lon);
    if (graph) {
      return {
        entry: {
          name: 'offline coverage',
          file: '',
          bbox: graph.bbox,
          ways: graph.ways.length,
          sizeKb: 0,
          source: 'downloaded',
        },
        graph,
      };
    }
  }
  const entry = await findGraphFor(lat, lon);
  if (!entry) return null;
  const graph = await loadRoadGraph(entry);
  return graph ? { entry, graph } : null;
}
