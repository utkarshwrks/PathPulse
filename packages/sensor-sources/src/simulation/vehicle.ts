import { angleDifference } from '@pathpulse/nav-core';
import type { RoutePath } from './route.js';

export interface VehicleConfig {
  /** Free-flow speed in m/s. */
  cruiseMps: number;
  accelMps2: number;
  decelMps2: number;
  /** Arc-length fractions (0..1) where the vehicle stops, e.g. red lights. */
  stopsAtFraction: number[];
  stopDurationMs: number;
  /** Lateral acceleration a driver will tolerate; caps speed in bends. */
  maxLateralMps2: number;
}

export const CITY_VEHICLE: VehicleConfig = {
  cruiseMps: 13.9, // 50 km/h
  accelMps2: 1.6,
  decelMps2: 2.5,
  stopsAtFraction: [0.25, 0.55, 0.8],
  stopDurationMs: 10_000,
  maxLateralMps2: 2.2,
};

export const HIGHWAY_VEHICLE: VehicleConfig = {
  cruiseMps: 25, // 90 km/h
  accelMps2: 1.2,
  decelMps2: 2.5,
  stopsAtFraction: [],
  stopDurationMs: 0,
  maxLateralMps2: 2.0,
};

export interface VehicleState {
  /** Arc length along the route, metres. */
  s: number;
  speedMps: number;
  headingDeg: number;
  /** Yaw rate, rad/s, positive clockwise (compass convention). */
  yawRateRadPerSec: number;
  /** Longitudinal acceleration, m/s^2. */
  accelMps2: number;
  isStopped: boolean;
  finished: boolean;
}

/**
 * Kinematic vehicle following a route.
 *
 * Deliberately not a random walk: it accelerates, brakes for upcoming stops,
 * slows for bends, and waits at red lights. Those are exactly the events the
 * navigation engine must survive — ZUPT fires at the stops, NHC is tested by
 * the bends — so a simulator that just cruised at constant speed would make
 * the whole harness worthless.
 */
export class VehicleModel {
  private state: VehicleState;
  private readonly stopsS: number[];
  private stopIndex = 0;
  private stopHoldRemainingMs = 0;

  constructor(
    private readonly route: RoutePath,
    private readonly config: VehicleConfig,
  ) {
    this.stopsS = config.stopsAtFraction
      .map((f) => f * route.lengthM)
      .sort((a, b) => a - b);
    this.state = {
      s: 0,
      speedMps: 0,
      headingDeg: route.headingAt(0),
      yawRateRadPerSec: 0,
      accelMps2: 0,
      isStopped: true,
      finished: false,
    };
  }

  get current(): Readonly<VehicleState> {
    return this.state;
  }

  /** Advance the vehicle by `dtMs` of simulated time. */
  step(dtMs: number): Readonly<VehicleState> {
    const dt = dtMs / 1000;
    const st = this.state;

    if (st.finished) return st;

    // Holding at a red light.
    if (this.stopHoldRemainingMs > 0) {
      this.stopHoldRemainingMs -= dtMs;
      st.speedMps = 0;
      st.accelMps2 = 0;
      st.yawRateRadPerSec = 0;
      st.isStopped = true;
      if (this.stopHoldRemainingMs <= 0) this.stopIndex++;
      return st;
    }

    const targetSpeed = this.targetSpeedAt(st.s, st.speedMps);
    const prevSpeed = st.speedMps;

    if (targetSpeed > st.speedMps) {
      st.speedMps = Math.min(targetSpeed, st.speedMps + this.config.accelMps2 * dt);
    } else if (targetSpeed < st.speedMps) {
      st.speedMps = Math.max(targetSpeed, st.speedMps - this.config.decelMps2 * dt);
    }
    st.accelMps2 = dt > 0 ? (st.speedMps - prevSpeed) / dt : 0;

    const prevHeading = st.headingDeg;
    st.s += st.speedMps * dt;

    if (st.s >= this.route.lengthM) {
      st.s = this.route.lengthM;
      st.finished = true;
    }

    st.headingDeg = this.route.headingAt(st.s);
    // Shortest-arc difference, so a turn through north is not a 359 deg spin.
    const dHeadingDeg = angleDifference(st.headingDeg, prevHeading);
    st.yawRateRadPerSec = dt > 0 ? (dHeadingDeg * Math.PI) / 180 / dt : 0;
    st.isStopped = st.speedMps < 0.05;

    // Arrived at the next scheduled stop.
    const nextStop = this.stopsS[this.stopIndex];
    if (nextStop !== undefined && st.s >= nextStop && st.speedMps < 0.6) {
      this.stopHoldRemainingMs = this.config.stopDurationMs;
      st.speedMps = 0;
      st.isStopped = true;
    }

    return st;
  }

  /** Desired speed here: slower into bends, zero approaching a stop line. */
  private targetSpeedAt(s: number, currentSpeed: number): number {
    let target = this.config.cruiseMps;

    // Curvature limit: v = sqrt(a_lat / kappa).
    const kappa = this.curvatureAt(s);
    if (kappa > 1e-6) {
      target = Math.min(target, Math.sqrt(this.config.maxLateralMps2 / kappa));
    }

    // Brake in time for the next stop line.
    const nextStop = this.stopsS[this.stopIndex];
    if (nextStop !== undefined) {
      const distance = nextStop - s;
      if (distance <= 0) return 0;
      const brakingDistance =
        (currentSpeed * currentSpeed) / (2 * this.config.decelMps2) + 2;
      if (distance <= brakingDistance) {
        target = Math.min(target, Math.sqrt(2 * this.config.decelMps2 * Math.max(0, distance)));
      }
    }

    return Math.max(0, target);
  }

  /** Path curvature (1/radius) estimated from heading change over 10 m. */
  private curvatureAt(s: number): number {
    const ds = 10;
    const h1 = this.route.headingAt(s);
    const h2 = this.route.headingAt(s + ds);
    const dRad = Math.abs((angleDifference(h2, h1) * Math.PI) / 180);
    return dRad / ds;
  }
}
