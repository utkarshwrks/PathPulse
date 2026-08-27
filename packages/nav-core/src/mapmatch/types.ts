/**
 * Road graph types.
 *
 * Deliberately flat and JSON-shaped: the graph is generated once by
 * `scripts/build-road-graph.mjs` from OpenStreetMap and bundled with the app,
 * so it must survive `JSON.parse` with no revival step and no classes.
 */

export interface RoadWay {
  /** OSM way id, e.g. "w123456". */
  id: string;
  name?: string;
  /** Speed limit in km/h, when OSM has one. */
  maxspeed?: number;
  oneway?: boolean;
  /** OSM highway class — motorway, trunk, residential, service... */
  highway?: string;
  /** [lon, lat] pairs, in order along the way. */
  coords: Array<[number, number]>;
}

export interface RoadGraph {
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  ways: RoadWay[];
  /** Free-form provenance: when it was generated, from where, by what query. */
  meta?: Record<string, string | number>;
}

/** A point on a specific road, expressed both ways. */
export interface RoadPosition {
  wayId: string;
  name?: string;
  maxspeedKph?: number;
  /** Distance along the way from its first coordinate, metres. */
  arcLengthM: number;
  /** The snapped point, in the engine's ENU frame. */
  enu: { e: number; n: number };
  /** Perpendicular distance from the query point to the road, metres. */
  distanceM: number;
  /** Bearing of the road at the matched point, degrees clockwise from north. */
  bearingDeg: number;
}
