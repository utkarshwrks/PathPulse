/**
 * Barometric altitude, for the one job it is actually good at.
 *
 * ★ WHAT A PHONE BAROMETER CAN AND CANNOT DO ★
 *
 * It cannot tell you your altitude. Sea-level pressure moves by tens of
 * hectopascals with the weather, which is hundreds of metres of apparent
 * height, and the sensor has no way to know today's value. Any absolute
 * altitude from a phone barometer is a guess dressed as a measurement.
 *
 * What it is superb at is CHANGE over minutes. The relative resolution is
 * around 0.1 hPa, roughly a metre, and weather does not move meaningfully
 * inside a thirty-second window. So "you have just risen six metres" is a
 * reliable statement where "you are at 218 m" is not.
 *
 * That is exactly the shape of the two things the estimator wants:
 *
 *   - The ESKF's altitude update, which constrains the vertical channel that
 *     otherwise random-walks on accelerometer bias.
 *   - Phase 14's flyover disambiguation. A flyover and the road beneath it are
 *     the same point on a map; the difference is five or six metres of height,
 *     acquired over about twenty seconds of ramp.
 *
 * So this reports height relative to a slowly-tracked reference, never an
 * absolute one, and says so in the type.
 */

export interface AltimeterConfig {
  /**
   * Time constant of the reference pressure, ms.
   *
   * ★ THE ONE PARAMETER, AND THE TRADE IT MAKES ★
   * The reference has to drift, or a two-hour drive accumulates the day's
   * whole weather change as apparent climb. It must not drift quickly, or a
   * genuine climb is absorbed into the reference and disappears — which is the
   * same mistake the acceleration high-pass would make with too short a time
   * constant, and the same fix.
   *
   * Ten minutes: far longer than a flyover ramp or a multi-storey car park,
   * far shorter than a weather front.
   */
  referenceTauMs: number;
  /**
   * Samples before the reference is trusted at all.
   *
   * The first reading of a barometer that has just powered on is frequently
   * wrong by several hPa while it settles.
   */
  warmupSamples: number;
  /** Readings outside this range are not atmospheric pressure. */
  minPressureHpa: number;
  maxPressureHpa: number;
}

export const DEFAULT_ALTIMETER_CONFIG: AltimeterConfig = {
  referenceTauMs: 600_000,
  warmupSamples: 10,
  // 870 hPa is a severe hurricane; 1085 is the highest ever recorded. Anything
  // outside is a broken sensor or a unit mix-up, and treating a pascal value
  // as hectopascals would report a hundred kilometres of altitude change.
  minPressureHpa: 500,
  maxPressureHpa: 1100,
};

export interface AltimeterReading {
  /** Metres relative to the tracked reference. Positive is up. NOT absolute. */
  relativeM: number;
  /** Metres climbed or descended over the recent window. Drives flyovers. */
  changeM: number;
  /** False until the sensor has settled and a reference exists. */
  isReady: boolean;
}

const NOT_READY: AltimeterReading = { relativeM: 0, changeM: 0, isReady: false };

/**
 * The barometric formula, linearised about the reference.
 *
 * The full hypsometric equation is exact and pointless here: over the ±100 m
 * this is ever asked about, the linearisation is accurate to a few
 * centimetres, and it cannot produce a NaN from a pressure ratio that a
 * settling sensor briefly reports as negative.
 *
 * 8.434 m per hPa at sea level, from dh = -RT/(Mg) * dp/p.
 */
const METRES_PER_HPA = 8.434;

export class BarometricAltimeter {
  private config: AltimeterConfig;
  private reference: number | null = null;
  private samples = 0;
  private lastPressure = Number.NaN;
  private lastT: number | null = null;
  /**
   * Recent (time, pressure) pairs, oldest first.
   *
   * ★ WHY A HISTORY AND NOT TWO POINTS ★
   * The first version kept a single "pressure a window ago" and replaced it
   * whenever the window expired. That is a sawtooth: the moment the window
   * rolls over, the reference becomes the CURRENT pressure and the change term
   * collapses to zero — in the middle of the very ramp it is supposed to
   * detect. Measured on a simulated six-metre flyover it reported 0.6 m.
   *
   * A short history costs a few hundred bytes and gives a continuous answer:
   * the change is always measured against the reading closest to a full window
   * ago, whenever that was.
   */
  private readonly history: Array<{ t: number; p: number }> = [];

  constructor(config: Partial<AltimeterConfig> = {}) {
    this.config = { ...DEFAULT_ALTIMETER_CONFIG, ...config };
  }

  setConfig(patch: Partial<AltimeterConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  get isReady(): boolean {
    return this.reference !== null && this.samples >= this.config.warmupSamples;
  }

  push(pressureHpa: number, tMs: number, changeWindowMs = 20_000): AltimeterReading {
    if (
      !Number.isFinite(pressureHpa) ||
      pressureHpa < this.config.minPressureHpa ||
      pressureHpa > this.config.maxPressureHpa ||
      !Number.isFinite(tMs)
    ) {
      return this.isReady ? this.read(this.lastPressure, changeWindowMs) : NOT_READY;
    }

    this.samples++;
    this.lastPressure = pressureHpa;

    if (this.reference === null) {
      this.reference = pressureHpa;
      this.lastT = tMs;
      this.history.push({ t: tMs, p: pressureHpa });
      return NOT_READY;
    }

    // Drift the reference toward the current pressure, slowly. The alpha comes
    // from the elapsed time since the LAST SAMPLE — a separate quantity from
    // the change window, which the first version conflated with it.
    const dtMs = this.lastT === null ? 0 : Math.max(0, tMs - this.lastT);
    this.lastT = tMs;
    const alpha = Math.min(0.05, Math.max(0, dtMs / this.config.referenceTauMs));
    this.reference += alpha * (pressureHpa - this.reference);

    this.history.push({ t: tMs, p: pressureHpa });
    // Keep one full window plus a little, and never more than a few hundred
    // entries however fast the sensor is polled.
    while (
      this.history.length > 2 &&
      (tMs - this.history[0]!.t > changeWindowMs * 1.5 || this.history.length > 400)
    ) {
      this.history.shift();
    }

    return this.read(pressureHpa, changeWindowMs);
  }

  private read(pressureHpa: number, changeWindowMs: number): AltimeterReading {
    if (this.reference === null || this.samples < this.config.warmupSamples) return NOT_READY;

    // The oldest reading still inside the window — i.e. the furthest back we
    // can honestly compare against.
    const now = this.history[this.history.length - 1]?.t ?? 0;
    let past = this.history[0];
    for (const entry of this.history) {
      if (now - entry.t <= changeWindowMs) {
        past = entry;
        break;
      }
    }

    return {
      // Pressure FALLS as you rise, hence the sign.
      relativeM: (this.reference - pressureHpa) * METRES_PER_HPA,
      changeM: past ? (past.p - pressureHpa) * METRES_PER_HPA : 0,
      isReady: true,
    };
  }

  reset(): void {
    this.reference = null;
    this.samples = 0;
    this.lastPressure = Number.NaN;
    this.lastT = null;
    this.history.length = 0;
  }
}
