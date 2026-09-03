/**
 * 15-state Error-State Kalman Filter.
 *
 * Reference: Joan Solà, "Quaternion kinematics for the error-state Kalman
 * filter" (2017). The equations below are his, with the LOCAL (body-frame)
 * angular error convention throughout — mixing local and global conventions
 * between the transition matrix and a measurement Jacobian gives a filter that
 * works perfectly while driving straight and diverges in every corner.
 *
 * ★ WHY AN ERROR STATE AT ALL ★
 * A direct Kalman filter on position, velocity and attitude has to linearise a
 * quaternion that is doing 90-degree turns, and has to keep a 4-vector on the
 * unit sphere while a linear update pushes it off. Splitting the estimate into
 * a large NOMINAL state, integrated exactly and non-linearly, plus a SMALL
 * ERROR state that the filter actually estimates, means the linearisation
 * point is always near zero — where linearisation is valid — and attitude
 * error is a minimal 3-vector with no constraint to violate. That is also the
 * honest answer to "why not the UKF the problem statement suggests": see the
 * README's ESKF-vs-UKF note.
 *
 * ★ WHY THIS DOES NOT REPLACE DeadReckoningEngine ★
 * It sits beside it, behind a flag, and the ablation table decides. The
 * shipped dead-reckoning chain measures 10.0 % mean drift; a filter is not
 * better because it is more principled, it is better when the number is lower.
 *
 * Frames: nav is ENU (east, north, up). Body is the VEHICLE frame — x forward,
 * y left, z up. Phone-to-vehicle rotation belongs to alignment/, not here.
 */
import type { Quaternion, Vec3 } from '../types.js';
import {
  add,
  clone,
  diag,
  identity,
  inverse,
  mul,
  mulVec,
  scale,
  setBlock,
  skew,
  sub,
  symmetrizeInPlace,
  trace,
  transpose,
  zeros,
  type Mat,
} from './matrix.js';
import {
  IDENTITY_QUAT,
  quatFromHeadingDeg,
  quatFromRotationVector,
  quatMultiply,
  quatNormalize,
  quatToHeadingDeg,
  quatToMatrix,
  rotateByQuatInverse,
} from './quaternion.js';
import { DEFAULT_ESKF_CONFIG, type EskfConfig } from './noise.js';

/** Index of each 3-vector block inside the 15-dimension error state. */
export const IDX = { P: 0, V: 3, TH: 6, BA: 9, BG: 12 } as const;
export const N = 15;

/** The large, non-linear state. The filter never estimates this directly. */
export interface NominalState {
  /** Position in the local ENU tangent plane, m. */
  position: Vec3;
  /** Velocity in the nav frame, m/s. */
  velocity: Vec3;
  /** Attitude, body -> nav. */
  quat: Quaternion;
  /** Accelerometer bias, body frame, m/s^2. */
  accelBias: Vec3;
  /** Gyroscope bias, body frame, rad/s. */
  gyroBias: Vec3;
}

export interface EskfSnapshot extends NominalState {
  headingDeg: number;
  speedMps: number;
  /** Covariance trace — one scalar the UI and the Phase 13 model can read. */
  covarianceTrace: number;
  /** 1-sigma position uncertainty, m, per nav axis. */
  positionSigmaM: Vec3;
}

/** What an update did, so the caller can log or reject it. */
export interface UpdateResult {
  applied: boolean;
  /** Normalised innovation squared — the standard consistency statistic. */
  nis: number;
  reason?: string;
}

const REJECTED = (reason: string): UpdateResult => ({ applied: false, nis: Number.NaN, reason });

export class ErrorStateKalmanFilter {
  private nominal: NominalState = {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    quat: [...IDENTITY_QUAT],
    accelBias: [0, 0, 0],
    gyroBias: [0, 0, 0],
  };

  private P: Mat;
  private config: EskfConfig;
  private initialised = false;

  constructor(config: Partial<EskfConfig> = {}) {
    this.config = { ...DEFAULT_ESKF_CONFIG, ...config };
    this.P = this.initialCovariance();
  }

  private initialCovariance(): Mat {
    const i = this.config.initial;
    const d = new Array(N).fill(0);
    for (let k = 0; k < 3; k++) {
      d[IDX.P + k] = i.positionM ** 2;
      d[IDX.V + k] = i.velocityMps ** 2;
      d[IDX.TH + k] = i.attitudeRad ** 2;
      d[IDX.BA + k] = i.accelBias ** 2;
      d[IDX.BG + k] = i.gyroBias ** 2;
    }
    return diag(d);
  }

  get isInitialised(): boolean {
    return this.initialised;
  }

  get covariance(): Mat {
    return clone(this.P);
  }

  setConfig(patch: Partial<EskfConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Seed from a trusted fix. Cheap enough to call on every fix if you like. */
  initialize(opts: {
    position: Vec3;
    velocity?: Vec3;
    headingDeg?: number;
    quat?: Quaternion;
    accelBias?: Vec3;
    gyroBias?: Vec3;
  }): void {
    this.nominal = {
      position: [...opts.position],
      velocity: opts.velocity ? [...opts.velocity] : [0, 0, 0],
      quat: opts.quat
        ? quatNormalize(opts.quat)
        : quatFromHeadingDeg(opts.headingDeg ?? 0),
      // Biases survive a re-seed on purpose: they are properties of the
      // hardware, not of the fix, and throwing away a converged bias every
      // time GNSS returns would mean the filter never benefits from having
      // learned it.
      accelBias: opts.accelBias ? [...opts.accelBias] : [...this.nominal.accelBias],
      gyroBias: opts.gyroBias ? [...opts.gyroBias] : [...this.nominal.gyroBias],
    };
    this.P = this.initialCovariance();
    this.initialised = true;
  }

  get state(): Readonly<NominalState> {
    return this.nominal;
  }

  snapshot(): EskfSnapshot {
    const v = this.nominal.velocity;
    return {
      ...this.nominal,
      position: [...this.nominal.position],
      velocity: [...v],
      quat: [...this.nominal.quat] as Quaternion,
      accelBias: [...this.nominal.accelBias],
      gyroBias: [...this.nominal.gyroBias],
      headingDeg: quatToHeadingDeg(this.nominal.quat),
      speedMps: Math.hypot(v[0], v[1], v[2]),
      covarianceTrace: trace(this.P),
      positionSigmaM: [
        Math.sqrt(Math.max(0, this.P[IDX.P]![IDX.P]!)),
        Math.sqrt(Math.max(0, this.P[IDX.P + 1]![IDX.P + 1]!)),
        Math.sqrt(Math.max(0, this.P[IDX.P + 2]![IDX.P + 2]!)),
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Prediction
  // ---------------------------------------------------------------------

  /**
   * Propagate on one IMU sample.
   *
   * @param accelBody specific force, m/s^2, body frame, gravity INCLUDED
   * @param gyroBody  angular rate, rad/s, body frame, right-hand rule
   * @param dtSec     elapsed seconds
   *
   * Specific force includes gravity because that is what an accelerometer
   * measures, and because gravity is how the filter observes pitch and roll at
   * all. Handing it a "linear acceleration" with gravity already removed by
   * some upstream filter throws that observability away and makes the attitude
   * error unbounded about two of its three axes.
   */
  predict(accelBody: readonly number[], gyroBody: readonly number[], dtSec: number): void {
    if (!(dtSec > 0) || dtSec > 1) return; // duplicate sample, or a clock jump
    if (!accelBody.every(Number.isFinite) || !gyroBody.every(Number.isFinite)) return;

    const dt = dtSec;
    const { quat, accelBias, gyroBias, position, velocity } = this.nominal;

    const a: Vec3 = [
      accelBody[0]! - accelBias[0],
      accelBody[1]! - accelBias[1],
      accelBody[2]! - accelBias[2],
    ];
    const w: Vec3 = [
      gyroBody[0]! - gyroBias[0],
      gyroBody[1]! - gyroBias[1],
      gyroBody[2]! - gyroBias[2],
    ];

    const R = quatToMatrix(quat);
    const aNav = mulVec(R, a);
    aNav[2]! -= this.config.gravityMps2; // ENU: gravity pulls along -up

    // --- nominal state, integrated exactly ------------------------------
    for (let k = 0; k < 3; k++) {
      const kk = k as 0 | 1 | 2;
      position[kk] = position[kk] + velocity[kk] * dt + 0.5 * aNav[kk]! * dt * dt;
      velocity[kk] = velocity[kk] + aNav[kk]! * dt;
    }
    const dq = quatFromRotationVector([w[0] * dt, w[1] * dt, w[2] * dt]);
    this.nominal.quat = quatNormalize(quatMultiply(quat, dq));

    // --- error-state transition F ---------------------------------------
    const F = identity(N);
    const I3 = identity(3);
    setBlock(F, IDX.P, IDX.V, scale(I3, dt));
    // dv is driven by attitude error through the rotated specific force, and
    // directly by accelerometer bias error.
    setBlock(F, IDX.V, IDX.TH, scale(mul(R, skew(a)), -dt));
    setBlock(F, IDX.V, IDX.BA, scale(R, -dt));
    // Local angular error rotates with the body: R{w dt}^T.
    setBlock(F, IDX.TH, IDX.TH, transpose(quatToMatrix(dq)));
    setBlock(F, IDX.TH, IDX.BG, scale(I3, -dt));

    // --- process noise Q -------------------------------------------------
    const n = this.config.imu;
    const qd = new Array(N).fill(0);
    for (let k = 0; k < 3; k++) {
      // Solà's impulse form: velocity and angle accumulate dt^2, biases dt.
      qd[IDX.V + k] = n.accelNoiseDensity ** 2 * dt * dt;
      qd[IDX.TH + k] = n.gyroNoiseDensity ** 2 * dt * dt;
      qd[IDX.BA + k] = n.accelBiasRandomWalk ** 2 * dt;
      qd[IDX.BG + k] = n.gyroBiasRandomWalk ** 2 * dt;
      // Position has no driving noise of its own — it inherits velocity's.
      // A floor keeps P strictly positive-definite over long GNSS-free runs
      // where nothing ever touches the position block directly.
      qd[IDX.P + k] = 1e-12;
    }

    this.P = symmetrizeInPlace(add(mul(mul(F, this.P), transpose(F)), diag(qd)));
  }

  // ---------------------------------------------------------------------
  // Measurement updates
  // ---------------------------------------------------------------------

  /**
   * The one update path. Every named update below builds an H, an innovation
   * and an R, and calls this.
   *
   * Joseph form — `(I-KH) P (I-KH)^T + K R K^T` — rather than the shorter
   * `(I-KH) P`. The short form is algebraically identical and numerically is
   * not: it subtracts two nearly equal matrices, which loses symmetry and then
   * positive-definiteness, and a filter whose P has gone indefinite reports
   * shrinking uncertainty while its estimate walks away. Joseph costs two
   * extra 15x15 products per update and cannot produce a non-positive P from a
   * positive one.
   *
   * @param gate reject the measurement above this NIS (chi-squared). Optional:
   *             a gate that fires on a genuine manoeuvre is worse than no gate.
   */
  private applyUpdate(H: Mat, innovation: number[], R: Mat, gate?: number): UpdateResult {
    if (!innovation.every(Number.isFinite)) return REJECTED('non-finite innovation');

    const Ht = transpose(H);
    const PHt = mul(this.P, Ht);
    const S = add(mul(H, PHt), R);

    let Sinv: Mat;
    try {
      Sinv = inverse(S);
    } catch {
      return REJECTED('singular innovation covariance');
    }

    const Sy = mulVec(Sinv, innovation);
    let nis = 0;
    for (let i = 0; i < innovation.length; i++) nis += innovation[i]! * Sy[i]!;
    if (gate !== undefined && Number.isFinite(nis) && nis > gate) {
      return { applied: false, nis, reason: 'gated' };
    }

    const K = mul(PHt, Sinv);
    const dx = mulVec(K, innovation);
    if (!dx.every(Number.isFinite)) return REJECTED('non-finite gain');

    const IKH = sub(identity(N), mul(K, H));
    this.P = symmetrizeInPlace(
      add(mul(mul(IKH, this.P), transpose(IKH)), mul(mul(K, R), transpose(K))),
    );

    this.inject(dx);
    return { applied: true, nis };
  }

  /**
   * Fold the error state into the nominal state and reset it.
   *
   * Done immediately after every update, which is what keeps the error state
   * identically zero between updates — so an innovation is always
   * `z - h(nominal)` with no error term to carry, and the linearisation point
   * never wanders from zero.
   */
  private inject(dx: number[]): void {
    const { position, velocity, accelBias, gyroBias } = this.nominal;
    for (let k = 0; k < 3; k++) {
      const kk = k as 0 | 1 | 2;
      position[kk] = position[kk] + dx[IDX.P + k]!;
      velocity[kk] = velocity[kk] + dx[IDX.V + k]!;
      accelBias[kk] = accelBias[kk] + dx[IDX.BA + k]!;
      gyroBias[kk] = gyroBias[kk] + dx[IDX.BG + k]!;
    }
    const dtheta = [dx[IDX.TH]!, dx[IDX.TH + 1]!, dx[IDX.TH + 2]!];
    this.nominal.quat = quatNormalize(
      quatMultiply(this.nominal.quat, quatFromRotationVector(dtheta)),
    );

    // ★ THE RESET JACOBIAN ★
    // Injecting a rotation moves the frame the angular error is expressed in,
    // so the covariance of that error has to be rotated with it. Solà eq. 285:
    // G_theta = I - [dtheta/2]x. It is a small correction and skipping it is a
    // popular shortcut; it is also why some ESKFs are subtly optimistic about
    // attitude after a long series of corrections.
    const G = identity(N);
    setBlock(G, IDX.TH, IDX.TH, sub(identity(3), skew([dtheta[0]! / 2, dtheta[1]! / 2, dtheta[2]! / 2])));
    this.P = symmetrizeInPlace(mul(mul(G, this.P), transpose(G)));
  }

  /** Build an H that reads one 3-vector block of the error state directly. */
  private blockH(offset: number): Mat {
    const H = zeros(3, N);
    for (let k = 0; k < 3; k++) H[k]![offset + k] = 1;
    return H;
  }

  /** GNSS position, ENU metres. `accuracyM` is the receiver's own 1-sigma. */
  updateGnssPosition(positionEnu: readonly number[], accuracyM: number, gate?: number): UpdateResult {
    const sigma = Math.max(0.5, accuracyM);
    // Vertical GNSS is roughly three times worse than horizontal, always, and
    // treating them alike lets altitude noise leak into the horizontal
    // solution through the covariance.
    const R = diag([sigma ** 2, sigma ** 2, (sigma * 3) ** 2]);
    const y = [
      positionEnu[0]! - this.nominal.position[0],
      positionEnu[1]! - this.nominal.position[1],
      (positionEnu[2] ?? this.nominal.position[2]) - this.nominal.position[2],
    ];
    return this.applyUpdate(this.blockH(IDX.P), y, R, gate);
  }

  /** GNSS velocity (Doppler), ENU m/s. */
  updateGnssVelocity(velocityEnu: readonly number[], sigmaMps: number, gate?: number): UpdateResult {
    const s = Math.max(0.05, sigmaMps);
    const R = diag([s ** 2, s ** 2, (s * 3) ** 2]);
    const y = [
      velocityEnu[0]! - this.nominal.velocity[0],
      velocityEnu[1]! - this.nominal.velocity[1],
      (velocityEnu[2] ?? this.nominal.velocity[2]) - this.nominal.velocity[2],
    ];
    return this.applyUpdate(this.blockH(IDX.V), y, R, gate);
  }

  /**
   * The non-holonomic constraint as a proper pseudo-measurement.
   *
   * Part A applies NHC by scrubbing lateral velocity out of the vector
   * directly. That works, and it is worth 29.3 % drift down from 59.2 % — but
   * it is a projection with no notion of confidence, so it can never tell the
   * filter anything about WHY there was lateral velocity. Here the same
   * physics is a measurement with a variance, so a persistent lateral error
   * flows through the Kalman gain into the attitude and gyro-bias states: the
   * filter concludes the vehicle is not pointing where it thought, which is
   * usually the truth, and corrects the heading rather than just hiding the
   * symptom.
   */
  updateNhc(gate?: number): UpdateResult {
    const vBody = rotateByQuatInverse(this.nominal.quat, this.nominal.velocity);
    const R = quatToMatrix(this.nominal.quat);
    const Rt = transpose(R);

    // h(x) = (R^T v)_{y,z}. With the local error convention,
    // R_true^T v = R^T v + [R^T v]x dtheta, so the attitude Jacobian is the
    // skew of the BODY-frame velocity.
    const S = skew(vBody);
    const H = zeros(2, N);
    for (let row = 0; row < 2; row++) {
      const axis = row + 1; // body y (lateral) and body z (vertical)
      for (let k = 0; k < 3; k++) {
        H[row]![IDX.V + k] = Rt[axis]![k]!;
        H[row]![IDX.TH + k] = S[axis]![k]!;
      }
    }

    const s = this.config.nhcSigmaMps ** 2;
    return this.applyUpdate(H, [-vBody[1], -vBody[2]], diag([s, s]), gate);
  }

  /**
   * Forward-speed pseudo-measurement: "the body is travelling at this speed
   * along its own x-axis".
   *
   * ★ WHY A KALMAN FILTER STILL NEEDS THIS ★
   * An accelerometer cannot distinguish a parked car from one cruising at a
   * steady 50 km/h — the specific force is identical. Speed is therefore not
   * observable from inertial data at all, only its rate of change is, and a
   * filter left to integrate acceleration across a five-minute tunnel has an
   * error that grows without bound no matter how principled its covariance
   * bookkeeping is. Measured: with no speed reference the filter ran to 1016 %
   * mean drift on the ablation logs, well past naive integration's 61 %,
   * because it was also confidently subtracting an accelerometer bias it had
   * fitted to genuine acceleration.
   *
   * So the speed chain — GNSS Doppler, then the IO-VNBD model, then the
   * pedestrian step model, then a decayed integration — stays exactly where
   * Part A's ablation left it, and arrives here as a measurement with a
   * variance. The filter's contribution is the direction: attitude, gyro bias
   * and the non-holonomic constraint, which is where a hand-rolled chain has
   * nothing equivalent.
   *
   * @param sigmaMps how much to believe it. A Doppler reading is worth 0.1;
   *                 a decayed integration is worth several m/s and should say so.
   */
  updateForwardSpeed(speedMps: number, sigmaMps: number, gate?: number): UpdateResult {
    if (!Number.isFinite(speedMps)) return REJECTED('non-finite speed');
    const vBody = rotateByQuatInverse(this.nominal.quat, this.nominal.velocity);
    const Rt = transpose(quatToMatrix(this.nominal.quat));
    const S = skew(vBody);

    const H = zeros(1, N);
    for (let k = 0; k < 3; k++) {
      H[0]![IDX.V + k] = Rt[0]![k]!;
      H[0]![IDX.TH + k] = S[0]![k]!;
    }
    return this.applyUpdate(H, [speedMps - vBody[0]], [[Math.max(0.05, sigmaMps) ** 2]], gate);
  }

  /** Zero-velocity update. The one moment velocity is known exactly. */
  updateZupt(gate?: number): UpdateResult {
    const s = this.config.zuptSigmaMps ** 2;
    const y = [-this.nominal.velocity[0], -this.nominal.velocity[1], -this.nominal.velocity[2]];
    return this.applyUpdate(this.blockH(IDX.V), y, diag([s, s, s]), gate);
  }

  /**
   * Zero-angular-rate update: while stationary, the whole gyro reading is bias.
   *
   * This is the only measurement in the filter that observes gyro bias
   * directly, and gyro bias is what turns into heading error, and heading
   * error is what turns into cross-track drift. Every stop at a traffic light
   * is a free calibration.
   */
  updateZaru(gyroBody: readonly number[], gate?: number): UpdateResult {
    if (!gyroBody.every(Number.isFinite)) return REJECTED('non-finite gyro');
    const s = this.config.zaruSigmaRadPerSec ** 2;
    const y = [
      gyroBody[0]! - this.nominal.gyroBias[0],
      gyroBody[1]! - this.nominal.gyroBias[1],
      gyroBody[2]! - this.nominal.gyroBias[2],
    ];
    return this.applyUpdate(this.blockH(IDX.BG), y, diag([s, s, s]), gate);
  }

  /**
   * Road projection: a scalar cross-track correction toward the matched road.
   *
   * ★ CROSS-TRACK ONLY — NEVER ALONG-TRACK ★ The same rule constraints/roadsnap.ts
   * enforces, here enforced by the measurement geometry itself rather than by
   * remembering to. The road says which line the vehicle is on; it says nothing
   * whatever about where along that line, and a filter allowed to correct
   * along-track from a map would happily invent progress it has not made.
   *
   * @param pointOnRoad nearest point on the matched centreline, ENU m
   * @param normal      unit vector perpendicular to the road, ENU (z ignored)
   */
  updateRoadCrossTrack(
    pointOnRoad: readonly number[],
    normal: readonly number[],
    sigmaM = this.config.roadCrossTrackSigmaM,
    gate?: number,
  ): UpdateResult {
    const nx = normal[0]!;
    const ny = normal[1]!;
    const norm = Math.hypot(nx, ny);
    if (!(norm > 1e-9)) return REJECTED('degenerate road normal');
    const ux = nx / norm;
    const uy = ny / norm;

    const H = zeros(1, N);
    H[0]![IDX.P] = ux;
    H[0]![IDX.P + 1] = uy;

    const zRoad = ux * pointOnRoad[0]! + uy * pointOnRoad[1]!;
    const hx = ux * this.nominal.position[0] + uy * this.nominal.position[1];
    return this.applyUpdate(H, [zRoad - hx], [[Math.max(0.25, sigmaM) ** 2]], gate);
  }

  /** Barometric or map altitude, m, in the same ENU frame as the position. */
  updateAltitude(altitudeM: number, sigmaM = this.config.baroSigmaM, gate?: number): UpdateResult {
    const H = zeros(1, N);
    H[0]![IDX.P + 2] = 1;
    return this.applyUpdate(
      H,
      [altitudeM - this.nominal.position[2]],
      [[Math.max(0.1, sigmaM) ** 2]],
      gate,
    );
  }

  reset(): void {
    this.nominal = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      quat: [...IDENTITY_QUAT],
      accelBias: [0, 0, 0],
      gyroBias: [0, 0, 0],
    };
    this.P = this.initialCovariance();
    this.initialised = false;
  }
}
