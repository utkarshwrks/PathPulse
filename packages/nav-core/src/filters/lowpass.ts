/**
 * Second-order Butterworth low-pass, direct form II transposed.
 *
 * Removes engine and road vibration (15-25 Hz) while passing real vehicle
 * dynamics, which live below about 2 Hz. Butterworth specifically because it
 * is maximally flat in the passband — a filter with ripple would distort the
 * very accelerations we are about to integrate twice.
 */
export class LowPassFilter {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;
  private primed = false;

  constructor(
    private readonly cutoffHz = 5,
    private sampleRateHz = 50,
  ) {
    this.design();
  }

  /**
   * Re-tune for a different sample rate.
   *
   * ★ THE ASSUMED RATE IS NOT THE REAL RATE ★
   * These coefficients are derived from the sample rate, so a filter designed
   * for 50 Hz and fed 14 Hz is not a 5 Hz low-pass any more — its effective
   * cutoff falls to 5 x (14/50) = 1.4 Hz, which smooths away real vehicle
   * dynamics and adds lag to a signal that is about to be integrated twice.
   *
   * That is not hypothetical: field testing measured the IMU arriving at
   * anywhere between 14 and 60 Hz on the same handset, because the WebView
   * throttles DeviceMotion. Tracking the observed rate keeps the filter doing
   * what it says it does.
   *
   * Coefficients only, so the filter state is preserved and re-tuning does not
   * produce a transient.
   */
  setSampleRate(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0) return;
    if (Math.abs(hz - this.sampleRateHz) / this.sampleRateHz < 0.2) return;
    this.sampleRateHz = hz;
    this.design();
  }

  private design(): void {
    // Bilinear transform with frequency pre-warping.
    const nyquist = this.sampleRateHz / 2;
    const fc = Math.min(this.cutoffHz, nyquist * 0.99);
    const omega = Math.tan((Math.PI * fc) / this.sampleRateHz);
    const sqrt2 = Math.SQRT2;
    const norm = 1 / (1 + sqrt2 * omega + omega * omega);

    this.b0 = omega * omega * norm;
    this.b1 = 2 * this.b0;
    this.b2 = this.b0;
    this.a1 = 2 * (omega * omega - 1) * norm;
    this.a2 = (1 - sqrt2 * omega + omega * omega) * norm;
  }

  push(value: number): number {
    if (!Number.isFinite(value)) return this.z1;
    if (!this.primed) {
      // Start settled at the first sample instead of ramping up from zero,
      // which would otherwise inject a fake acceleration transient at startup.
      this.z1 = value * (1 - this.b0);
      this.z2 = value * (1 - this.b0 - this.b1 + this.a1);
      this.primed = true;
    }
    const out = this.b0 * value + this.z1;
    this.z1 = this.b1 * value - this.a1 * out + this.z2;
    this.z2 = this.b2 * value - this.a2 * out;
    return out;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
    this.primed = false;
  }
}

/** Three independent low-pass filters, one per axis. */
export class Vec3LowPassFilter {
  private readonly x: LowPassFilter;
  private readonly y: LowPassFilter;
  private readonly z: LowPassFilter;

  constructor(cutoffHz = 5, sampleRateHz = 50) {
    this.x = new LowPassFilter(cutoffHz, sampleRateHz);
    this.y = new LowPassFilter(cutoffHz, sampleRateHz);
    this.z = new LowPassFilter(cutoffHz, sampleRateHz);
  }

  /** Re-tune all three axes. See LowPassFilter.setSampleRate. */
  setSampleRate(hz: number): void {
    this.x.setSampleRate(hz);
    this.y.setSampleRate(hz);
    this.z.setSampleRate(hz);
  }

  push(x: number, y: number, z: number): [number, number, number] {
    return [this.x.push(x), this.y.push(y), this.z.push(z)];
  }

  reset(): void {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }
}
