import type { NavEvent } from './events.js';
import type { NavigationState } from '../types.js';

export interface SessionSummary {
  /** Wall time covered by the samples seen, ms. */
  durationMs: number;
  /** Distance the engine believes was travelled, metres. */
  distanceM: number;
  /** Completed dead-reckoning stretches. */
  outageCount: number;
  /** Total time spent in DEAD_RECKONING, ms. */
  outageTotalMs: number;
  /** Longest single outage, ms. */
  longestOutageMs: number;
  /** Best (smallest) measured drift on recovery, metres. Null until one happens. */
  bestDriftM: number | null;
  /** Worst (largest) measured drift on recovery, metres. */
  worstDriftM: number | null;
  /** Mean of the measured recovery drifts, metres. */
  meanDriftM: number | null;
  /** Highest speed seen, m/s. */
  maxSpeedMps: number;
  /** Engine output rate, measured from sample timestamps. */
  meanUpdateHz: number;
  /** Times ZUPT reset the error budget. */
  zuptTriggers: number;
}

export const EMPTY_SESSION_SUMMARY: SessionSummary = {
  durationMs: 0,
  distanceM: 0,
  outageCount: 0,
  outageTotalMs: 0,
  longestOutageMs: 0,
  bestDriftM: null,
  worstDriftM: null,
  meanDriftM: null,
  maxSpeedMps: 0,
  meanUpdateHz: 0,
  zuptTriggers: 0,
};

/**
 * Rolling summary of a session, for the Phase 5 stats panel.
 *
 * Pure and incremental: it takes the states the engine already emits and keeps
 * running totals, so nothing has to be retained or recomputed. Kept in nav-core
 * rather than the React layer because it is arithmetic over engine output, and
 * arithmetic in nav-core can be unit tested without a browser.
 *
 * ★ IT REPORTS MEASURED DRIFT, NOT MODELLED DRIFT ★
 * `NavigationState.estimatedDriftM` is a growth model — our own belief about
 * how wrong we might be. The numbers here come from DRIFT_MEASURED events,
 * which are emitted when GNSS returns and the estimate is compared against a
 * real fix. Those are the only drift figures that are evidence rather than
 * self-assessment, and they are the ones a judge is entitled to ask about.
 */
export class SessionStats {
  private firstT: number | null = null;
  private lastT: number | null = null;
  private sampleCount = 0;

  private distanceM = 0;
  private maxSpeedMps = 0;

  private inOutage = false;
  private outageStartedAt = 0;
  private outageCount = 0;
  private outageTotalMs = 0;
  private longestOutageMs = 0;

  private drifts: number[] = [];
  private zuptTriggers = 0;
  private seenEvents = 0;

  /** Feed every emitted state. Cheap enough to call at full rate. */
  push(state: NavigationState): void {
    if (!Number.isFinite(state.t)) return;
    if (this.firstT === null) this.firstT = state.t;
    // Guard against a source whose clock restarts (a simulator reset that did
    // not also reset the stats): treat it as a fresh origin rather than
    // reporting a negative duration.
    if (this.lastT !== null && state.t < this.lastT) this.firstT = state.t;
    this.lastT = state.t;
    this.sampleCount++;

    if (Number.isFinite(state.distanceTravelledM)) {
      this.distanceM = state.distanceTravelledM;
    }
    if (Number.isFinite(state.velocityMps) && state.velocityMps > this.maxSpeedMps) {
      this.maxSpeedMps = state.velocityMps;
    }

    const drNow = state.mode === 'DEAD_RECKONING';
    if (drNow && !this.inOutage) {
      this.inOutage = true;
      this.outageStartedAt = state.t;
    } else if (!drNow && this.inOutage) {
      this.inOutage = false;
      const span = Math.max(0, state.t - this.outageStartedAt);
      this.outageCount++;
      this.outageTotalMs += span;
      if (span > this.longestOutageMs) this.longestOutageMs = span;
    }
  }

  /**
   * Feed the engine's event log. Only entries beyond those already consumed are
   * read, so this can be called with the whole log every frame.
   *
   * The log is bounded at 200 entries and drops the oldest, so a very long
   * session can retire events before they are counted here. Accepted: the
   * alternative is a second unbounded buffer, and these are demo statistics,
   * not an audit trail.
   */
  pushEvents(events: readonly NavEvent[]): void {
    for (let i = this.seenEvents; i < events.length; i++) {
      const e = events[i]!;
      if (e.type === 'ZUPT_TRIGGER') this.zuptTriggers++;
      if (e.type === 'DRIFT_MEASURED') {
        const d = e.data?.driftM;
        if (typeof d === 'number' && Number.isFinite(d)) this.drifts.push(d);
      }
    }
    this.seenEvents = events.length;
  }

  get summary(): SessionSummary {
    const durationMs =
      this.firstT === null || this.lastT === null ? 0 : Math.max(0, this.lastT - this.firstT);

    // Count an outage that is still running, so the panel does not read zero
    // during the very moment the demo is about.
    let outageCount = this.outageCount;
    let outageTotalMs = this.outageTotalMs;
    let longestOutageMs = this.longestOutageMs;
    if (this.inOutage && this.lastT !== null) {
      const span = Math.max(0, this.lastT - this.outageStartedAt);
      outageCount += 1;
      outageTotalMs += span;
      if (span > longestOutageMs) longestOutageMs = span;
    }

    const meanUpdateHz =
      durationMs > 0 && this.sampleCount > 1
        ? ((this.sampleCount - 1) / durationMs) * 1000
        : 0;

    return {
      durationMs,
      distanceM: this.distanceM,
      outageCount,
      outageTotalMs,
      longestOutageMs,
      bestDriftM: this.drifts.length ? Math.min(...this.drifts) : null,
      worstDriftM: this.drifts.length ? Math.max(...this.drifts) : null,
      meanDriftM: this.drifts.length
        ? this.drifts.reduce((s, v) => s + v, 0) / this.drifts.length
        : null,
      maxSpeedMps: this.maxSpeedMps,
      meanUpdateHz,
      zuptTriggers: this.zuptTriggers,
    };
  }

  reset(): void {
    this.firstT = null;
    this.lastT = null;
    this.sampleCount = 0;
    this.distanceM = 0;
    this.maxSpeedMps = 0;
    this.inOutage = false;
    this.outageStartedAt = 0;
    this.outageCount = 0;
    this.outageTotalMs = 0;
    this.longestOutageMs = 0;
    this.drifts = [];
    this.zuptTriggers = 0;
    this.seenEvents = 0;
  }
}
