import { haversineDistance } from '../geo/distance.js';

/**
 * GNSS anomaly detection — jamming, spoofing, and plain nonsense.
 *
 * ★ IT WARNS. IT NEVER ACTS. ★
 * Nothing here touches the estimate. It would be easy to start rejecting fixes
 * that look spoofed, and that is exactly the wrong trade: a false positive
 * would then stop the app navigating, on evidence that is circumstantial by
 * construction. A badge that is occasionally wrong costs a sentence of
 * explanation; an estimator that rejects good fixes costs the demo. So this
 * produces events and a display flag, and the ablation table is untouched by
 * its existence.
 *
 * ★ THE HARD PART IS NOT DETECTING, IT IS NOT CRYING WOLF ★
 * This app deliberately spends much of its time in GNSS outages, and the
 * obvious formulation of every check below fires on ordinary behaviour:
 *
 *  - "position jumped more than 50 m" fires on *every single* recovery from an
 *    outage, which is the app working correctly. Measured as implied *speed*
 *    over the gap instead, a 60 s outage covering 800 m is 13 m/s and
 *    unremarkable — which is the point.
 *  - "GNSS says stopped but the IMU is moving" fires at every traffic light
 *    where the phone is picked up, unless it demands sustained evidence and
 *    agrees with the stationarity detector.
 *  - "satellite count dropped" fires entering any tunnel. A tunnel drops
 *    carrier-to-noise with it; a jammer or a spoofer need not.
 *
 * The problem statement mentions jamming in its background but does not ask
 * for it, and ISRO sponsors the statement. This is bonus, so it has to be
 * right or absent — a false alarm during a demo is worse than no feature.
 */

export type GnssAnomalyKind = 'STATIC_HOLD' | 'IMPLAUSIBLE_JUMP' | 'CONSTELLATION';

export interface GnssAnomaly {
  t: number;
  kind: GnssAnomalyKind;
  /** Ready to print. Always carries the number that triggered it. */
  message: string;
}

export interface SpoofingConfig {
  /** GNSS speed at or below this reads as "the receiver claims stationary". */
  staticSpeedMps: number;
  /** Dead-reckoned speed above this reads as "the IMU says we are moving". */
  movingSpeedMps: number;
  /**
   * How long the two must disagree before it is reported, ms.
   *
   * A single sample of disagreement is normal — Doppler speed lags, and a fix
   * arrives every few seconds on real hardware. Sustained disagreement is not.
   */
  staticSustainMs: number;
  /**
   * Implied speed between two consecutive fixes above which the jump is
   * impossible rather than merely fast, m/s. 55 m/s is just under 200 km/h.
   */
  maxImpliedSpeedMps: number;
  /**
   * Shortest fix gap the jump check will consider, ms.
   *
   * Two fixes 100 ms apart with a few metres of ordinary scatter between them
   * imply tens of m/s. Below this the arithmetic measures noise, not motion.
   */
  minJumpDtMs: number;
  /**
   * The jump must also exceed this multiple of the two fixes' combined
   * reported accuracy, so a pair of 50 m fixes cannot trip it by disagreeing
   * with each other by 50 m.
   */
  jumpAccuracyMargin: number;
  /** Satellite count falling to this fraction of its recent level or below. */
  satDropFraction: number;
  /**
   * Carrier-to-noise still at or above this while satellites vanish, dB-Hz.
   * Losing signal genuinely takes C/N0 down with it.
   */
  healthyCn0Db: number;
  /** How long an anomaly stays displayed after its last trigger, ms. */
  holdMs: number;
}

export const DEFAULT_SPOOFING_CONFIG: SpoofingConfig = {
  staticSpeedMps: 0.5,
  movingSpeedMps: 4,
  staticSustainMs: 6000,
  maxImpliedSpeedMps: 55,
  minJumpDtMs: 500,
  jumpAccuracyMargin: 3,
  satDropFraction: 0.5,
  healthyCn0Db: 35,
  holdMs: 8000,
};

export interface SpoofingInput {
  t: number;
  gnss?: {
    lat: number;
    lon: number;
    accuracyM: number;
    speedMps?: number;
    satCount?: number;
    meanCn0?: number;
  };
  /** Speed the IMU believes, m/s. */
  drSpeedMps: number;
  /** The stationarity detector's verdict, used to veto the static check. */
  stationary: boolean;
}

interface LastFix {
  t: number;
  lat: number;
  lon: number;
  accuracyM: number;
  satCount?: number;
}

export class SpoofingDetector {
  private readonly config: SpoofingConfig;
  private lastFix: LastFix | null = null;
  /** When GNSS and the IMU first started disagreeing about being stopped. */
  private staticSince: number | null = null;
  private active: GnssAnomaly | null = null;
  private activeUntil = 0;
  private counts: Record<GnssAnomalyKind, number> = {
    STATIC_HOLD: 0,
    IMPLAUSIBLE_JUMP: 0,
    CONSTELLATION: 0,
  };
  /** Slow mean of satellite count, for spotting a collapse against it. */
  private satBaseline: number | null = null;
  /** When each kind was last reported, so a persistent fault reports once. */
  private lastReportedAt: Partial<Record<GnssAnomalyKind, number>> = {};

  constructor(config: Partial<SpoofingConfig> = {}) {
    this.config = { ...DEFAULT_SPOOFING_CONFIG, ...config };
  }

  /** The anomaly currently being displayed, or null. */
  get current(): GnssAnomaly | null {
    return this.active;
  }

  get totals(): Readonly<Record<GnssAnomalyKind, number>> {
    return this.counts;
  }

  /**
   * Feed one sample. Returns a new anomaly on the sample it is first detected,
   * and null otherwise — including while an earlier anomaly is still displayed.
   */
  update(input: SpoofingInput): GnssAnomaly | null {
    const { t } = input;
    if (!Number.isFinite(t)) return null;

    if (this.active && t >= this.activeUntil) this.active = null;

    // ★ RUN ALL THREE, THEN CHOOSE ★
    // Chaining these with `??` short-circuits, and each check maintains state
    // it needs across samples — the constellation check owns the satellite
    // baseline, the static check owns its disagreement clock. Skipping a check
    // because an earlier one fired leaves that state frozen, so a run of jumps
    // would have the constellation check judging against a baseline from
    // minutes ago. Side effects and control flow do not mix.
    const staticHold = this.checkStaticHold(input);
    const jump = this.checkJump(input);
    const constellation = this.checkConstellation(input);
    const found = staticHold ?? jump ?? constellation;

    if (input.gnss && Number.isFinite(input.gnss.lat) && Number.isFinite(input.gnss.lon)) {
      this.lastFix = {
        t,
        lat: input.gnss.lat,
        lon: input.gnss.lon,
        accuracyM: input.gnss.accuracyM,
        ...(input.gnss.satCount !== undefined ? { satCount: input.gnss.satCount } : {}),
      };
    }

    if (!found) return null;

    // ★ A JAMMER DOES NOT JAM FOR ONE SAMPLE ★
    // Reporting every sample a condition holds floods the event log — which is
    // bounded at 200 entries and is one of the anti-fake features, the thing a
    // judge is invited to export and read. Sixty seconds of jamming emitted 35
    // identical lines and evicted the outage history behind them: the log
    // showed nothing but the same sentence, and the run it was meant to
    // document was gone. Each KIND reports at most once per hold window;
    // a different kind is always allowed through, because suppressing that
    // would hide the second half of an attack.
    const previous = this.lastReportedAt[found.kind];
    if (previous !== undefined && t - previous < this.config.holdMs) return null;
    this.lastReportedAt[found.kind] = t;

    this.counts[found.kind]++;
    this.active = found;
    this.activeUntil = t + this.config.holdMs;
    return found;
  }

  /**
   * The receiver insists it is stationary while the IMU disagrees.
   *
   * This is the signature of a spoofer holding a target in place, and also of
   * a receiver that has simply stopped updating. Either is worth saying out
   * loud; neither is worth acting on automatically.
   */
  private checkStaticHold(input: SpoofingInput): GnssAnomaly | null {
    const { t, gnss, drSpeedMps, stationary } = input;
    if (!gnss) return null;

    // The IMU has to be confident we are moving. `stationary` is the same
    // detector that drives ZUPT, so this can never contradict the constraint
    // that is simultaneously zeroing our speed.
    const imuMoving = !stationary && drSpeedMps > this.config.movingSpeedMps;
    if (!imuMoving) {
      this.staticSince = null;
      return null;
    }

    // Prefer the receiver's own Doppler speed. Android often omits it, so fall
    // back to what consecutive fixes imply — a spoofer holding position gives
    // identical fixes, which derives to zero just the same.
    let gnssSpeed = gnss.speedMps;
    if (gnssSpeed === undefined || !Number.isFinite(gnssSpeed)) {
      if (!this.lastFix) return null;
      const dtS = (t - this.lastFix.t) / 1000;
      if (dtS <= 0) return null;
      gnssSpeed =
        haversineDistance(this.lastFix.lat, this.lastFix.lon, gnss.lat, gnss.lon) / dtS;
    }

    if (gnssSpeed > this.config.staticSpeedMps) {
      this.staticSince = null;
      return null;
    }

    if (this.staticSince === null) {
      this.staticSince = t;
      return null;
    }
    if (t - this.staticSince < this.config.staticSustainMs) return null;

    this.staticSince = null;
    return {
      t,
      kind: 'STATIC_HOLD',
      message: `GNSS reports ${gnssSpeed.toFixed(1)} m/s while inertial says ${drSpeedMps.toFixed(1)} m/s`,
    };
  }

  /**
   * Two consecutive fixes that imply a speed no vehicle reaches.
   *
   * Measured as speed, not distance, precisely so that returning from a long
   * outage — the thing this app does constantly — is not an anomaly.
   */
  private checkJump(input: SpoofingInput): GnssAnomaly | null {
    const { t, gnss } = input;
    if (!gnss || !this.lastFix) return null;
    if (!Number.isFinite(gnss.lat) || !Number.isFinite(gnss.lon)) return null;

    const dtMs = t - this.lastFix.t;
    if (dtMs < this.config.minJumpDtMs) return null;

    const distanceM = haversineDistance(this.lastFix.lat, this.lastFix.lon, gnss.lat, gnss.lon);
    const impliedSpeed = distanceM / (dtMs / 1000);
    if (impliedSpeed <= this.config.maxImpliedSpeedMps) return null;

    // Two poor fixes disagreeing with each other is not a teleport. Require
    // the jump to be large relative to what they themselves claim to be worth.
    const combinedAccuracy =
      (Number.isFinite(this.lastFix.accuracyM) ? this.lastFix.accuracyM : 0) +
      (Number.isFinite(gnss.accuracyM) ? gnss.accuracyM : 0);
    if (distanceM < combinedAccuracy * this.config.jumpAccuracyMargin) return null;

    return {
      t,
      kind: 'IMPLAUSIBLE_JUMP',
      message: `fix moved ${distanceM.toFixed(0)}m in ${(dtMs / 1000).toFixed(1)}s — ${impliedSpeed.toFixed(0)} m/s`,
    };
  }

  /**
   * Satellites vanishing while carrier-to-noise stays healthy.
   *
   * Going into a tunnel takes both down together. Losing most of the
   * constellation while the remaining signal still looks strong is the
   * combination that does not occur naturally.
   *
   * ★ Needs `satCount` and `meanCn0`, which the Capacitor/WebView stack does
   * not expose — see KNOWN ISSUES. Today this fires only in simulation and
   * replay; the native `GnssStatus` loop in Phase 15 is what makes it real on
   * a phone. Shipped anyway because the logic is testable now and the wiring
   * is the part Phase 15 would otherwise have to invent.
   */
  private checkConstellation(input: SpoofingInput): GnssAnomaly | null {
    const { t, gnss } = input;
    if (!gnss) return null;
    const { satCount, meanCn0 } = gnss;
    if (satCount === undefined || meanCn0 === undefined) return null;
    if (!Number.isFinite(satCount) || !Number.isFinite(meanCn0)) return null;

    const baseline = this.satBaseline;
    // Track the baseline with a slow rise and no fall, so a genuine gradual
    // decline does not drag the reference down with it and hide the drop.
    this.satBaseline = baseline === null ? satCount : Math.max(baseline * 0.98, satCount);

    if (baseline === null || baseline < 4) return null;
    if (satCount > baseline * this.config.satDropFraction) return null;
    if (meanCn0 < this.config.healthyCn0Db) return null;

    return {
      t,
      kind: 'CONSTELLATION',
      message: `satellites ${baseline.toFixed(0)} → ${satCount} with C/N0 still ${meanCn0.toFixed(0)} dB-Hz`,
    };
  }

  reset(): void {
    this.lastFix = null;
    this.staticSince = null;
    this.active = null;
    this.activeUntil = 0;
    this.satBaseline = null;
    this.lastReportedAt = {};
    this.counts = { STATIC_HOLD: 0, IMPLAUSIBLE_JUMP: 0, CONSTELLATION: 0 };
  }
}
