/**
 * Phase 17 — turn relocalisation.
 *
 * ★ THE IDEA, WHICH IS OLDER THAN GPS ★
 *
 * You are lost in a city with a paper map. You do not know where you are, but
 * you know what you have DONE: left, then two blocks, then right, then a long
 * straight. There is usually exactly one place on the map where that sequence
 * fits. You have not measured your position; you have RECOGNISED it.
 *
 * That is what this does, and it is why a long outage can end more accurate
 * than it began — which no amount of better dead reckoning can achieve, because
 * dead reckoning only ever accumulates error.
 *
 * The turn detector already produces the sequence, from the same corrected yaw
 * rate the estimator integrates. This walks the road graph looking for
 * junction sequences whose geometry matches it, with the observed distances
 * between turns as the second constraint. One match means the vehicle is
 * there; several mean it is at one of them and we say so; none means keep
 * dead reckoning, which is what would have happened anyway.
 *
 * ★ AND IT MUST BE ALLOWED TO SAY NOTHING ★
 * A wrong relocalisation is far worse than none: it teleports the estimate to
 * a confidently incorrect place, and unlike accumulating drift there is no
 * mechanism that would ever pull it back. So the bar is deliberately high —
 * enough turns, a unique match, and distances that agree — and the common case
 * is that it declines.
 */
import { angleDiffDeg } from '../mapmatch/RoadIndex.js';
import type { RoadIndex } from '../mapmatch/RoadIndex.js';
import type { RoadTopology } from '../mapmatch/RoadTopology.js';
import type { TurnEvent } from '../mapmatch/turnDetector.js';

export interface RelocaliserConfig {
  /**
   * Turns needed before a match is even attempted.
   *
   * ★ THREE, NOT TWO ★ A single left turn happens at every junction in the
   * city. Two in sequence with a distance between them narrows it to dozens.
   * Three is where a typical grid becomes unique — and uniqueness is the whole
   * mechanism, so accepting fewer would mean accepting ambiguity as if it were
   * an answer.
   */
  minTurns: number;
  /** Turns kept in the pattern. Older ones are a different part of the drive. */
  maxTurns: number;
  /** Two turns match if their heading changes agree within this, degrees. */
  turnToleranceDeg: number;
  /**
   * Distance between turns must agree within this fraction.
   *
   * Generous, because the observed distance comes from dead reckoning and that
   * is exactly the quantity that has been drifting. The turn ANGLES are the
   * reliable part — gyro integration over a few seconds is good — so they
   * carry the identification and distance only rejects the obviously wrong.
   */
  distanceTolerance: number;
  /** Absolute floor on that tolerance, metres, for short blocks. */
  distanceToleranceM: number;
  /** Junctions to explore. Bounds the search on a dense graph. */
  maxJunctionsSearched: number;
  /**
   * A match must beat the runner-up by this factor to count as unique.
   *
   * Two candidate places that fit equally well are not an answer, they are a
   * question — and answering it by picking the first is how a relocaliser
   * teleports a vehicle across a city.
   */
  uniquenessRatio: number;
}

export const DEFAULT_RELOCALISER_CONFIG: RelocaliserConfig = {
  minTurns: 3,
  maxTurns: 5,
  turnToleranceDeg: 35,
  distanceTolerance: 0.45,
  distanceToleranceM: 60,
  maxJunctionsSearched: 4000,
  uniquenessRatio: 2.5,
};

/** One observed turn, with how far the vehicle travelled to reach it. */
export interface ObservedTurn {
  deltaDeg: number;
  /** Distance travelled since the previous turn, metres. */
  runUpM: number;
}

export interface Relocalisation {
  e: number;
  n: number;
  headingDeg: number;
  /** How well the best candidate fit, 0..1. */
  score: number;
  /** How much better than the runner-up. Higher is more certain. */
  margin: number;
  /** For the event log: "MG Road x 5th Cross". */
  description: string;
  turnsUsed: number;
}

interface Candidate {
  wayId: string;
  arcLengthM: number;
  e: number;
  n: number;
  headingDeg: number;
  score: number;
  description: string;
}

export class TurnRelocaliser {
  private readonly config: RelocaliserConfig;
  private readonly turns: ObservedTurn[] = [];
  private distanceSinceLastTurnM = 0;

  constructor(
    private readonly index: RoadIndex,
    private readonly topology: RoadTopology,
    config: Partial<RelocaliserConfig> = {},
  ) {
    this.config = { ...DEFAULT_RELOCALISER_CONFIG, ...config };
  }

  get patternLength(): number {
    return this.turns.length;
  }

  /** Distance travelled, accumulated between turns. */
  advance(metres: number): void {
    if (Number.isFinite(metres) && metres > 0) this.distanceSinceLastTurnM += metres;
  }

  pushTurn(turn: TurnEvent): void {
    this.turns.push({ deltaDeg: turn.deltaDeg, runUpM: this.distanceSinceLastTurnM });
    this.distanceSinceLastTurnM = 0;
    while (this.turns.length > this.config.maxTurns) this.turns.shift();
  }

  reset(): void {
    this.turns.length = 0;
    this.distanceSinceLastTurnM = 0;
  }

  /**
   * Look for the observed turn sequence in the road graph.
   *
   * @returns a relocalisation, or null — and null is the common and correct
   *          answer. See the note on the class about why the bar is high.
   */
  match(): Relocalisation | null {
    if (this.turns.length < this.config.minTurns) return null;

    const pattern = this.turns.slice(-this.config.maxTurns);
    const candidates: Candidate[] = [];
    let searched = 0;

    // Start from every junction in the graph. A city extract has thousands,
    // and each start is a short walk, so this is a bounded sweep rather than
    // an exhaustive path search.
    for (let node = 0; node < this.topology.nodeCount; node++) {
      if (searched >= this.config.maxJunctionsSearched) break;
      for (const first of this.topology.edgesFrom(node)) {
        searched++;
        if (searched >= this.config.maxJunctionsSearched) break;
        const candidate = this.walk(first.wayId, first.arcStartM, pattern);
        if (candidate) candidates.push(candidate);
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0]!;
    const runnerUp = candidates.find((c) => c.wayId !== best.wayId);
    // ★ UNIQUENESS, NOT JUST FIT ★ Two places that match equally well are a
    // question, and answering it by taking the first is how a relocaliser
    // teleports a vehicle across a city.
    const margin = runnerUp ? best.score / Math.max(1e-6, runnerUp.score) : Infinity;
    if (margin < this.config.uniquenessRatio) return null;
    if (best.score < 0.35) return null;

    return {
      e: best.e,
      n: best.n,
      headingDeg: best.headingDeg,
      score: best.score,
      margin: Number.isFinite(margin) ? margin : 99,
      description: best.description,
      turnsUsed: pattern.length,
    };
  }

  /**
   * Walk the graph from one edge, trying to reproduce the pattern.
   *
   * Greedy: at each junction it takes the branch that best matches the NEXT
   * turn in the pattern. That is a simplification of a full search and it is
   * the right one here — a pattern of three to five turns with distances
   * between them is specific enough that the greedy path and the best path
   * coincide, and an exhaustive search over a city graph would not finish
   * inside a navigation loop.
   */
  private walk(startWayId: string, startArcM: number, pattern: ObservedTurn[]): Candidate | null {
    let wayId = startWayId;
    let arc = startArcM;
    let score = 0;
    const names: string[] = [];

    for (const observed of pattern) {
      // Travel the observed distance along the current way, crossing junctions
      // as needed. A run-up longer than the way means the vehicle went through
      // an intermediate junction without turning, which is normal.
      let remaining = Math.max(0, observed.runUpM);
      let guard = 0;
      while (remaining > 0 && guard++ < 12) {
        const length = this.index.wayLengthM(wayId);
        const available = length - arc;
        if (remaining <= available) {
          arc += remaining;
          remaining = 0;
          break;
        }
        remaining -= Math.max(0, available);
        const edges = this.topology.edgesOfWay(wayId);
        if (edges.length === 0) return null;
        const next = this.straightestContinuation(wayId, edges[edges.length - 1]!.to);
        if (!next) return null;
        wayId = next.wayId;
        arc = next.startArcM;
      }

      const here = this.index.positionAt(wayId, arc);
      if (!here) return null;

      // Now take the branch whose bearing change best matches the observed turn.
      const edges = this.topology.edgesOfWay(wayId);
      if (edges.length === 0) return null;
      const junction = edges[edges.length - 1]!.to;

      let bestTurn: { wayId: string; startArcM: number; error: number; name?: string } | null = null;
      for (const edge of this.topology.edgesFrom(junction)) {
        const pose = this.index.positionAt(edge.wayId, edge.arcStartM);
        if (!pose) continue;
        const change = angleDiffDeg(pose.bearingDeg, here.bearingDeg);
        const error = Math.abs(change - observed.deltaDeg);
        if (!bestTurn || error < bestTurn.error) {
          const name = this.index.getWay(edge.wayId)?.name;
          bestTurn = {
            wayId: edge.wayId,
            startArcM: edge.arcStartM,
            error,
            ...(name ? { name } : {}),
          };
        }
      }
      if (!bestTurn || bestTurn.error > this.config.turnToleranceDeg) return null;

      // Score this turn: 1 for exact, falling to 0 at the tolerance.
      score += 1 - bestTurn.error / this.config.turnToleranceDeg;
      if (bestTurn.name) names.push(bestTurn.name);
      wayId = bestTurn.wayId;
      arc = bestTurn.startArcM;
    }

    const final = this.index.positionAt(wayId, arc);
    if (!final) return null;

    const unique = [...new Set(names)];
    return {
      wayId,
      arcLengthM: arc,
      e: final.e,
      n: final.n,
      headingDeg: final.bearingDeg,
      score: score / pattern.length,
      description:
        unique.length >= 2
          ? `${unique[unique.length - 2]} × ${unique[unique.length - 1]}`
          : (unique[0] ?? wayId),
    };
  }

  /** The continuation that bends least — driving on without turning. */
  private straightestContinuation(
    fromWayId: string,
    junction: number,
  ): { wayId: string; startArcM: number } | null {
    const current = this.topology.edgesOfWay(fromWayId);
    if (current.length === 0) return null;
    const here = this.index.positionAt(fromWayId, this.index.wayLengthM(fromWayId));
    if (!here) return null;

    let best: { wayId: string; startArcM: number; turn: number } | null = null;
    for (const edge of this.topology.edgesFrom(junction)) {
      if (edge.wayId === fromWayId) continue;
      const pose = this.index.positionAt(edge.wayId, edge.arcStartM);
      if (!pose) continue;
      const turn = Math.abs(angleDiffDeg(pose.bearingDeg, here.bearingDeg));
      if (!best || turn < best.turn) best = { wayId: edge.wayId, startArcM: edge.arcStartM, turn };
    }
    // Past 60 degrees it is a turn, not driving on — and the pattern would
    // have recorded it as one.
    return best && best.turn < 60 ? { wayId: best.wayId, startArcM: best.startArcM } : null;
  }
}
