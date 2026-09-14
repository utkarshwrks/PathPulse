/**
 * Learn what the speed model gets wrong, while there is still something to
 * check it against.
 *
 * ★ MAE IS NOT WHAT A DEAD-RECKONING SYSTEM PAYS FOR — AND NOR IS A FIXED
 *   MODEL ★
 *
 * The engine INTEGRATES this model's output, so a zero-mean error largely
 * cancels and a BIAS does not: 1 m/s of bias is 30 m of invented distance every
 * 30 s, every time. The weights were retrained against exactly that and it is
 * the right target — but a bias measured on a held-out split is the bias on
 * THAT data. On the two IO-VNBD replays the shipped model runs 3.3 and 4.2 m/s
 * MAE, and Tier R's error is along-track by a factor of three to four, which is
 * the signature of a speed error rather than a heading one.
 *
 * What no amount of retraining can supply is the vehicle actually being driven
 * right now: this scooter, this rider, this phone, this road surface. That is
 * observable, for free, every second GNSS is up — the receiver reports a
 * Doppler speed and the model reports its opinion of the same moment, and the
 * ratio between them is the correction to carry into the outage.
 *
 * ★ THE PATTERN IS ALREADY IN THIS PROJECT, TWICE ★
 *
 * `StrideModel` learns metres-per-step from GNSS while it can, so the step
 * model is worth something once GNSS is gone. `MagneticHeading` learns the grip
 * offset the same way. Both are the same shape: an unknown constant of the
 * carrier, unobservable from the IMU alone, measured against GNSS while it is
 * free and spent during the outage. This is that, applied to the one quantity
 * Tier R says dominates.
 *
 * ★ MULTIPLICATIVE, NOT ADDITIVE ★
 *
 * A scale maps zero to zero, so a stopped vehicle stays stopped however the
 * correction is learned. An offset does not: a +2 m/s offset asserts motion at
 * a red light, which is the exact failure the derived channels were added to
 * reduce. The scale is also the physically likely error — a model reading
 * vibration amplitude under-reads a soft suspension and over-reads a hard one,
 * roughly proportionally.
 *
 * ★ AND IT REFUSES TO LEARN FROM MOMENTS THAT TEACH NOTHING ★
 *
 * Only above `minSpeedMps`. Near zero the ratio is a small number over a small
 * number, and one pair at 0.2 m/s against 0.05 would teach a scale of four.
 */

export interface SpeedCalibratorConfig {
  /**
   * Pairs kept. At one fix a second this is the last two minutes of driving.
   *
   * ★ NOT `window` ★ `pnpm lint:core-purity` greps nav-core for browser
   * globals by identifier, so a field with that name fails Golden Rule #1 —
   * which it did, silently, for as long as this file has existed. The guard is
   * deliberately blunt and `TurnDetector.sweep` already carries the same note;
   * working around it with an exception would blunt it further.
   */
  windowSize: number;
  /** Below this the ratio is noise over noise and is not observed, m/s. */
  minSpeedMps: number;
  /** Pairs required before the scale is applied at all. */
  minObservations: number;
  /**
   * Bounds on the learned scale.
   *
   * ★ A CALIBRATION IS A CORRECTION, NOT A REPLACEMENT ★ If the model is out by
   * more than this it is not miscalibrated, it is wrong — out of its training
   * domain, fed a mount it has never seen, or reading a vehicle whose vibration
   * signature is nothing like IO-VNBD's. Rescaling by 4 would hide that and
   * assert a speed built on nothing. Clamped, the worst case is that the
   * correction saturates and the estimate is no worse than the uncalibrated
   * model it started from.
   */
  minScale: number;
  maxScale: number;
  /**
   * How stale the calibration may be before it is abandoned, ms.
   *
   * A scale learned before the rider got off a scooter and into a car describes
   * a different vehicle. Past this, the model is used as trained.
   */
  maxAgeMs: number;
  /**
   * Bounds outside which the model is not miscalibrated but WRONG.
   *
   * ★ THE SAME NUMBERS, ASKED A DIFFERENT QUESTION ★
   *
   * `minScale`/`maxScale` clamp the correction. These decide whether there is
   * anything worth correcting — see `isTrusted`. Deliberately the same values,
   * because the argument for them is the same one: a model out by more than
   * this is describing a different vehicle, a different mount, or a different
   * kind of road, and no multiplier makes it into evidence.
   */
  minTrustRatio: number;
  maxTrustRatio: number;
  /**
   * The least the model's output may correlate with the receiver's over the
   * window before it is trusted. 0 disables.
   *
   * ★ A RATIO CANNOT TELL A CONSTANT FROM A MEASUREMENT ★
   *
   * The ratio of sums weights every pair by the speed it was observed at, so
   * a model that answers a constant 12 m/s whatever the vehicle does passes
   * the ratio test whenever the vehicle has recently been doing about 12 —
   * and on a two-wheeler that is what this model does. Paired against
   * Doppler across the three Tier F rides, at 1 Hz, above 1 m/s:
   *
   *   ride     n     r        ml/gnss at 1-3 m/s   at 9-20 m/s
   *   2229    871   -0.05          5.7               1.15
   *   2141    687   -0.17          8.5               1.69
   *   1942    232   +0.19          7.6                 —
   *
   * Correlation of essentially zero. The model reads this vehicle's vibration
   * and its vibration does not vary with speed, so it answers 12–18 m/s at a
   * crawl and at 50 km/h alike — and a constant that happens to match the
   * vehicle's fastest recent minute is the one thing the ratio test cannot
   * refuse. On IO-VNBD, in domain, the same pairs give r ≈ 0.9.
   *
   * Only asked when the measured speeds have varied by `minTrustSpreadMps`
   * over the window: a car that has held 100 km/h for two minutes gives no
   * evidence either way, and there the ratio test stands alone.
   */
  minTrustCorrelation: number;
  /** Standard deviation of the measured speeds below which correlation is not asked, m/s. */
  minTrustSpreadMps: number;
}

export const DEFAULT_SPEED_CALIBRATOR_CONFIG: SpeedCalibratorConfig = {
  windowSize: 120,
  minSpeedMps: 2,
  minObservations: 10,
  minScale: 0.6,
  maxScale: 1.7,
  maxAgeMs: 300_000,
  minTrustRatio: 0.6,
  maxTrustRatio: 1.7,
  minTrustCorrelation: 0,
  minTrustSpreadMps: 1,
};

export interface SpeedCalibratorState {
  scale: number;
  observations: number;
  /** True when the scale is actually being applied. */
  active: boolean;
  /** False once the model has been shown to be out of its domain. */
  trusted: boolean;
  /** The unclamped ratio, or NaN before there is enough to say. */
  rawRatio: number;
  /** Pearson correlation of model against receiver over the window, or NaN. */
  correlation: number;
}

export class MlSpeedCalibrator {
  private readonly config: SpeedCalibratorConfig;
  private readonly measured: number[] = [];
  private readonly predicted: number[] = [];
  private lastObservedT: number | null = null;

  constructor(config: Partial<SpeedCalibratorConfig> = {}) {
    this.config = { ...DEFAULT_SPEED_CALIBRATOR_CONFIG, ...config };
  }

  /**
   * One matched pair: what the receiver measured, and what the model said about
   * the same moment.
   */
  observe(tMs: number, measuredMps: number, predictedMps: number): void {
    if (!Number.isFinite(measuredMps) || !Number.isFinite(predictedMps)) return;
    if (measuredMps < this.config.minSpeedMps) return;
    if (predictedMps <= 0) return;
    this.measured.push(measuredMps);
    this.predicted.push(predictedMps);
    if (this.measured.length > this.config.windowSize) {
      this.measured.shift();
      this.predicted.shift();
    }
    this.lastObservedT = tMs;
  }

  /**
   * The unclamped ratio of what was measured to what the model said, or NaN
   * when there is not enough to say.
   */
  rawRatioAt(tMs: number): number {
    if (this.measured.length < this.config.minObservations) return Number.NaN;
    if (this.lastObservedT !== null && tMs - this.lastObservedT > this.config.maxAgeMs) {
      return Number.NaN;
    }
    let sm = 0;
    let sp = 0;
    for (let i = 0; i < this.measured.length; i++) {
      sm += this.measured[i]!;
      sp += this.predicted[i]!;
    }
    if (!(sp > 1e-6)) return Number.NaN;
    const raw = sm / sp;
    return Number.isFinite(raw) ? raw : Number.NaN;
  }

  /**
   * Is this model saying anything about THIS vehicle worth listening to?
   *
   * ★ THE SAME MEASUREMENT, SPENT THE OTHER WAY ROUND ★
   *
   * Correcting the model with the learned scale is a kept negative result: a
   * fitted multiplier feeds an integrated quantity, and over 16 outage windows
   * it moved the median from 32.8 % to 29.5 % and the worst case from 131.5 %
   * to 207.9 %. Better in the middle, much worse at the ends. The failure was
   * in the FITTING — a two-minute fit is itself an estimate, and when the
   * stretch it was fitted on is unrepresentative it is confidently wrong in
   * the expensive direction.
   *
   * None of that argument survives when the same pairs are used to answer a
   * BINARY question instead. A ratio of 0.34 is not a number to multiply by;
   * it is the observation that this model, on this handset, on this vehicle,
   * says three times what the receiver measures — and the honest response to
   * that is to stop consulting it, not to scale it. Suppression has no tail:
   * the chain falls back to integrating from the last measured speed, which is
   * the arm the ablation compares everything else against.
   *
   * Field report, a scooter at an indicated 25-30 km/h with the receiver
   * blocked: `[ML] 89 km/h` and 2274 m of distance banked on a ride of well
   * under a kilometre. The receiver had been contradicting the model, out
   * loud, at 1 Hz, for the whole of the drive that preceded it. Nothing was
   * listening.
   *
   * Silent until `minObservations` pairs exist, so a short session, a handset
   * that never had a fix, and every replay in the corpus behave exactly as
   * they did.
   */
  isTrusted(tMs: number): boolean {
    const raw = this.rawRatioAt(tMs);
    // ★ NO EVIDENCE IS NOT A PASS ★
    //
    // This used to return true when there were not enough pairs yet, on the
    // reasoning that a silent gate leaves a short session behaving exactly as
    // it did. The first Tier F ride showed what that costs: the outage began
    // twenty seconds in, with the vehicle having been stopped until then, so
    // no pair had ever cleared `minSpeedMps` and the gate had nothing to say.
    // The model asserted 92 km/h on a scooter and drew 945 m over a 216 m
    // stretch, unchecked, because the check had not been earned yet.
    //
    // The asymmetry is the argument. A model withheld costs the chain its best
    // inference and falls back to integrating from the last Doppler speed —
    // measured, bounded, and the arm every published figure is compared
    // against. A model admitted without evidence costs an outage. So the
    // default is to wait for the receiver to say something, which on a moving
    // vehicle takes about ten seconds.
    if (!Number.isFinite(raw)) return false;
    if (raw < this.config.minTrustRatio || raw > this.config.maxTrustRatio) return false;
    // See `minTrustCorrelation`. Only when the vehicle has varied its speed
    // enough for tracking to be distinguishable from a constant.
    if (this.config.minTrustCorrelation > 0) {
      const { r, spread } = this.correlationAt();
      if (spread >= this.config.minTrustSpreadMps && !(r >= this.config.minTrustCorrelation)) {
        return false;
      }
    }
    return true;
  }

  /** Pearson correlation of predicted against measured, and the measured spread. */
  private correlationAt(): { r: number; spread: number } {
    const n = this.measured.length;
    if (n < this.config.minObservations) return { r: Number.NaN, spread: 0 };
    let mm = 0;
    let mp = 0;
    for (let i = 0; i < n; i++) {
      mm += this.measured[i]!;
      mp += this.predicted[i]!;
    }
    mm /= n;
    mp /= n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = this.measured[i]! - mm;
      const dy = this.predicted[i]! - mp;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    const spread = Math.sqrt(sxx / n);
    if (!(sxx > 0) || !(syy > 0)) return { r: Number.NaN, spread };
    return { r: sxy / Math.sqrt(sxx * syy), spread };
  }

  /**
   * The scale to multiply the model's output by, or 1 when there is not enough
   * to say.
   *
   * ★ A RATIO OF SUMS, NOT A MEAN OF RATIOS ★ The mean of per-pair ratios is
   * dominated by the slowest pairs, where the denominator is smallest — the
   * same trap `minSpeedMps` guards against, arriving by another route. Summing
   * first weights each pair by the speed it was observed at, which is also the
   * speed at which an error costs distance.
   */
  scaleAt(tMs: number): number {
    if (this.measured.length < this.config.minObservations) return 1;
    if (this.lastObservedT !== null && tMs - this.lastObservedT > this.config.maxAgeMs) return 1;
    let sm = 0;
    let sp = 0;
    for (let i = 0; i < this.measured.length; i++) {
      sm += this.measured[i]!;
      sp += this.predicted[i]!;
    }
    if (!(sp > 1e-6)) return 1;
    const raw = sm / sp;
    if (!Number.isFinite(raw)) return 1;
    return Math.max(this.config.minScale, Math.min(this.config.maxScale, raw));
  }

  stateAt(tMs: number): SpeedCalibratorState {
    const scale = this.scaleAt(tMs);
    return {
      scale,
      observations: this.measured.length,
      active: this.measured.length >= this.config.minObservations && scale !== 1,
      trusted: this.isTrusted(tMs),
      rawRatio: this.rawRatioAt(tMs),
      correlation: this.correlationAt().r,
    };
  }

  reset(): void {
    this.measured.length = 0;
    this.predicted.length = 0;
    this.lastObservedT = null;
  }
}
