import type { NavMode } from '../types.js';

export type NavEventType =
  | 'GNSS_FIX'
  | 'GNSS_LOST'
  | 'MODE_CHANGE'
  | 'ZUPT_TRIGGER'
  | 'ZARU_TRIGGER'
  | 'NHC_APPLIED'
  | 'DRIFT_MEASURED'
  | 'RECOVERY_COMPLETE'
  | 'POSITION_RESET'
  | 'ROAD_MATCH'
  /** A completed turn, classified. Phase 9B. */
  | 'TURN'
  /** GNSS looks jammed, spoofed, or simply wrong. Advisory only. Phase 9D. */
  | 'GNSS_ANOMALY'
  /** The speed model threw and was disabled. Never silent. */
  | 'ML_ERROR'
  /**
   * The speed model was held back because the motion is outside the domain it
   * was trained on. Logged, because a model quietly not being consulted is
   * indistinguishable from a model that is broken.
   */
  | 'ML_SUPPRESSED'
  /** The motion classifier changed its mind about what the carrier is doing. */
  | 'MOTION_CONTEXT'
  /**
   * The error-state Kalman filter was re-seeded from GNSS after rejecting
   * several honest fixes in a row. Phase 11. Never silent: a filter that
   * needed rescuing is a fact about the run, not an implementation detail.
   */
  | 'ESKF_RESET'
  /**
   * The automatic alignment engine changed its mind about the mount. Phase 12.
   * Logged on every transition, because "we no longer know which way the phone
   * is pointing" is exactly the sort of thing that must not be silent.
   */
  | 'ALIGNMENT'
  /**
   * Phase 13's motion classifier changed its accepted state. Distinct from
   * MOTION_CONTEXT, which is the vehicle/pedestrian detector: this one is the
   * eight-class model, and confusing the two in a log would make both useless.
   */
  | 'MOTION_STATE'
  /**
   * Phase 17: a turn sequence was recognised in the road graph and the
   * particle cloud collapsed onto it. The one event in this engine that
   * describes the estimate moving somewhere it had no continuous path to, so
   * it carries the fit and the margin over the runner-up.
   */
  | 'RELOCALISED'
  /**
   * Phase 18B: the engine decided what kind of vehicle it is riding in. A
   * two-wheeler turns the lean compensation on, and that changes every heading
   * afterwards, so it is never silent.
   */
  | 'VEHICLE_TYPE'
  | 'WARNING';

export interface NavEvent {
  t: number;
  type: NavEventType;
  message: string;
  from?: NavMode;
  to?: NavMode;
  data?: Record<string, number | string | boolean>;
}

/**
 * Bounded event log.
 *
 * Every transition is recorded with a timestamp and a *reason*. This is one of
 * the anti-fake features: a scripted animation cannot produce a log that
 * explains itself, and "mode changed because accuracy hit 31 m" is the kind of
 * detail a judge can interrogate.
 *
 * Capped so a long session cannot exhaust memory mid-demo.
 */
export class EventLog {
  private events: NavEvent[] = [];

  constructor(private readonly maxEntries = 200) {}

  push(event: NavEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEntries) this.events.shift();
  }

  get all(): readonly NavEvent[] {
    return this.events;
  }

  recent(n: number): NavEvent[] {
    return this.events.slice(-n);
  }

  toJSON(): string {
    return JSON.stringify(this.events, null, 2);
  }

  clear(): void {
    this.events = [];
  }
}
