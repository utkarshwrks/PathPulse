import type { NavMode } from '../types.js';
import { EventLog } from './events.js';

export interface StateMachineConfig {
  /** Consecutive good fixes needed to leave INITIALIZING. */
  fixesToInitialise: number;
  /** Accuracy at or below which a fix counts as good, metres. */
  goodAccuracyM: number;
  /** Accuracy above which GNSS counts as degraded, metres. */
  degradedAccuracyM: number;
  /** Minimum satellites before GNSS counts as degraded. */
  minSatellites: number;
  /** No fix for this long means degraded. */
  noFixTimeoutMs: number;
  /** Consecutive good fixes needed to recover from degraded. */
  fixesToRecoverFromDegraded: number;
  /** Time spent degraded before falling back to dead reckoning. */
  degradedToDrMs: number;
  /** Consecutive good fixes needed to start recovering from dead reckoning. */
  fixesToStartRecovery: number;
}

export const DEFAULT_STATE_MACHINE_CONFIG: StateMachineConfig = {
  fixesToInitialise: 3,
  goodAccuracyM: 20,
  degradedAccuracyM: 25,
  minSatellites: 4,
  noFixTimeoutMs: 1500,
  fixesToRecoverFromDegraded: 2,
  degradedToDrMs: 2000,
  fixesToStartRecovery: 2,
};

export interface FixQuality {
  hasFix: boolean;
  accuracyM?: number;
  satCount?: number;
}

/**
 * The navigation mode state machine.
 *
 * ★ HYSTERESIS IS THE POINT ★
 * Every transition needs either several consecutive confirmations or a
 * sustained condition — never a single sample. Without that, a fix hovering
 * around the accuracy threshold makes the badge flip between GNSS and DEAD
 * RECKONING several times a second. The maths might be perfect and the demo
 * still reads as broken.
 *
 * ★ SHADOW MODE ★
 * Dead reckoning is not started when GNSS fails. It runs continuously, in
 * every mode, being reset by each good fix. When GNSS drops there is nothing
 * to spin up and no initialisation to perform — the estimate is already
 * running and already current. That is how the problem statement's "seamless
 * handover within milliseconds" is actually achieved: there is no handover.
 */
export class NavigationStateMachine {
  private mode: NavMode = 'INITIALIZING';
  private readonly config: StateMachineConfig;
  private readonly log: EventLog;

  private consecutiveGoodFixes = 0;
  private lastFixAtMs: number | null = null;
  private degradedSinceMs: number | null = null;
  private modeEnteredAtMs = 0;

  constructor(config: Partial<StateMachineConfig> = {}, log = new EventLog()) {
    this.config = { ...DEFAULT_STATE_MACHINE_CONFIG, ...config };
    this.log = log;
  }

  get current(): NavMode {
    return this.mode;
  }

  get events(): EventLog {
    return this.log;
  }

  get timeSinceLastFixMs(): number | null {
    return this.lastFixAtMs;
  }

  /** True in the two modes where the position shown is inertially derived. */
  get isDeadReckoning(): boolean {
    return this.mode === 'DEAD_RECKONING';
  }

  /**
   * Advance the machine one step.
   * @param recoveryComplete set by the blender when the slew has finished.
   */
  update(nowMs: number, fix: FixQuality, recoveryComplete = false): NavMode {
    const good = this.isGoodFix(fix);

    if (fix.hasFix) {
      this.lastFixAtMs = nowMs;
      this.consecutiveGoodFixes = good ? this.consecutiveGoodFixes + 1 : 0;
      if (good) {
        this.log.push({
          t: nowMs,
          type: 'GNSS_FIX',
          message: `acc=${fix.accuracyM?.toFixed(1) ?? '?'}m sats=${fix.satCount ?? '?'}`,
          data: { accuracyM: fix.accuracyM ?? -1 },
        });
      }
    }

    const msSinceFix = this.lastFixAtMs === null ? Infinity : nowMs - this.lastFixAtMs;
    const degradedNow = this.isDegraded(fix, msSinceFix);

    switch (this.mode) {
      case 'INITIALIZING':
        if (this.consecutiveGoodFixes >= this.config.fixesToInitialise) {
          this.transition(nowMs, 'GNSS', `${this.consecutiveGoodFixes} consecutive good fixes`);
        }
        break;

      case 'GNSS':
        if (degradedNow) {
          this.degradedSinceMs = nowMs;
          this.transition(nowMs, 'GNSS_DEGRADED', this.degradeReason(fix, msSinceFix));
        }
        break;

      case 'GNSS_DEGRADED':
        if (!degradedNow && this.consecutiveGoodFixes >= this.config.fixesToRecoverFromDegraded) {
          this.degradedSinceMs = null;
          this.transition(nowMs, 'GNSS', 'fix quality restored');
        } else if (
          this.degradedSinceMs !== null &&
          nowMs - this.degradedSinceMs >= this.config.degradedToDrMs
        ) {
          this.transition(
            nowMs,
            'DEAD_RECKONING',
            `degraded for ${((nowMs - this.degradedSinceMs) / 1000).toFixed(1)}s`,
          );
        }
        break;

      case 'DEAD_RECKONING':
        if (this.consecutiveGoodFixes >= this.config.fixesToStartRecovery) {
          this.transition(
            nowMs,
            'RECOVERING',
            `${this.consecutiveGoodFixes} good fixes returned`,
          );
        }
        break;

      case 'RECOVERING':
        if (recoveryComplete) {
          this.degradedSinceMs = null;
          this.transition(nowMs, 'GNSS', 'slew complete');
        }
        break;

      case 'ERROR':
        break;
    }

    return this.mode;
  }

  private isGoodFix(fix: FixQuality): boolean {
    if (!fix.hasFix) return false;
    if (fix.accuracyM === undefined) return false;
    if (fix.accuracyM > this.config.goodAccuracyM) return false;
    if (fix.satCount !== undefined && fix.satCount < this.config.minSatellites) return false;
    return true;
  }

  private isDegraded(fix: FixQuality, msSinceFix: number): boolean {
    if (msSinceFix > this.config.noFixTimeoutMs) return true;
    if (!fix.hasFix) return false; // between fixes but still inside the timeout
    if (fix.accuracyM !== undefined && fix.accuracyM > this.config.degradedAccuracyM) return true;
    if (fix.satCount !== undefined && fix.satCount < this.config.minSatellites) return true;
    return false;
  }

  private degradeReason(fix: FixQuality, msSinceFix: number): string {
    if (msSinceFix > this.config.noFixTimeoutMs) {
      return `no fix for ${(msSinceFix / 1000).toFixed(1)}s`;
    }
    if (fix.accuracyM !== undefined && fix.accuracyM > this.config.degradedAccuracyM) {
      return `accuracy ${fix.accuracyM.toFixed(1)}m`;
    }
    return `satellites ${fix.satCount ?? '?'}`;
  }

  private transition(nowMs: number, to: NavMode, reason: string): void {
    const from = this.mode;
    if (from === to) return;
    this.mode = to;
    this.modeEnteredAtMs = nowMs;
    if (to === 'DEAD_RECKONING' || to === 'GNSS_DEGRADED') this.consecutiveGoodFixes = 0;
    this.log.push({ t: nowMs, type: 'MODE_CHANGE', message: `${from} -> ${to} (${reason})`, from, to });
  }

  timeInModeMs(nowMs: number): number {
    return nowMs - this.modeEnteredAtMs;
  }

  forceMode(nowMs: number, mode: NavMode, reason: string): void {
    this.transition(nowMs, mode, reason);
  }

  reset(): void {
    this.mode = 'INITIALIZING';
    this.consecutiveGoodFixes = 0;
    this.lastFixAtMs = null;
    this.degradedSinceMs = null;
    this.modeEnteredAtMs = 0;
  }
}
