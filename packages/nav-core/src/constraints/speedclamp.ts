export interface SpeedClampConfig {
  /** Absolute plausible ceiling, m/s. 40 m/s = 144 km/h. */
  maxSpeedMps: number;
  /** Multiplier applied to a matched road's maxspeed tag before clamping. */
  roadSpeedTolerance: number;
  /** Fallback ceiling when a matched road has no maxspeed tag, m/s. */
  defaultRoadSpeedMps: number;
  /**
   * How long an accelerometer-only speed estimate stays trustworthy, ms.
   *
   * Unaided consumer MEMS integration is good for tens of seconds, not
   * minutes. Past this the estimate is decayed toward zero rather than held.
   */
  integrationTrustMs: number;
  /** Time constant of that decay once trust has run out, ms. */
  decayTimeConstantMs: number;
}

export const DEFAULT_SPEED_CLAMP_CONFIG: SpeedClampConfig = {
  maxSpeedMps: 40,
  roadSpeedTolerance: 1.3,
  defaultRoadSpeedMps: 22.2, // 80 km/h
  integrationTrustMs: 45_000,
  decayTimeConstantMs: 60_000,
};

/**
 * Bound the speed estimate by what is physically and legally plausible.
 *
 * The road-tag part is the cheap half. The important half is the coasting
 * decay below.
 *
 * ★ WHY THE DECAY EXISTS ★
 *
 * With no GNSS and no odometry, speed can only come from integrating
 * acceleration. A stationary phone reads roughly zero acceleration — but so
 * does a car cruising at a constant 50 km/h. The two are genuinely
 * indistinguishable to an accelerometer, which is a real limitation of
 * inertial navigation and not something clever code can wish away.
 *
 * Holding the last speed forever resolves that ambiguity in the worst possible
 * direction. Our field test held 25.8 km/h for 197 seconds and manufactured
 * 4 km of travel that never happened, with the confidence bar still reading
 * 34%. A wrong answer delivered confidently is worse than an uncertain one.
 *
 * So after `integrationTrustMs` we bleed the speed off exponentially. A real
 * vehicle still moving will be re-anchored by the next GNSS fix, a ZUPT, or a
 * road match. A stationary phone comes to rest, which is the correct answer.
 * The confidence figure falls alongside it, so the UI stops claiming certainty
 * it does not have.
 */
export function clampSpeed(
  speedMps: number,
  config: SpeedClampConfig = DEFAULT_SPEED_CLAMP_CONFIG,
  roadMaxSpeedMps?: number,
): number {
  if (!Number.isFinite(speedMps)) return 0;
  let ceiling = config.maxSpeedMps;
  if (roadMaxSpeedMps !== undefined && Number.isFinite(roadMaxSpeedMps)) {
    ceiling = Math.min(ceiling, roadMaxSpeedMps * config.roadSpeedTolerance);
  }
  return Math.max(0, Math.min(ceiling, speedMps));
}

/**
 * Decay factor to apply to an integration-only speed estimate this step.
 *
 * @param unaidedMs how long we have been running without GNSS, odometry or ZUPT
 * @param dtMs      this step's duration
 * @returns a multiplier in (0, 1]; exactly 1 while still inside the trust window
 */
export function coastingDecay(
  unaidedMs: number,
  dtMs: number,
  config: SpeedClampConfig = DEFAULT_SPEED_CLAMP_CONFIG,
): number {
  if (!Number.isFinite(unaidedMs) || !Number.isFinite(dtMs) || dtMs <= 0) return 1;
  if (unaidedMs <= config.integrationTrustMs) return 1;
  return Math.exp(-dtMs / config.decayTimeConstantMs);
}
