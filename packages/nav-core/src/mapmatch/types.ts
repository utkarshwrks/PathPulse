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
  /**
   * Approximate height of this way above the surrounding ground, metres.
   *
   * Phase 14's flyover disambiguation. Derived from OSM's `layer` tag, which
   * is an ordering rather than a height, so this is a modelled estimate and is
   * usually absent — the HMM's altitude term is inert without it, which is the
   * common case and is why nothing else depends on it.
   */
  layerM?: number;
  /**
   * This way exists to be DRAWN, and must never be matched against.
   *
   * ★ THE MAP AND THE MATCHER WANT DIFFERENT ROAD SETS ★
   *
   * A precise offline basemap wants footways, tracks and paths — they are most
   * of what makes a neighbourhood recognisable. The matcher must never see one:
   * `build-road-graph.mjs` excludes footways deliberately, because A CAR IS NOT
   * ON THE PAVEMENT, and a vehicle snapped onto a footpath running parallel to
   * the road it is actually on is both wrong and completely plausible-looking.
   *
   * The separation is a FLAG ON THE TYPE rather than a convention about which
   * array to pass, because a convention is a comment and comments do not
   * survive refactors. `RoadIndex` filters on this at construction, so it is
   * not possible to hand the matcher a footpath by accident — the only way to
   * reintroduce the bug is to delete the filter, which is a visible act.
   *
   * Absent means an ordinary road: everything that existed before this flag
   * did is matchable, which is the safe default for old stored graphs.
   */
  renderOnly?: boolean;
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
