import { normalizeAngle, normalizeAngle360 } from '../geo/angles.js';

/**
 * Turn detection from integrated yaw.
 *
 * ★ NOT FROM DEVICE Z — SEE FIELD DEFECT #1 ★
 * The build guide says "integrate the gyroscope z-axis". Taken literally that
 * is the exact bug the 2026-08-27 field test found: `gz` is yaw only when the
 * phone lies flat on its back, and a handset upright in a cradle reports roll
 * there instead. Every turn would be missed, or invented, depending on how the
 * phone was mounted. This consumes the yaw rate `AttitudeEstimator.yawRate()`
 * produces — the gyro vector projected onto measured gravity, compass sense,
 * clockwise positive — so it is correct in any orientation.
 *
 * The detector is a small state machine rather than a threshold on a single
 * sample. A turn is not an instant: it is a sustained rotation with a
 * beginning and an end, and only once it has ended is there a total angle to
 * classify. Reporting `RIGHT_90` the moment 40 degrees have accumulated would
 * label every U-turn a right turn.
 */

export type TurnKind =
  | 'SLIGHT_LEFT'
  | 'LEFT_90'
  | 'SLIGHT_RIGHT'
  | 'RIGHT_90'
  | 'U_TURN';

export interface TurnEvent {
  /** Timestamp the turn ended, ms. */
  t: number;
  /** Timestamp the turn started, ms. */
  startedAtMs: number;
  durationMs: number;
  kind: TurnKind;
  /** Signed total heading change, degrees. Positive is right (clockwise). */
  deltaDeg: number;
  /** Heading when the turn began and when it ended, degrees. */
  fromHeadingDeg: number;
  toHeadingDeg: number;
}

export interface TurnDetectorConfig {
  /**
   * Heading change within `windowMs` that opens a turn, degrees.
   * The guide's number: 40 degrees in 3 seconds.
   */
  triggerDeg: number;
  windowMs: number;
  /**
   * Yaw rate below which the vehicle is considered to be going straight again,
   * degrees per second. A turn ends when the rate stays under this for
   * `settleMs`.
   */
  straightDegPerSec: number;
  settleMs: number;
  /**
   * Total heading change below which a completed rotation is discarded rather
   * than reported, degrees. A lane change or a gentle bend is not a turn, and
   * a log full of 12-degree "turns" is a log nobody reads.
   */
  minReportDeg: number;
  /**
   * Speed below which rotation is ignored, m/s.
   *
   * ★ A PHONE TURNING IS NOT A VEHICLE TURNING ★
   * Picked up at a traffic light and rotated to read a message, the handset
   * sweeps through a clean 90 degrees. Without this gate that lands in the
   * event log as a right turn, at a junction, while stationary — visible
   * nonsense in the one artefact whose whole purpose is being checkable.
   */
  minSpeedMps: number;
  /** Longest a single turn may run before being force-closed, ms. */
  maxDurationMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnDetectorConfig = {
  triggerDeg: 40,
  windowMs: 3000,
  straightDegPerSec: 6,
  settleMs: 700,
  minReportDeg: 25,
  minSpeedMps: 1.5,
  maxDurationMs: 30_000,
};

/**
 * Classify a completed rotation by its total signed angle.
 *
 * The bands are deliberately wide. Real junctions are not 90.0 degrees — a
 * measured right turn lands anywhere from 70 to 110 depending on the road, and
 * naming the bucket `RIGHT_90` is a description of the manoeuvre, not a claim
 * about the number. The number is carried alongside in `deltaDeg` so nothing
 * is lost to the label.
 */
export function classifyTurn(deltaDeg: number, minReportDeg: number): TurnKind | null {
  if (!Number.isFinite(deltaDeg)) return null;
  const magnitude = Math.abs(deltaDeg);
  if (magnitude < minReportDeg) return null;
  const right = deltaDeg > 0;
  if (magnitude >= 135) return 'U_TURN';
  if (magnitude >= 60) return right ? 'RIGHT_90' : 'LEFT_90';
  return right ? 'SLIGHT_RIGHT' : 'SLIGHT_LEFT';
}

/** Human-readable label for the HUD: "RIGHT 87°". */
export function describeTurn(turn: TurnEvent): string {
  const magnitude = Math.round(Math.abs(turn.deltaDeg));
  if (turn.kind === 'U_TURN') return `U-TURN ${magnitude}°`;
  return `${turn.deltaDeg > 0 ? 'RIGHT' : 'LEFT'} ${magnitude}°`;
}

interface SweepSample {
  t: number;
  deltaDeg: number;
}

export class TurnDetector {
  private readonly config: TurnDetectorConfig;
  /**
   * Recent per-sample heading deltas, for the sliding trigger window.
   *
   * Named `sweep` rather than `window` on purpose: `pnpm lint:core-purity`
   * greps nav-core for browser globals by identifier, and a field called
   * `window` trips it. Golden Rule #1's guard is deliberately blunt, and
   * working around it with an exception would blunt it further.
   */
  private sweep: SweepSample[] = [];
  private turning = false;
  private turnStartedAtMs = 0;
  private turnStartHeadingDeg = 0;
  private turnTotalDeg = 0;
  private straightSinceMs: number | null = null;
  private lastTurn: TurnEvent | null = null;
  private turnCount = 0;

  constructor(config: Partial<TurnDetectorConfig> = {}) {
    this.config = { ...DEFAULT_TURN_CONFIG, ...config };
  }

  get current(): TurnEvent | null {
    return this.lastTurn;
  }

  get count(): number {
    return this.turnCount;
  }

  /** True while a turn is in progress, for the HUD's live indicator. */
  get isTurning(): boolean {
    return this.turning;
  }

  /**
   * Feed one sample. Returns a TurnEvent on the sample where a turn completes,
   * and null on every other sample.
   *
   * @param tMs              sample timestamp
   * @param yawRateRadPerSec compass-sense yaw rate about the true vertical
   * @param dtMs             interval since the previous sample
   * @param speedMps         current speed estimate, for the stationary gate
   * @param headingDeg       current heading, recorded on the event
   */
  update(
    tMs: number,
    yawRateRadPerSec: number,
    dtMs: number,
    speedMps: number,
    headingDeg: number,
  ): TurnEvent | null {
    if (!Number.isFinite(tMs) || !Number.isFinite(dtMs) || dtMs <= 0 || dtMs > 1000) {
      return null;
    }
    const rate = Number.isFinite(yawRateRadPerSec) ? yawRateRadPerSec : 0;
    const rateDegPerSec = (rate * 180) / Math.PI;
    const deltaDeg = (rateDegPerSec * dtMs) / 1000;
    const moving = Number.isFinite(speedMps) && speedMps >= this.config.minSpeedMps;

    // Stationary: not a vehicle turn. Abandon anything in progress rather than
    // letting a turn straddle a stop and accumulate the driver fidgeting.
    if (!moving) {
      this.sweep = [];
      this.turning = false;
      this.straightSinceMs = null;
      return null;
    }

    this.sweep.push({ t: tMs, deltaDeg });
    const cutoff = tMs - this.config.windowMs;
    while (this.sweep.length > 0 && this.sweep[0]!.t < cutoff) this.sweep.shift();

    if (!this.turning) {
      const swept = this.sweep.reduce((sum, s) => sum + s.deltaDeg, 0);
      if (Math.abs(swept) >= this.config.triggerDeg) {
        this.turning = true;
        this.turnStartedAtMs = this.sweep[0]!.t;
        // The turn began where the window began, so the heading it started
        // from is the current heading minus everything swept since.
        this.turnStartHeadingDeg = normalizeAngle(headingDeg - swept);
        this.turnTotalDeg = swept;
        this.straightSinceMs = null;
      }
      return null;
    }

    this.turnTotalDeg += deltaDeg;

    // A turn ends when the vehicle has been going straight for long enough,
    // not the instant the rate dips — real steering wobbles through a bend and
    // a single quiet sample would split one turn into two.
    if (Math.abs(rateDegPerSec) < this.config.straightDegPerSec) {
      if (this.straightSinceMs === null) this.straightSinceMs = tMs;
      if (tMs - this.straightSinceMs >= this.config.settleMs) {
        return this.close(tMs, headingDeg);
      }
    } else {
      this.straightSinceMs = null;
    }

    // A rotation that never settles is a roundabout, a spiral ramp, or a bad
    // gyro. Close it rather than accumulating for ever.
    if (tMs - this.turnStartedAtMs >= this.config.maxDurationMs) {
      return this.close(tMs, headingDeg);
    }

    return null;
  }

  private close(tMs: number, headingDeg: number): TurnEvent | null {
    const total = this.turnTotalDeg;
    const startedAtMs = this.turnStartedAtMs;
    const fromHeadingDeg = this.turnStartHeadingDeg;
    this.turning = false;
    this.straightSinceMs = null;
    this.sweep = [];
    this.turnTotalDeg = 0;

    const kind = classifyTurn(total, this.config.minReportDeg);
    if (!kind) return null;

    const event: TurnEvent = {
      t: tMs,
      startedAtMs,
      durationMs: tMs - startedAtMs,
      kind,
      deltaDeg: total,
      // normalizeAngle360, not `(x + 360) % 360` — the latter still returns a
      // negative for anything below -360, and these two numbers are printed
      // straight onto the HUD. "Turned from -350° to -260°" is not a compass
      // bearing; it is a bug that reads as one.
      fromHeadingDeg: normalizeAngle360(fromHeadingDeg),
      toHeadingDeg: normalizeAngle360(headingDeg),
    };
    this.lastTurn = event;
    this.turnCount++;
    return event;
  }

  reset(): void {
    this.sweep = [];
    this.turning = false;
    this.turnStartedAtMs = 0;
    this.turnStartHeadingDeg = 0;
    this.turnTotalDeg = 0;
    this.straightSinceMs = null;
    this.lastTurn = null;
    this.turnCount = 0;
  }
}
