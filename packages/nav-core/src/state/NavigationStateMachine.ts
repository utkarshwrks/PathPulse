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
  /**
   * Scale the no-fix timeout to the fix rate actually observed. A device that
   * only produces a fix every 5 s must not be called "lost" after 1.5 s.
   */
  adaptiveTimeout: boolean;
  /** Multiple of the observed median fix interval to wait before declaring loss. */
  noFixIntervalFactor: number;
  /** Ceiling on the adaptive timeout, ms. A real tunnel must still be detected. */
  maxAdaptiveTimeoutMs: number;
  /** Provisional timeout before the receiver's cadence has been observed, ms. */
  warmupTimeoutMs: number;
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
  adaptiveTimeout: true,
  noFixIntervalFactor: 2.5,
  maxAdaptiveTimeoutMs: 20_000,
  warmupTimeoutMs: 6000,
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
  /** Recent gaps between fixes, ms. Feeds the adaptive timeout. */
  private fixIntervals: number[] = [];

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

  /**
   * How long we wait without a fix before calling GNSS degraded.
   *
   * ★ THIS IS THE FIX FOR "IT SAYS DEAD RECKONING WHILE GPS IS ON" ★
   *
   * The configured 1.5 s assumes a 1 Hz receiver. On real hardware the
   * Capacitor/WebView geolocation bridge delivered 0.05-0.20 Hz in field
   * testing — a fix every 5 to 20 seconds. Against a fixed 1.5 s timeout the
   * machine dropped into DEAD_RECKONING roughly 3.5 s after every fix, under
   * open sky, and stayed there until the next one arrived. The marker then
   * free-ran on inertial data for seconds at a time and got snapped back on
   * each fix, which is exactly the sawtooth the field screenshots show.
   *
   * The receiver's actual cadence is observable, so observe it: wait a
   * multiple of the median gap between fixes instead of a constant. A 1 Hz
   * device keeps the tight 1.5 s response; a 0.2 Hz device gets ~12 s and
   * stops lying about being lost. Capped, so a genuine tunnel is still caught.
   */
  get effectiveNoFixTimeoutMs(): number {
    if (!this.config.adaptiveTimeout) return this.config.noFixTimeoutMs;
    if (this.fixIntervals.length < 3) {
      // Warm-up: we do not know the cadence yet. Assuming 1 Hz is precisely the
      // assumption that produced the bug, and on a slow receiver it trips
      // DEAD_RECKONING within the first few seconds of the app opening — which
      // is the first thing anyone sees. Stay provisional instead: a real tunnel
      // is not missed by waiting a few more seconds before calling it.
      return Math.max(this.config.noFixTimeoutMs, this.config.warmupTimeoutMs);
    }
    const sorted = [...this.fixIntervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    return Math.min(
      this.config.maxAdaptiveTimeoutMs,
      Math.max(this.config.noFixTimeoutMs, median * this.config.noFixIntervalFactor),
    );
  }

  /** Median gap between fixes actually observed, ms. Null until enough data. */
  get observedFixIntervalMs(): number | null {
    if (this.fixIntervals.length < 3) return null;
    const sorted = [...this.fixIntervals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
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
      if (this.lastFixAtMs !== null) {
        const gap = nowMs - this.lastFixAtMs;
        // Only learn from gaps that look like the receiver's natural cadence.
        // A gap measured across a real tunnel would inflate the timeout and
        // stop us ever detecting the next one.
        if (gap > 0 && gap <= this.config.maxAdaptiveTimeoutMs) {
          this.fixIntervals.push(gap);
          if (this.fixIntervals.length > 10) this.fixIntervals.shift();
        }
      }
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
    if (msSinceFix > this.effectiveNoFixTimeoutMs) return true;
    if (!fix.hasFix) return false; // between fixes but still inside the timeout
    if (fix.accuracyM !== undefined && fix.accuracyM > this.config.degradedAccuracyM) return true;
    if (fix.satCount !== undefined && fix.satCount < this.config.minSatellites) return true;
    return false;
  }

  private degradeReason(fix: FixQuality, msSinceFix: number): string {
    if (msSinceFix > this.effectiveNoFixTimeoutMs) {
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
    this.fixIntervals = [];
  }
}
