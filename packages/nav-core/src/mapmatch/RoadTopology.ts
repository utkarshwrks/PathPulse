/**
 * Phase 14 — the road network as a graph you can actually drive on.
 *
 * ★ WHY THIS EXISTS ★
 *
 * `RoadIndex` answers "which road segments are near this point". That is
 * everything Phase 6D's nearest-road snap needs and nothing the HMM needs. The
 * Newson-Krumm transition probability compares the ROUTE distance between two
 * candidate positions with the straight-line distance between them — the whole
 * idea being that a vehicle which appears to jump from one carriageway to a
 * parallel one has, in road terms, travelled a kilometre to the next junction
 * and back, and is therefore implausible.
 *
 * Route distance needs connectivity, and a list of ways does not have any.
 *
 * ★ HOW THE JUNCTIONS ARE FOUND ★
 *
 * They are already there, implicitly. Overpass returns each way's geometry
 * from shared OSM nodes, so two ways meeting at a junction carry the IDENTICAL
 * coordinate — not a nearby one, the same one. Hashing coordinates to a
 * centimetre grid recovers the topology exactly, with no tolerance to tune and
 * no risk of accidentally welding a flyover to the road beneath it, which a
 * distance-based join would do on every overpass in the country.
 */
import { latLonToEnu } from '../geo/enu.js';
import type { RoadGraph, RoadWay } from './types.js';

/** One traversable stretch of road between two junctions. */
export interface TopologyEdge {
  wayId: string;
  /** Junction node ids. */
  from: number;
  to: number;
  lengthM: number;
  /** Arc length along the parent way where this edge starts. */
  arcStartM: number;
  arcEndM: number;
  oneway: boolean;
}

export interface RoadTopologyConfig {
  /**
   * Ceiling on a route search, metres.
   *
   * Newson-Krumm's transition term only needs to distinguish "reachable and
   * roughly as far as the crow flies" from "not reachable at all". Beyond a
   * kilometre or so the answer is the same either way, and an unbounded
   * Dijkstra over a city graph inside a 10 Hz loop is not an option.
   */
  maxRouteM: number;
  /** Cap on the route-distance cache, entries. */
  cacheSize: number;
}

export const DEFAULT_TOPOLOGY_CONFIG: RoadTopologyConfig = {
  maxRouteM: 1500,
  cacheSize: 20_000,
};

/** Position of a candidate on the network: a way, and how far along it. */
export interface ArcPosition {
  wayId: string;
  arcLengthM: number;
}

const key = (e: number, n: number): string =>
  `${Math.round(e * 100)},${Math.round(n * 100)}`;

export class RoadTopology {
  private readonly config: RoadTopologyConfig;
  /** Junction id per coordinate hash. */
  private readonly nodeIds = new Map<string, number>();
  /** Outgoing edges per junction. */
  private readonly out = new Map<number, TopologyEdge[]>();
  /** Every edge of a way, in arc order. */
  private readonly wayEdges = new Map<string, TopologyEdge[]>();
  private readonly cache = new Map<string, number>();
  private nextNode = 0;

  constructor(
    graph: RoadGraph,
    originLat: number,
    originLon: number,
    config: Partial<RoadTopologyConfig> = {},
  ) {
    this.config = { ...DEFAULT_TOPOLOGY_CONFIG, ...config };

    // Pass one: count how many ways touch each coordinate. A coordinate used
    // by more than one way, or used twice by one way, is a junction.
    const uses = new Map<string, number>();
    const projected = new Map<string, Array<{ e: number; n: number; k: string }>>();

    for (const way of graph.ways) {
      const points = projectWay(way, originLat, originLon);
      if (points.length < 2) continue;
      projected.set(way.id, points);
      for (const p of points) uses.set(p.k, (uses.get(p.k) ?? 0) + 1);
    }

    // Pass two: cut each way at its junctions, and at its own endpoints.
    for (const [wayId, points] of projected) {
      const way = graph.ways.find((w) => w.id === wayId);
      const oneway = way?.oneway === true;
      const edges: TopologyEdge[] = [];

      let startIndex = 0;
      let arc = 0;
      let arcAtStart = 0;

      for (let i = 1; i < points.length; i++) {
        arc += Math.hypot(points[i]!.e - points[i - 1]!.e, points[i]!.n - points[i - 1]!.n);
        const isJunction = (uses.get(points[i]!.k) ?? 0) > 1;
        const isEnd = i === points.length - 1;
        if (!isJunction && !isEnd) continue;

        const from = this.nodeFor(points[startIndex]!.k);
        const to = this.nodeFor(points[i]!.k);
        if (from !== to && arc - arcAtStart > 0.01) {
          const edge: TopologyEdge = {
            wayId,
            from,
            to,
            lengthM: arc - arcAtStart,
            arcStartM: arcAtStart,
            arcEndM: arc,
            oneway,
          };
          edges.push(edge);
          this.link(from, edge);
          // A two-way road is traversable in reverse, and most roads are. A
          // matcher that could only follow OSM's drawing direction would
          // reject every legal route down a two-way street.
          if (!oneway) {
            this.link(to, {
              ...edge,
              from: to,
              to: from,
              arcStartM: arc,
              arcEndM: arcAtStart,
            });
          }
        }
        startIndex = i;
        arcAtStart = arc;
      }
      if (edges.length > 0) this.wayEdges.set(wayId, edges);
    }
  }

  get nodeCount(): number {
    return this.nextNode;
  }

  get edgeCount(): number {
    let n = 0;
    for (const edges of this.wayEdges.values()) n += edges.length;
    return n;
  }

  /** True when the two ways meet, directly or through a short route. */
  private nodeFor(k: string): number {
    let id = this.nodeIds.get(k);
    if (id === undefined) {
      id = this.nextNode++;
      this.nodeIds.set(k, id);
    }
    return id;
  }

  private link(from: number, edge: TopologyEdge): void {
    const list = this.out.get(from);
    if (list) list.push(edge);
    else this.out.set(from, [edge]);
  }

  /** The edge of `wayId` containing `arcLengthM`, or null. */
  edgeAt(pos: ArcPosition): TopologyEdge | null {
    const edges = this.wayEdges.get(pos.wayId);
    if (!edges) return null;
    for (const e of edges) {
      if (pos.arcLengthM >= e.arcStartM - 0.01 && pos.arcLengthM <= e.arcEndM + 0.01) return e;
    }
    // Past the end of the way — the closest edge is the last one.
    return edges[edges.length - 1] ?? null;
  }

  /**
   * Shortest driveable distance between two positions on the network, metres,
   * or `null` when there is no route inside `maxRouteM`.
   *
   * ★ WHY null IS A USEFUL ANSWER ★ "No route" is exactly the evidence the HMM
   * wants when a candidate sits on the other carriageway of a dual
   * carriageway, or on a flyover above the road actually being driven. Those
   * are metres away in a straight line and unreachable without a long detour,
   * and a matcher that cannot express that will keep choosing them.
   */
  routeDistanceM(from: ArcPosition, to: ArcPosition): number | null {
    if (from.wayId === to.wayId) {
      const a = this.edgeAt(from);
      const b = this.edgeAt(to);
      // Same edge: the distance along the road IS the difference in arc length.
      if (a && b && a.from === b.from && a.to === b.to) {
        return Math.abs(to.arcLengthM - from.arcLengthM);
      }
    }

    const start = this.edgeAt(from);
    const goal = this.edgeAt(to);
    if (!start || !goal) return null;

    const cacheKey = `${start.to}>${goal.from}`;
    const cached = this.cache.get(cacheKey);
    let junctionToJunction: number | null;
    if (cached !== undefined) {
      junctionToJunction = cached < 0 ? null : cached;
    } else {
      junctionToJunction = this.dijkstra(start.to, goal.from);
      if (this.cache.size < this.config.cacheSize) {
        this.cache.set(cacheKey, junctionToJunction ?? -1);
      }
    }
    if (junctionToJunction === null) return null;

    // Distance from `from` to the end of its edge, plus the route between
    // junctions, plus the distance from the goal edge's start to `to`.
    const leadOut = Math.abs(start.arcEndM - from.arcLengthM);
    const leadIn = Math.abs(to.arcLengthM - goal.arcStartM);
    const total = leadOut + junctionToJunction + leadIn;
    return total > this.config.maxRouteM ? null : total;
  }

  /**
   * Dijkstra between two junctions, bounded.
   *
   * A binary heap would be faster and is not worth the code here: the search
   * is bounded at 1.5 km, which on a city graph is a few hundred nodes, and
   * the whole thing is behind a cache keyed on the junction pair. Measured
   * inside the ablation this is not the slow part.
   */
  private dijkstra(source: number, target: number): number | null {
    if (source === target) return 0;
    const dist = new Map<number, number>([[source, 0]]);
    const visited = new Set<number>();

    for (;;) {
      let current = -1;
      let best = Infinity;
      for (const [node, d] of dist) {
        if (!visited.has(node) && d < best) {
          best = d;
          current = node;
        }
      }
      if (current === -1 || best > this.config.maxRouteM) return null;
      if (current === target) return best;
      visited.add(current);

      for (const edge of this.out.get(current) ?? []) {
        const next = best + edge.lengthM;
        if (next > this.config.maxRouteM) continue;
        const known = dist.get(edge.to);
        if (known === undefined || next < known) dist.set(edge.to, next);
      }
    }
  }
}

function projectWay(
  way: RoadWay,
  originLat: number,
  originLon: number,
): Array<{ e: number; n: number; k: string }> {
  const out: Array<{ e: number; n: number; k: string }> = [];
  for (const [lon, lat] of way.coords ?? []) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = latLonToEnu(lat, lon, originLat, originLon);
    const k = key(p.e, p.n);
    // Duplicate consecutive points appear in OSM and would create a
    // zero-length edge with no direction.
    if (out.length > 0 && out[out.length - 1]!.k === k) continue;
    out.push({ e: p.e, n: p.n, k });
  }
  return out;
}
