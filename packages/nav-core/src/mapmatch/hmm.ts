/**
 * Phase 14 — Newson-Krumm HMM map matching.
 *
 * Reference: Paul Newson and John Krumm, "Hidden Markov Map Matching Through
 * Noise and Sparseness", ACM SIGSPATIAL 2009.
 *
 * ★ WHAT THIS FIXES THAT NEAREST-ROAD SNAPPING CANNOT ★
 *
 * Phase 6D's matcher answers, for each position independently, "which road is
 * closest, pointing roughly the right way, and preferably the one I matched
 * last time?" That is a good heuristic and it has one structural blind spot:
 * it has no way to express that a road is CLOSE BUT UNREACHABLE.
 *
 * A service road running twenty metres from a trunk road is twenty metres
 * away. So is the opposite carriageway of a dual carriageway. So is the road
 * underneath a flyover. In every one of those cases the nearest-road answer is
 * geometrically correct and navigationally absurd — the vehicle would have had
 * to drive a kilometre to the next junction and back to be there.
 *
 * An HMM says that out loud. Each position gets a set of candidate road
 * positions (the hidden states). The EMISSION probability says how well a
 * candidate explains the observation — near is likely, far is not. The
 * TRANSITION probability says how plausible it is to have moved from one
 * candidate to the next — and it is computed as the disagreement between the
 * ROUTE distance and the straight-line distance, which is precisely the
 * quantity that makes a parallel carriageway implausible. Viterbi then picks
 * the most likely SEQUENCE, not the most likely point.
 *
 * ★ WHY A SLIDING WINDOW ★
 * Viterbi over a whole drive needs the whole drive, and this runs at 10 Hz on
 * a phone while the vehicle is still moving. The window is the last N
 * observations: long enough that a decision is made with several seconds of
 * context, short enough to be recomputed every observation without noticing.
 * The answer for the OLDEST observation in the window is settled; the newest
 * is provisional and may change as evidence arrives, which is correct — that
 * uncertainty is real.
 */
import type { RoadIndex } from './RoadIndex.js';
import type { RoadPosition } from './types.js';
import { angleDiffDeg } from './RoadIndex.js';
import type { RoadTopology } from './RoadTopology.js';

export interface HmmConfig {
  /**
   * Standard deviation of the position observation, metres.
   *
   * Newson-Krumm fit 4.07 m to their GPS traces. Ours is not a raw fix: during
   * an outage it is a dead-reckoned estimate whose uncertainty the engine
   * already computes, so the caller passes it per observation and this is only
   * the floor.
   */
  minSigmaM: number;
  /**
   * The transition parameter, metres. Newson-Krumm's beta.
   *
   * It scales how much route-versus-straight-line disagreement is tolerated
   * before a transition is called implausible. Their fitted value is 0.0
   * for 1-second sampling rising with the interval; 30 m is the usual choice
   * for dense sampling and is what a 10 Hz stream is.
   */
  betaM: number;
  /** Candidates considered per observation. */
  maxCandidates: number;
  /** How far to look for candidates, metres. */
  searchRadiusM: number;
  /** Observations kept in the Viterbi window. */
  windowSize: number;
  /**
   * Minimum travel between accepted observations, metres.
   *
   * ★ THE TRANSITION TERM NEEDS DISTANCE TO SAY ANYTHING ★
   *
   * Newson-Krumm was written for GPS traces sampled every second or worse, and
   * that is not incidental — the whole discriminating power of the transition
   * probability is the disagreement between route distance and straight-line
   * distance. At 50 Hz, consecutive positions are three centimetres apart, the
   * route between any two nearby candidates is also about three centimetres,
   * and the term is uniform: every transition is equally plausible and the
   * model degenerates into per-position nearest-road with extra steps.
   *
   * Measured: fed every sample, the matcher scored 9.9 % drift against the
   * greedy matcher's 9.2 %. It was not reasoning about sequences at all.
   *
   * Ten metres makes a thirty-observation window cover three hundred metres,
   * which is the scale at which "you would have had to drive to the next
   * junction and back" is a statement with content. Between accepted
   * observations the previous match is held, so the engine still gets an
   * answer on every sample.
   *
   * ★ AND THE SWEEP IS FLAT, WHICH IS ITSELF THE FINDING ★
   * Measured over the committed logs at 3, 5, 10, 20 and 40 m, mean drift
   * moves between 10.4 % and 11.2 % — no trend. A parameter that controls how
   * much sequence evidence the model gets, and that changes nothing, is
   * telling you the routes contain no geometry the transition term can
   * discriminate. See docs/benchmarks.md.
   */
  minTravelM: number;
  /**
   * Penalty applied to a candidate whose bearing disagrees with the direction
   * of travel, as a log-probability at full opposition.
   *
   * Not in the original paper, which matches sparse GPS traces with no
   * reliable heading. We have a gyro-integrated heading that is good to a few
   * degrees over a minute, and refusing to use it would be throwing away the
   * one signal that separates the two carriageways of a dual carriageway when
   * they are genuinely connected at both ends.
   */
  headingPenalty: number;
  /**
   * Metres of altitude disagreement that count as "a different level".
   *
   * ★ FLYOVERS ★ The road on a flyover and the road beneath it are the same
   * point on a map and five metres apart in the air. When the caller supplies
   * a barometric altitude and the graph knows a way's layer, this separates
   * them; with no barometer it is inert, which is the common case and is why
   * nothing else depends on it.
   */
  layerSeparationM: number;
}

export const DEFAULT_HMM_CONFIG: HmmConfig = {
  minSigmaM: 4.07,
  betaM: 30,
  maxCandidates: 6,
  searchRadiusM: 60,
  windowSize: 30,
  minTravelM: 10,
  headingPenalty: 4,
  layerSeparationM: 4,
};

/** One observed position, with everything the model needs to score it. */
export interface HmmObservation {
  t: number;
  e: number;
  n: number;
  /** Direction of travel, degrees clockwise from north. */
  headingDeg: number;
  /** 1-sigma position uncertainty, metres. */
  sigmaM: number;
  /** Metres travelled since the previous observation, from the estimator. */
  travelledM: number;
  /** Barometric or estimated altitude, metres. Optional. */
  altitudeM?: number;
}

interface Candidate extends RoadPosition {
  /** log P(observation | this candidate). */
  emission: number;
}

interface TrellisNode {
  candidate: Candidate;
  /** Best log-probability of any path ending here. */
  score: number;
  /** Index into the previous column. */
  from: number;
}

export interface HmmMatch extends RoadPosition {
  /** Log-probability of the winning path, for diagnostics. */
  score: number;
  /** How many observations of context produced it. */
  windowUsed: number;
}

const NEG_INF = -1e9;

/**
 * Newson-Krumm emission: a Gaussian on the perpendicular distance.
 *
 * Written as a log-probability throughout. Multiplying twenty small
 * probabilities across a window underflows float64 to exactly zero, at which
 * point every path scores the same and Viterbi returns whichever it saw first
 * — a bug that looks like the matcher having no opinion.
 */
function logEmission(distanceM: number, sigmaM: number): number {
  const s = Math.max(0.5, sigmaM);
  return -0.5 * (distanceM / s) ** 2 - Math.log(s);
}

/**
 * Newson-Krumm transition: an exponential on |route - straight line|.
 *
 * The paper's insight in one line. Two consecutive positions ten metres apart
 * are ten metres apart on the road if the vehicle stayed on it; if the second
 * candidate is on the opposite carriageway, the route between them is a
 * kilometre and the difference is enormous. Unreachable candidates — no route
 * at all inside the bound — get the floor, which is what removes flyovers and
 * parallel service roads.
 */
function logTransition(routeM: number | null, straightM: number, betaM: number): number {
  if (routeM === null) return NEG_INF;
  const beta = Math.max(1, betaM);
  return -Math.abs(routeM - straightM) / beta - Math.log(beta);
}

export class HmmMapMatcher {
  private readonly config: HmmConfig;
  private readonly window: HmmObservation[] = [];
  private lastWayId: string | null = null;
  private lastMatch: HmmMatch | null = null;
  private pendingTravelM = 0;

  constructor(
    private readonly index: RoadIndex,
    private readonly topology: RoadTopology,
    config: Partial<HmmConfig> = {},
  ) {
    this.config = { ...DEFAULT_HMM_CONFIG, ...config };
  }

  get matchedWayId(): string | null {
    return this.lastWayId;
  }

  reset(): void {
    this.window.length = 0;
    this.lastWayId = null;
    this.lastMatch = null;
    this.pendingTravelM = 0;
  }

  /**
   * Add an observation and return the best match, or null.
   *
   * Observations closer together than `minTravelM` are accumulated rather than
   * matched: the answer they would produce carries no sequence information —
   * see that setting — and the previous match is returned instead, which is
   * what the engine wants anyway.
   */
  push(observation: HmmObservation): HmmMatch | null {
    if (!Number.isFinite(observation.e) || !Number.isFinite(observation.n)) return null;

    this.pendingTravelM += Number.isFinite(observation.travelledM) ? observation.travelledM : 0;
    if (this.window.length > 0 && this.pendingTravelM < this.config.minTravelM) {
      // ★ HOLD THE ROAD, NOT THE POINT ★
      //
      // Returning the previous match verbatim returns a position up to
      // `minTravelM` behind the vehicle, and the engine then snaps toward it —
      // pulling the marker backwards down the road it is driving up. Measured,
      // that alone took drift from 9.9 % to 16.0 %.
      //
      // The HMM's answer is WHICH ROAD. Where on it the vehicle is right now
      // is a projection, and a projection is cheap and should be current.
      return this.reprojectOnto(this.lastMatch, observation);
    }

    this.window.push({ ...observation, travelledM: this.pendingTravelM });
    this.pendingTravelM = 0;
    if (this.window.length > this.config.windowSize) this.window.shift();

    const columns = this.window.map((o) => this.candidatesFor(o));
    // An observation with no road anywhere near it is not a gap in the
    // trellis, it is the end of one: keeping it would force every path through
    // a column with no states.
    if (columns[columns.length - 1]!.length === 0) return null;

    const match = this.viterbi(columns);
    if (match) {
      this.lastWayId = match.wayId;
      this.lastMatch = match;
    }
    return match;
  }

  /**
   * The held match, re-projected onto the same way at the current position.
   *
   * Returns null rather than a stale answer if the way has somehow gone —
   * a wrong position confidently asserted is worse than no position.
   */
  private reprojectOnto(match: HmmMatch | null, o: HmmObservation): HmmMatch | null {
    if (!match) return null;

    let best: { e: number; n: number; arc: number; d: number; bearing: number } | null = null;
    for (const seg of this.index.nearbySegments(o.e, o.n, this.config.searchRadiusM)) {
      if (seg.wayId !== match.wayId) continue;
      const dx = seg.e2 - seg.e1;
      const dy = seg.n2 - seg.n1;
      const lenSq = dx * dx + dy * dy;
      const t =
        lenSq > 0 ? Math.max(0, Math.min(1, ((o.e - seg.e1) * dx + (o.n - seg.n1) * dy) / lenSq)) : 0;
      const pe = seg.e1 + dx * t;
      const pn = seg.n1 + dy * t;
      const d = Math.hypot(o.e - pe, o.n - pn);
      if (!best || d < best.d) {
        best = { e: pe, n: pn, arc: seg.arcStartM + t * seg.lengthM, d, bearing: seg.bearingDeg };
      }
    }
    if (!best) return null;

    return {
      ...match,
      arcLengthM: best.arc,
      enu: { e: best.e, n: best.n },
      distanceM: best.d,
      bearingDeg: best.bearing,
    };
  }

  private candidatesFor(o: HmmObservation): Candidate[] {
    const segments = this.index.nearbySegments(o.e, o.n, this.config.searchRadiusM);
    const out: Candidate[] = [];

    for (const seg of segments) {
      const dx = seg.e2 - seg.e1;
      const dy = seg.n2 - seg.n1;
      const lenSq = dx * dx + dy * dy;
      const t =
        lenSq > 0 ? Math.max(0, Math.min(1, ((o.e - seg.e1) * dx + (o.n - seg.n1) * dy) / lenSq)) : 0;
      const pe = seg.e1 + dx * t;
      const pn = seg.n1 + dy * t;
      const distanceM = Math.hypot(o.e - pe, o.n - pn);
      if (distanceM > this.config.searchRadiusM) continue;

      const way = this.index.getWay(seg.wayId);
      const oneway = way?.oneway === true;
      const raw = Math.abs(angleDiffDeg(o.headingDeg, seg.bearingDeg));
      const mismatch = oneway ? raw : Math.min(raw, 180 - raw);

      let emission = logEmission(distanceM, Math.max(this.config.minSigmaM, o.sigmaM));
      emission -= this.config.headingPenalty * (mismatch / 180);

      // ★ FLYOVERS ★ Inert unless the caller has an altitude AND the graph
      // knows the way's layer. Both are usually absent, and a rule that fires
      // on absent data is a rule that invents evidence.
      if (o.altitudeM !== undefined && way?.layerM !== undefined) {
        const dz = Math.abs(o.altitudeM - way.layerM);
        if (dz > this.config.layerSeparationM) emission -= dz / this.config.layerSeparationM;
      }

      out.push({
        wayId: seg.wayId,
        name: way?.name,
        maxspeedKph: way?.maxspeed,
        arcLengthM: seg.arcStartM + t * seg.lengthM,
        enu: { e: pe, n: pn },
        distanceM,
        bearingDeg: seg.bearingDeg,
        emission,
      });
    }

    // Keep the best few. A trellis column with forty candidates costs forty
    // times as many route queries as one with six, and the fortieth candidate
    // is a road the vehicle is demonstrably not on.
    out.sort((a, b) => b.emission - a.emission);
    return out.slice(0, this.config.maxCandidates);
  }

  private viterbi(columns: Candidate[][]): HmmMatch | null {
    const usable = columns.filter((c) => c.length > 0);
    if (usable.length === 0) return null;

    let previous: TrellisNode[] = usable[0]!.map((c) => ({
      candidate: c,
      score: c.emission,
      from: -1,
    }));
    const backpointers: TrellisNode[][] = [previous];

    for (let step = 1; step < usable.length; step++) {
      const observationIndex = columns.indexOf(usable[step]!);
      const previousIndex = columns.indexOf(usable[step - 1]!);
      const straightM = this.straightLineM(previousIndex, observationIndex);

      const column: TrellisNode[] = usable[step]!.map((candidate) => {
        let best = NEG_INF;
        let from = -1;
        for (let i = 0; i < previous.length; i++) {
          const prev = previous[i]!;
          if (prev.score <= NEG_INF) continue;
          const routeM = this.topology.routeDistanceM(
            { wayId: prev.candidate.wayId, arcLengthM: prev.candidate.arcLengthM },
            { wayId: candidate.wayId, arcLengthM: candidate.arcLengthM },
          );
          const score = prev.score + logTransition(routeM, straightM, this.config.betaM);
          if (score > best) {
            best = score;
            from = i;
          }
        }
        return { candidate, score: best + candidate.emission, from };
      });

      // ★ EVERY PATH DIED ★ It happens: a vehicle leaves the graph's coverage,
      // or turns onto a way the extract does not contain. Restarting the
      // trellis from the emissions alone is the honest response — the sequence
      // evidence is genuinely gone, and carrying -1e9 forward would make the
      // rest of the window meaningless.
      if (column.every((node) => node.score <= NEG_INF / 2)) {
        previous = usable[step]!.map((c) => ({ candidate: c, score: c.emission, from: -1 }));
      } else {
        previous = column;
      }
      backpointers.push(previous);
    }

    let bestIndex = 0;
    for (let i = 1; i < previous.length; i++) {
      if (previous[i]!.score > previous[bestIndex]!.score) bestIndex = i;
    }
    const winner = previous[bestIndex];
    if (!winner) return null;

    const { emission: _e, ...position } = winner.candidate;
    return { ...position, score: winner.score, windowUsed: usable.length };
  }

  /**
   * Straight-line distance between two observations.
   *
   * Taken from the ESTIMATOR'S OWN travelled distance where possible rather
   * than from the coordinates, because during an outage the coordinates are
   * the thing being corrected — using them would compare the map against a
   * position the map is supposed to be judging.
   */
  private straightLineM(fromIndex: number, toIndex: number): number {
    let travelled = 0;
    for (let i = fromIndex + 1; i <= toIndex; i++) {
      const step = this.window[i]?.travelledM;
      travelled += Number.isFinite(step) ? (step as number) : 0;
    }
    if (travelled > 0) return travelled;

    const a = this.window[fromIndex];
    const b = this.window[toIndex];
    if (!a || !b) return 0;
    return Math.hypot(b.e - a.e, b.n - a.n);
  }
}
