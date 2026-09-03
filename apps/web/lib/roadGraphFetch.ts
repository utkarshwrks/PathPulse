import type { RoadGraph } from '@pathpulse/nav-core';
import type { LatLonBounds } from '@/lib/tileCache';

/**
 * Build a road graph for wherever the vehicle actually is, at runtime.
 *
 * ★ WHY THIS BREAKS A RULE ON PURPOSE ★
 *
 * `scripts/build-road-graph.mjs` says, in capitals, RUN ONCE AND COMMIT THE
 * RESULT — because a demo that needs a live API call to draw its roads is a
 * demo that fails in a room with bad wifi. That reasoning is still right, and
 * nothing here changes it: the bundled graphs are still bundled, the tests and
 * the eval harness still never touch the network, and this code never runs
 * during a demo.
 *
 * What it fixes is the other half of the same problem. The bundled graphs
 * cover three bounding boxes chosen months ago. Drive anywhere else and road
 * snapping silently does nothing — and since road snapping is what keeps the
 * marker on the road during an outage, "anywhere else" means the marker
 * wanders into the fields. You cannot commit a graph for a location you do not
 * know yet, and "we will demo in Delhi" is not a plan when the room is chosen
 * by somebody else.
 *
 * So: while there IS a network, fetch the area once and store it. From then on
 * the area is as offline-capable as a bundled one. The rule becomes "never
 * fetch during a demo", which is what it always meant.
 */

/**
 * Road classes worth matching against — identical to the build script's list,
 * and deliberately so: two different definitions of "a road" would mean the
 * downloaded graph and the committed one behave differently on the same
 * street.
 *
 * Excludes footway, path, cycleway and steps, because a vehicle cannot be on
 * them and offering them as candidates lets the matcher snap a car onto the
 * pavement beside its actual road. `service` is kept — car parks and access
 * roads are exactly where GNSS fails.
 */
const HIGHWAY_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Largest area that may be requested, square kilometres.
 *
 * Overpass rate-limits hard and a careless bounding box is both a long wait
 * and a good way to get the endpoint to refuse everything for a while. 25 km²
 * is a generous city drive and returns in a few seconds.
 */
export const MAX_AREA_SQ_KM = 25;

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function boundsToBBox(b: LatLonBounds): BBox {
  return { minLon: b.west, minLat: b.south, maxLon: b.east, maxLat: b.north };
}

/** A square box of `radiusM` around a point — used when there is no map yet. */
export function bboxAround(lat: number, lon: number, radiusM: number): BBox {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { minLon: lon - dLon, minLat: lat - dLat, maxLon: lon + dLon, maxLat: lat + dLat };
}

export function areaSqKm(b: BBox): number {
  const midLat = (b.minLat + b.maxLat) / 2;
  const widthKm = (b.maxLon - b.minLon) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const heightKm = (b.maxLat - b.minLat) * 111.32;
  return Math.abs(widthKm * heightKm);
}

export function buildOverpassQuery(b: BBox): string {
  const bbox = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const filter = HIGHWAY_CLASSES.join('|');
  // `out geom` returns each way's coordinates inline, so there is no second
  // pass to resolve node ids — far less data and far less code.
  return `[out:json][timeout:90];way["highway"~"^(${filter})$"](${bbox});out geom;`;
}

/** OSM maxspeed tags are free text: "50", "50 mph", "RU:urban", "none". */
export function parseMaxspeed(tag: string | undefined): number | undefined {
  if (!tag) return undefined;
  const mph = /^(\d+(?:\.\d+)?)\s*mph$/i.exec(tag);
  if (mph) return Math.round(Number(mph[1]) * 1.609344);
  const kph = /^(\d+(?:\.\d+)?)(\s*km\/?h)?$/i.exec(tag.trim());
  if (kph) return Math.round(Number(kph[1]));
  return undefined;
}

/** One element of an Overpass `out geom` response. Exported for the tests. */
export interface OsmElement {
  type?: string;
  id?: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

/** Convert an Overpass response into the graph shape nav-core consumes. */
export function osmToGraph(osm: { elements?: OsmElement[] }, b: BBox): RoadGraph {
  const ways: RoadGraph['ways'] = [];
  for (const el of osm.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const way: RoadGraph['ways'][number] = {
      id: `w${el.id}`,
      coords: el.geometry.map(
        (g) => [Number(g.lon.toFixed(7)), Number(g.lat.toFixed(7))] as [number, number],
      ),
    };
    if (tags.name) way.name = tags.name;
    if (tags.highway) way.highway = tags.highway;
    const ms = parseMaxspeed(tags.maxspeed);
    if (ms !== undefined) way.maxspeed = ms;
    // "-1" means one-way against the drawn direction; treating it as one-way
    // in the drawn direction would be worse than treating it as two-way.
    if (tags.oneway === 'yes' || tags.oneway === 'true' || tags.oneway === '1') {
      way.oneway = true;
    }
    ways.push(way);
  }
  return {
    bbox: [b.minLon, b.minLat, b.maxLon, b.maxLat].map((v) => Number(v.toFixed(7))) as [
      number,
      number,
      number,
      number,
    ],
    ways,
  };
}

export class RoadGraphFetchError extends Error {}

/**
 * Fetch a road graph for a bounding box.
 *
 * Tries each mirror in turn. Overpass answers 406 to requests without an
 * identifiable User-Agent, but a browser will not let us set that header — so
 * the endpoints that require it simply fail and the next one is used. That is
 * why there is more than one.
 */
export async function fetchRoadGraph(b: BBox, signal?: AbortSignal): Promise<RoadGraph> {
  const area = areaSqKm(b);
  if (area > MAX_AREA_SQ_KM) {
    throw new RoadGraphFetchError(
      `area is ${area.toFixed(0)} km², over the ${MAX_AREA_SQ_KM} km² limit — zoom in first`,
    );
  }

  const query = buildOverpassQuery(b);
  let lastError: unknown;

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: signal ?? null,
      });
      if (!res.ok) throw new RoadGraphFetchError(`HTTP ${res.status}`);
      const json = (await res.json()) as { elements?: OsmElement[] };
      const graph = osmToGraph(json, b);
      if (graph.ways.length === 0) {
        throw new RoadGraphFetchError('no roads found here — is the area correct?');
      }
      return graph;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }

  throw new RoadGraphFetchError(
    `every OpenStreetMap mirror failed (${
      lastError instanceof Error ? lastError.message : 'unknown'
    }). It rate-limits aggressively — wait a minute and try again.`,
  );
}
