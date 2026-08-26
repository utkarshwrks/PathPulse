import type { EnuPoint, LatLon, NavigationState, SensorSample } from '../types.js';
import { enuToLatLon, latLonToEnu } from '../geo/enu.js';
import { haversineDistance } from '../geo/distance.js';
import { GravityRemover } from '../alignment/gravity.js';
import { SimpleAlignment } from '../alignment/simpleAlignment.js';
import { StationarityDetector, type StationarityResult } from '../filters/stationarity.js';
import { Vec3LowPassFilter, Vec3MedianFilter } from '../filters/index.js';
import { DeadReckoningEngine } from '../deadreckoning/DeadReckoningEngine.js';
import { NavigationStateMachine } from '../state/NavigationStateMachine.js';
import { EventLog } from '../state/events.js';
import { RecoveryBlender } from '../fusion/RecoveryBlender.js';

export interface EngineConfig {
  /** Runtime feature switches. Phase 5 wires these to on-screen toggles. */
  medianFilter: boolean;
  lowPass: boolean;
  /** Accuracy at or below which a fix is trusted for reset/seed, metres. */
  trustedAccuracyM: number;
  gyroZSign: 1 | -1;
  /** Confidence decays to 1/e after this long without GNSS. */
  confidenceTimeConstantMs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  medianFilter: true,
  lowPass: true,
  trustedAccuracyM: 20,
  gyroZSign: 1,
  confidenceTimeConstantMs: 60_000,
};

/**
 * The navigation engine.
 *
 * Pure: same sequence of samples in, same sequence of states out. No clocks,
 * no randomness, no I/O. That is what lets the eval harness replay a drive
 * deterministically and lets these transitions be unit tested rather than
 * observed by eye on a map.
 *
 * Per-sample order of operations:
 *   1. reject stale / duplicate samples
 *   2. despike (median) and de-vibrate (low-pass)
 *   3. remove gravity to get true vehicle acceleration
 *   4. detect stationarity (Phase 6 hangs ZUPT/ZARU off this)
 *   5. propagate dead reckoning — always, in every mode (shadow mode)
 *   6. step the state machine
 *   7. reset DR onto GNSS, or blend back toward it during recovery
 *   8. emit NavigationState
 */
export class NavigationEngine {
  private readonly config: EngineConfig;
  private readonly log = new EventLog();
  private readonly stateMachine: NavigationStateMachine;
  private readonly dr: DeadReckoningEngine;
  private readonly recovery = new RecoveryBlender();
  private readonly gravity = new GravityRemover();
  private readonly alignment = new SimpleAlignment();
  private readonly stationarity = new StationarityDetector();
  private readonly accelMedian = new Vec3MedianFilter(5);
  private readonly accelLowPass = new Vec3LowPassFilter(5, 50);

  /** ENU origin — the first trusted fix. All internal maths is metres from here. */
  private origin: LatLon | null = null;
  private lastSampleT: number | null = null;
  private lastGnssT: number | null = null;
  private lastGnssEnu: EnuPoint | null = null;
  private lastStationarity: StationarityResult = {
    isStationary: false,
    confidence: 0,
    accelVariance: NaN,
    gyroMean: NaN,
  };
  private covarianceAlongM = 0;
  private covarianceCrossM = 0;
  private estimatedDriftM = 0;
  private lastState: NavigationState | null = null;
  /** When the current dead-reckoning stretch began. Drives confidence decay. */
  private drStartedAtMs: number | null = null;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.stateMachine = new NavigationStateMachine({}, this.log);
    this.dr = new DeadReckoningEngine({ gyroZSign: this.config.gyroZSign });
  }

  get events(): EventLog {
    return this.log;
  }

  get stationarityState(): StationarityResult {
    return this.lastStationarity;
  }

  startCalibration(nowMs: number): void {
    this.alignment.startCalibration(nowMs);
  }

  /** Feed one sensor sample and get the resulting navigation state. */
  update(sample: SensorSample): NavigationState {
    // 1. Reject stale or duplicate samples. A clock that jumps backwards would
    //    produce a negative dt and send the position flying.
    if (this.lastSampleT !== null && sample.t <= this.lastSampleT) {
      return this.lastState ?? this.emptyState(sample.t);
    }
    const dtMs = this.lastSampleT === null ? 20 : sample.t - this.lastSampleT;
    this.lastSampleT = sample.t;

    // 2-4. Condition the IMU and read out motion state.
    let forwardAccel = 0;
    let gyroZ = 0;
    if (sample.imu) {
      const { ax, ay, az, gx, gy, gz, quat } = sample.imu;
      let a: [number, number, number] = [ax, ay, az];
      if (this.config.medianFilter) a = this.accelMedian.push(a[0], a[1], a[2]);
      if (this.config.lowPass) a = this.accelLowPass.push(a[0], a[1], a[2]);

      const linear = this.gravity.remove(a[0], a[1], a[2], quat);
      this.alignment.push(linear, sample.t);
      forwardAccel = this.alignment.toVehicleFrame(linear[0], linear[1]).forward;
      gyroZ = gz;

      this.lastStationarity = this.stationarity.push(ax, ay, az, gx, gy, gz);
    }

    // Establish the ENU origin from the first fix we see.
    if (!this.origin && sample.gnss) {
      this.origin = { lat: sample.gnss.lat, lon: sample.gnss.lon };
    }

    const gnssEnu = this.gnssToEnu(sample);
    const trusted =
      sample.gnss !== undefined &&
      sample.gnss.accuracyM <= this.config.trustedAccuracyM &&
      gnssEnu !== null;

    if (sample.gnss && gnssEnu) {
      this.lastGnssT = sample.t;
      this.lastGnssEnu = gnssEnu;
      if (trusted) {
        this.dr.pushFix({
          t: sample.t,
          enu: gnssEnu,
          speedMps: sample.gnss.speedMps ?? this.dr.lastTrustedSpeedMps,
          headingDeg: sample.gnss.headingDeg ?? this.dr.current.headingDeg,
          accuracyM: sample.gnss.accuracyM,
        });
      }
    }

    const modeBefore = this.stateMachine.current;

    // 5. ★ SHADOW MODE ★ Propagate every single sample, in every mode. When
    //    GNSS drops there is nothing to start: the estimate is already live.
    //    Feed GNSS speed while it is trustworthy so the estimate stays tight.
    const gnssSpeed = trusted ? sample.gnss?.speedMps : undefined;
    this.dr.propagate(forwardAccel, gyroZ, dtMs, gnssSpeed);

    // 6. Step the state machine.
    const recoveryDone = modeBefore === 'RECOVERING' && !this.recovery.isActive;
    const mode = this.stateMachine.update(
      sample.t,
      {
        hasFix: sample.gnss !== undefined,
        accuracyM: sample.gnss?.accuracyM,
        satCount: sample.gnss?.satCount,
      },
      recoveryDone,
    );

    // 7. Reconcile dead reckoning with GNSS according to the mode.
    let shownEnu: EnuPoint = this.dr.current.enu;

    if (mode === 'GNSS' || mode === 'GNSS_DEGRADED' || mode === 'INITIALIZING') {
      if (trusted && gnssEnu) {
        this.dr.resetTo({
          t: sample.t,
          enu: gnssEnu,
          speedMps: sample.gnss?.speedMps ?? this.dr.current.speedMps,
          headingDeg: sample.gnss?.headingDeg ?? this.dr.current.headingDeg,
          accuracyM: sample.gnss!.accuracyM,
        });
        shownEnu = gnssEnu;
        this.covarianceAlongM = sample.gnss!.accuracyM;
        this.covarianceCrossM = sample.gnss!.accuracyM;
      } else if (this.lastGnssEnu) {
        shownEnu = this.dr.current.enu;
      }
      this.estimatedDriftM = 0;
    } else if (mode === 'DEAD_RECKONING') {
      if (modeBefore !== 'DEAD_RECKONING') {
        this.drStartedAtMs = sample.t;
        // Seed the outage from a smoothed view of the recent past, not the
        // last fix — which is usually the worst one, taken under the overpass.
        this.dr.initializeFromRecentFixes();
        this.log.push({
          t: sample.t,
          type: 'GNSS_LOST',
          message: 'dead reckoning seeded from smoothed pre-outage state',
        });
      }
      shownEnu = this.dr.current.enu;
      // Uncertainty grows with distance travelled, and grows faster along the
      // direction of travel than across it — which is why the UI draws an
      // ellipse in Phase 9, not a circle.
      const dtS = dtMs / 1000;
      this.covarianceAlongM += 0.15 * dtS * Math.max(1, this.dr.current.speedMps);
      this.covarianceCrossM += 0.02 * dtS;
      this.estimatedDriftM = this.covarianceAlongM;
    } else if (mode === 'RECOVERING') {
      if (modeBefore !== 'RECOVERING' && gnssEnu) {
        const drift = this.recovery.begin(sample.t, this.dr.current.enu, gnssEnu);
        this.log.push({
          t: sample.t,
          type: 'DRIFT_MEASURED',
          message: `${drift.toFixed(1)}m over ${this.dr.current.distanceTravelledM.toFixed(0)}m (${(
            (drift / Math.max(1, this.dr.current.distanceTravelledM)) *
            100
          ).toFixed(2)}%)`,
          data: { driftM: drift, distanceM: this.dr.current.distanceTravelledM },
        });
      }
      const target = gnssEnu ?? this.lastGnssEnu ?? this.dr.current.enu;
      const blended = this.recovery.update(sample.t, target);
      shownEnu = blended.enu;
      this.estimatedDriftM = blended.driftM;
      if (!blended.isRecovering) {
        this.log.push({
          t: sample.t,
          type: 'RECOVERY_COMPLETE',
          message: `slew finished in ${blended.recoveryTimeMs.toFixed(0)}ms`,
        });
        if (gnssEnu) {
          this.dr.resetTo({
            t: sample.t,
            enu: gnssEnu,
            speedMps: sample.gnss?.speedMps ?? this.dr.current.speedMps,
            headingDeg: sample.gnss?.headingDeg ?? this.dr.current.headingDeg,
            accuracyM: sample.gnss?.accuracyM ?? 5,
          });
        }
        this.covarianceAlongM = 5;
        this.covarianceCrossM = 5;
        this.drStartedAtMs = null;
      }
    }

    // 8. Emit.
    const state = this.buildState(sample, mode, shownEnu);
    this.lastState = state;
    return state;
  }

  private gnssToEnu(sample: SensorSample): EnuPoint | null {
    if (!sample.gnss || !this.origin) return null;
    const { e, n } = latLonToEnu(
      sample.gnss.lat,
      sample.gnss.lon,
      this.origin.lat,
      this.origin.lon,
    );
    return { e, n };
  }

  private buildState(
    sample: SensorSample,
    mode: NavigationState['mode'],
    enu: EnuPoint,
  ): NavigationState {
    const pos = this.origin
      ? enuToLatLon(enu.e, enu.n, this.origin.lat, this.origin.lon)
      : { lat: 0, lon: 0 };

    const timeSinceGnssMs =
      this.lastGnssT === null ? 0 : Math.max(0, sample.t - this.lastGnssT);

    // Confidence decays with time spent dead reckoning, NOT time since the
    // last fix. Those differ: a fix can arrive while we are still showing a
    // drifted DR position (we only leave DR after several good fixes, and then
    // only after slewing). Keying on time-since-fix made confidence climb back
    // up while the displayed position was still wrong — exactly backwards.
    const drElapsedMs =
      this.drStartedAtMs === null ? 0 : Math.max(0, sample.t - this.drStartedAtMs);
    const confidence =
      mode === 'GNSS'
        ? 1
        : mode === 'GNSS_DEGRADED'
          ? 0.7
          : mode === 'INITIALIZING'
            ? 0
            : Math.exp(-drElapsedMs / this.config.confidenceTimeConstantMs);

    const state: NavigationState = {
      t: sample.t,
      mode,
      position: { lat: pos.lat, lon: pos.lon },
      velocityMps: this.dr.current.speedMps,
      headingDeg: this.dr.current.headingDeg,
      covariance: {
        alongM: this.covarianceAlongM,
        crossM: this.covarianceCrossM,
        headingDeg: mode === 'DEAD_RECKONING' ? Math.min(45, timeSinceGnssMs / 2000) : 2,
      },
      confidence: Math.max(0, Math.min(1, confidence)),
      distanceTravelledM: this.dr.current.distanceTravelledM,
      timeSinceGnssMs,
      estimatedDriftM: this.estimatedDriftM,
      biases: this.dr.current.biases,
    };

    // A NaN reaching the UI moves the marker to nowhere and is very hard to
    // trace back. Refuse to emit one; hold the last good state instead.
    if (!isFiniteState(state)) {
      this.log.push({ t: sample.t, type: 'WARNING', message: 'non-finite state suppressed' });
      return this.lastState ?? this.emptyState(sample.t);
    }
    return state;
  }

  private emptyState(t: number): NavigationState {
    return {
      t,
      mode: 'INITIALIZING',
      position: { lat: 0, lon: 0 },
      velocityMps: 0,
      headingDeg: 0,
      covariance: { alongM: 0, crossM: 0, headingDeg: 0 },
      confidence: 0,
      distanceTravelledM: 0,
      timeSinceGnssMs: 0,
      estimatedDriftM: 0,
      biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
    };
  }

  /** Straight-line error between the estimate and a known truth, for evaluation. */
  errorAgainst(truth: LatLon, state: NavigationState): number {
    return haversineDistance(truth.lat, truth.lon, state.position.lat, state.position.lon);
  }

  reset(): void {
    this.stateMachine.reset();
    this.dr.reset();
    this.recovery.reset();
    this.gravity.reset();
    this.alignment.reset();
    this.stationarity.reset();
    this.accelMedian.reset();
    this.accelLowPass.reset();
    this.log.clear();
    this.origin = null;
    this.lastSampleT = null;
    this.lastGnssT = null;
    this.lastGnssEnu = null;
    this.covarianceAlongM = 0;
    this.covarianceCrossM = 0;
    this.estimatedDriftM = 0;
    this.lastState = null;
    this.drStartedAtMs = null;
  }
}

function isFiniteState(s: NavigationState): boolean {
  return (
    Number.isFinite(s.position.lat) &&
    Number.isFinite(s.position.lon) &&
    Number.isFinite(s.velocityMps) &&
    Number.isFinite(s.headingDeg) &&
    Number.isFinite(s.confidence) &&
    Number.isFinite(s.distanceTravelledM)
  );
}
