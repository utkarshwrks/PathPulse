/**
 * Drift as a percentage of distance travelled — the problem statement's metric.
 *
 * ★ A RATIO NEEDS A DENOMINATOR ★
 *
 * PS 26168 asks for positional drift as a percentage of distance travelled, and
 * over a real outage — hundreds of metres — that is exactly the right number.
 * Near zero distance it is not a number at all.
 *
 * Both call sites used to guard with `Math.max(1, distance)`, which does not
 * prevent the problem, it disguises it: 2.6 m of drift over one metre of travel
 * renders as 260 %, and the event log printed the memorable
 * "2.6m over 0m (255.72%)" — a percentage of zero. Measured on a handset
 * sitting still on a desk, the HUD read 1067.9 %, then 228 %, then 236 %. The
 * estimator was behaving correctly the whole time. The metric was being asked a
 * question it cannot answer, and answering anyway.
 *
 * So below the floor there is no percentage. The caller shows metres, which is
 * the honest quantity at that scale, and the panel stops looking like a system
 * failing catastrophically while parked.
 */

/**
 * Shortest distance over which a drift ratio means anything, in metres.
 *
 * 25 m is about a car length times five: long enough that GNSS noise on both
 * endpoints is small against it, short enough that a genuinely brief outage
 * still reports one. Anything under this is dominated by the noise in the
 * denominator, not by drift.
 */
export const MIN_RATIO_DISTANCE_M = 25;

/**
 * Drift as a percentage, or null when the distance is too short to divide by.
 *
 * Null is deliberate: it forces every caller to decide what to render instead,
 * rather than letting a silently substituted 0 read as "no drift" — which is
 * the opposite of "not measurable", and the more flattering of the two.
 */
export function driftRatioPct(driftM: number, distanceM: number): number | null {
  if (!Number.isFinite(driftM) || !Number.isFinite(distanceM)) return null;
  if (distanceM < MIN_RATIO_DISTANCE_M) return null;
  return (driftM / distanceM) * 100;
}

/** One human-readable line for a measured drift, ratio included only if it exists. */
export function formatDrift(driftM: number, distanceM: number): string {
  const pct = driftRatioPct(driftM, distanceM);
  const head = `${driftM.toFixed(1)}m over ${distanceM.toFixed(0)}m`;
  return pct === null ? `${head} (too short to rate)` : `${head} (${pct.toFixed(2)}%)`;
}
