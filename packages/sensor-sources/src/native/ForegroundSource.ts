import type { SensorSample } from '@pathpulse/nav-core';
import type { SensorSource, SensorSourceCapabilities } from '../types.js';

/**
 * Phase 15 — sensors from the native foreground service.
 *
 * ★ WHAT THIS FIXES ★
 *
 * `NativeSource` reads @capacitor/motion, which is a thin wrapper over the
 * WebView's own DeviceMotionEvent. When the screen goes off, Android throttles
 * that WebView: the 10 Hz stream falls to roughly 1 Hz and then stops. Dead
 * reckoning integrates what it is given, so a tenth of the samples is a tenth
 * of the evidence for every turn — and a real drive through a tunnel is not
 * done with the phone awake and unlocked in front of you.
 *
 * The native service collects at full rate inside a foreground service Android
 * will not throttle, buffers, and hands over batches. See the long note in
 * `SensorLoopService.java` for why batching is lossless here and why the
 * estimator did NOT need to be ported into an embedded JavaScript engine: the
 * engine is deterministic and driven by `sample.t`, so ten samples delivered
 * at once produce exactly the estimate that ten samples delivered at 10 Hz
 * would. The WebView does not need to RUN at 10 Hz; it needs to CONSUME 10 Hz.
 *
 * What is lost while the screen is off is the marker's refresh rate, and the
 * screen is off.
 */
export class ForegroundSource implements SensorSource {
  private listeners: Array<(s: SensorSample) => void> = [];
  private handle: { remove: () => Promise<void> } | null = null;
  private running = false;

  private imuCount = 0;
  private gnssCount = 0;
  private startedAt = 0;
  /** Whatever the native side last reported about itself. */
  private nativeStatus: Record<string, number | boolean> = {};

  readonly capabilities: SensorSourceCapabilities = {
    hasGnss: true,
    hasImu: true,
    hasBaro: false,
    // A request of 100 Hz to SensorManager, which treats it as a hint. The
    // measured figure is reported live by `status` and by the debug panel;
    // this is only the label.
    imuRateHz: 100,
    gnssRateHz: 1,
    name: 'Native foreground service',
  };

  /**
   * True only when the APK carries the Phase 15 plugin.
   *
   * ★ CHECKED, NOT ASSUMED ★ An older APK on a phone that has been updated
   * from the web build has @capacitor/core and no PathPulseSensors, and a
   * source that assumed otherwise would start, receive nothing, and leave the
   * app looking broken with no explanation.
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return false;
      if (!Capacitor.isPluginAvailable('PathPulseSensors')) return false;
      const plugin = (Capacitor as unknown as { Plugins: Record<string, unknown> }).Plugins?.[
        'PathPulseSensors'
      ] as { capabilities?: () => Promise<{ available?: boolean }> } | undefined;
      if (!plugin?.capabilities) return false;
      const caps = await plugin.capabilities();
      return caps?.available === true;
    } catch {
      return false;
    }
  }

  onSample(cb: (s: SensorSample) => void): void {
    this.listeners.push(cb);
  }

  private emit(sample: SensorSample): void {
    for (const cb of this.listeners) cb(sample);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isPluginAvailable('PathPulseSensors')) {
      throw new Error('PathPulseSensors plugin is not in this build');
    }

    const plugin = registerPlugin<{
      start(): Promise<{ started: boolean }>;
      stop(): Promise<void>;
      capabilities(): Promise<{ hasGyroscope?: boolean; hasBarometer?: boolean }>;
      addListener(
        event: 'sensorBatch',
        handler: (payload: {
          samples: Array<Record<string, unknown>>;
          status: Record<string, number | boolean>;
        }) => void,
      ): Promise<{ remove: () => Promise<void> }>;
    }>('PathPulseSensors');

    const caps = await plugin.capabilities();
    // Absent means "not measured yet"; false means "this phone has none", and
    // the two must not be confused — a straight line drawn through every
    // corner because the gyro is missing has to be explainable on screen.
    this.capabilities.hasGyro = caps.hasGyroscope;
    this.capabilities.hasBaro = caps.hasBarometer === true;

    this.handle = await plugin.addListener('sensorBatch', ({ samples, status }) => {
      this.nativeStatus = status ?? {};
      for (const raw of samples ?? []) this.consume(raw);
    });

    await plugin.start();
    this.running = true;
    this.startedAt = Date.now();
  }

  /**
   * Turn one native record into a SensorSample.
   *
   * ★ EVERY FIELD IS CHECKED ★ This crosses a JSON bridge from Java, where a
   * Float that missed its overload arrives as the string "9.81". A silent NaN
   * entering the estimator is a position that flies off the map ten seconds
   * later with nothing to point at.
   */
  private consume(raw: Record<string, unknown>): void {
    const t = num(raw['t']);
    if (t === null) return;

    const sample: SensorSample = { t };

    const imu = raw['imu'] as Record<string, unknown> | undefined;
    if (imu) {
      const ax = num(imu['ax']);
      const ay = num(imu['ay']);
      const az = num(imu['az']);
      if (ax !== null && ay !== null && az !== null) {
        sample.imu = {
          ax,
          ay,
          az,
          gx: num(imu['gx']) ?? 0,
          gy: num(imu['gy']) ?? 0,
          gz: num(imu['gz']) ?? 0,
        };
        this.imuCount++;
        if (imu['hasGyro'] === true) this.capabilities.hasGyro = true;
      }
    }

    const baro = raw['baro'] as Record<string, unknown> | undefined;
    if (baro) {
      const pressureHpa = num(baro['pressureHpa']);
      // A phone barometer reports hectopascals; a value in the hundreds of
      // thousands is pascals and would be read as a hundred kilometres of
      // altitude change. Range-checked here as well as in the altimeter,
      // because a unit mix-up crossing a bridge is exactly the kind of thing
      // that gets fixed on one side and forgotten on the other.
      if (pressureHpa !== null && pressureHpa > 500 && pressureHpa < 1100) {
        sample.baro = { pressureHpa };
        this.capabilities.hasBaro = true;
      }
    }

    const gnss = raw['gnss'] as Record<string, unknown> | undefined;
    if (gnss) {
      const lat = num(gnss['lat']);
      const lon = num(gnss['lon']);
      const accuracyM = num(gnss['accuracyM']);
      if (lat !== null && lon !== null && accuracyM !== null) {
        const fix: NonNullable<SensorSample['gnss']> = { lat, lon, accuracyM };
        const speed = num(gnss['speedMps']);
        if (speed !== null) fix.speedMps = speed;
        const heading = num(gnss['headingDeg']);
        if (heading !== null) fix.headingDeg = heading;
        const sats = num(gnss['satCount']);
        if (sats !== null) fix.satCount = sats;
        // Phase 13's Model 4 reads both. Only this source can supply them:
        // the WebView reports a satellite count and nothing else.
        const meanCn0 = num(gnss['meanCn0']);
        if (meanCn0 !== null && meanCn0 > 0) fix.meanCn0 = meanCn0;
        const cn0Spread = num(gnss['cn0Spread']);
        if (cn0Spread !== null && cn0Spread >= 0) fix.cn0Spread = cn0Spread;

        const constellations = gnss['constellations'] as Record<string, unknown> | undefined;
        if (constellations) {
          const counts: Record<string, number> = {};
          for (const [key, value] of Object.entries(constellations)) {
            const n = num(value);
            if (n !== null) counts[key] = n;
          }
          if (Object.keys(counts).length > 0) {
            fix.constellations = counts;
            // ★ MEASURED, AND SAYING SO ★ This is the only source in the
            // project that can set this false honestly. Everything else has to
            // label its breakdown simulated, because the WebView reports a
            // count and nothing more — and inventing a NavIC number for an
            // ISRO-sponsored problem statement is the worst thing this app
            // could be caught doing.
            fix.constellationsSimulated = false;
          }
        }
        sample.gnss = fix;
        this.gnssCount++;
      }
    }

    if (sample.imu || sample.gnss || sample.baro) this.emit(sample);
  }

  /** Live counters, including the rate the NATIVE side measured for itself. */
  get status(): {
    running: boolean;
    imuCount: number;
    gnssCount: number;
    measuredImuHz: number;
    nativeImuHz: number;
    droppedSamples: number;
  } {
    const elapsedS = this.startedAt === 0 ? 0 : (Date.now() - this.startedAt) / 1000;
    return {
      running: this.running,
      imuCount: this.imuCount,
      gnssCount: this.gnssCount,
      measuredImuHz: elapsedS > 0 ? this.imuCount / elapsedS : 0,
      // ★ THE NUMBER THE PHASE EXISTS TO MOVE ★ Measured inside the service,
      // so a rate that collapses when the screen goes off shows up here rather
      // than being described as "should be fine". The web-side figure cannot
      // see it: if the WebView is asleep, so is the code that would count.
      nativeImuHz: Number(this.nativeStatus['imuRateHz'] ?? 0),
      droppedSamples: Number(this.nativeStatus['droppedSamples'] ?? 0),
    };
  }

  stop(): void {
    this.running = false;
    void this.handle?.remove();
    this.handle = null;
    void (async () => {
      try {
        const { registerPlugin } = await import('@capacitor/core');
        await registerPlugin<{ stop(): Promise<void> }>('PathPulseSensors').stop();
      } catch {
        // Already gone, or never there. Stopping twice must not throw.
      }
    })();
  }
}

/** A number, or null — never NaN, and never a string that looks like one. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
