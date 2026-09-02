import type { SensorSample } from '@pathpulse/nav-core';
import type { EdgeSource } from './types.js';
import { GRADES, type ImuGrade } from '../grades.js';

const G = 9.80665;

/**
 * A deterministic vehicle driven at any sensor grade.
 *
 * ★ WHY THIS EXISTS ★
 * The problem statement asks for ~200 Hz on an external, FOG-class IMU. We do
 * not own a fibre-optic gyroscope — they cost several lakh rupees — and the
 * requirement is to support that class of *data*, not to possess the hardware.
 * So the grade becomes a noise model and the same vehicle is driven through
 * all three, which is the only way to show that what changes with sensor grade
 * is the error and not the algorithm.
 *
 * Every number this produces is simulated, and the CLI labels it as such.
 * That rule is not negotiable here for the same reason it is not negotiable
 * for the mobile app's drift figures: a simulation contains the errors we
 * thought to model, and reality contains the ones we did not.
 *
 * ★ WHAT IS MODELLED, AND WHY EACH ONE MATTERS ★
 * - Gravity in the accelerometer, because it measures specific force. Omitting
 *   it is the classic error that makes the estimator believe it is rising.
 * - Constant bias, because bias double-integrates and white noise does not.
 *   This is the single reason dead reckoning is hard, at every grade.
 * - White noise at the grade's 1-sigma.
 * - Real cornering, so the gyro has something to measure and NHC has something
 *   to constrain. A straight-line simulator would flatter every configuration.
 */
export interface FogSimulatorOptions {
  grade: ImuGrade;
  /** Sample period the runner will call at, ms. */
  periodMs: number;
  /** Cruise speed, m/s. */
  speedMps?: number;
  /** Seed, so a run is byte-identical to the last one. */
  seed?: number;
  /** Emit a GNSS fix this often, ms. 0 disables GNSS entirely (pure INS). */
  gnssIntervalMs?: number;
  /** Origin for the synthetic drive. */
  originLat?: number;
  originLon?: number;
}

/** Mulberry32 — small, fast, and identical across platforms. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the noise is actually Gaussian rather than merely random. */
function gaussian(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export class FogSimulatorSource implements EdgeSource {
  readonly name: string;

  private readonly opts: Required<FogSimulatorOptions>;
  private readonly rand: () => number;
  private readonly biasAx: number;
  private readonly biasAy: number;
  private readonly biasGz: number;

  /** Truth state, which the estimator never sees. */
  private headingRad = 0;
  private e = 0;
  private n = 0;
  private lastGnssMs = -Infinity;

  constructor(options: FogSimulatorOptions) {
    const p = GRADES[options.grade];
    this.opts = {
      grade: options.grade,
      periodMs: options.periodMs,
      speedMps: options.speedMps ?? 16.7, // ~60 km/h, the PS's tunnel case
      seed: options.seed ?? 1337,
      gnssIntervalMs: options.gnssIntervalMs ?? 0,
      originLat: options.originLat ?? 23.1815,
      originLon: options.originLon ?? 79.9864,
    };
    this.name = `sim:${p.label}`;
    this.rand = rng(this.opts.seed);
    // Bias is drawn once and then held for the whole run — that is what makes
    // it bias rather than noise, and what makes it accumulate.
    this.biasAx = gaussian(this.rand) * p.accelBiasMps2;
    this.biasAy = gaussian(this.rand) * p.accelBiasMps2;
    this.biasGz = gaussian(this.rand) * p.gyroBiasRadS;
  }

  next(tMs: number): SensorSample {
    const p = GRADES[this.opts.grade];
    const dt = this.opts.periodMs / 1000;
    const speed = this.opts.speedMps;

    // A gentle continuous curve with a sharper turn every 40 s, so heading is
    // never constant and the gyro is always being asked a real question.
    const phase = tMs / 1000;
    const yawRate =
      0.02 * Math.sin(phase / 12) + (Math.floor(phase / 40) % 2 === 0 ? 0.05 : -0.05);

    this.headingRad += yawRate * dt;
    this.e += speed * Math.sin(this.headingRad) * dt;
    this.n += speed * Math.cos(this.headingRad) * dt;

    // Specific force in the device frame. The vehicle cruises, so longitudinal
    // acceleration is ~0 and lateral is the centripetal term of the turn.
    const lateral = speed * yawRate;
    const sample: SensorSample = {
      t: tMs,
      imu: {
        ax: lateral + this.biasAx + gaussian(this.rand) * p.accelNoiseMps2,
        ay: 0 + this.biasAy + gaussian(this.rand) * p.accelNoiseMps2,
        az: G + gaussian(this.rand) * p.accelNoiseMps2,
        gx: gaussian(this.rand) * p.gyroNoiseRadS,
        gy: gaussian(this.rand) * p.gyroNoiseRadS,
        // ★ NEGATED ON PURPOSE — SEE SensorSample.imu ★
        // `yawRate` here is a compass rate: positive turns the truth vehicle
        // to the right, increasing its bearing. Real hardware reports the
        // right-hand rule, where a right turn about +Z is clockwise and
        // therefore negative, and nav-core resolves yaw from the raw axes
        // rather than a pre-converted compass sense. Emitting the compass sign
        // made the estimator turn the wrong way and accumulate 135 degrees of
        // heading error at every sensor grade — which reads as "grade does not
        // matter" and is really "the simulator lied about its axes".
        gz: -yawRate + this.biasGz + gaussian(this.rand) * p.gyroNoiseRadS,
      },
    };

    if (this.opts.gnssIntervalMs > 0 && tMs - this.lastGnssMs >= this.opts.gnssIntervalMs) {
      this.lastGnssMs = tMs;
      const mPerDegLat = 111_320;
      const mPerDegLon = 111_320 * Math.cos((this.opts.originLat * Math.PI) / 180);
      sample.gnss = {
        lat: this.opts.originLat + this.n / mPerDegLat,
        lon: this.opts.originLon + this.e / mPerDegLon,
        accuracyM: 4,
        speedMps: speed,
        headingDeg: ((this.headingRad * 180) / Math.PI + 360) % 360,
        satCount: 9,
      };
    }
    return sample;
  }

  /** Truth position in local metres — for scoring, never fed to the engine. */
  get truthEnu(): { e: number; n: number } {
    return { e: this.e, n: this.n };
  }

  /** Truth heading, degrees clockwise from north. Scoring only. */
  get truthHeadingDeg(): number {
    return (((this.headingRad * 180) / Math.PI) % 360 + 360) % 360;
  }
}
