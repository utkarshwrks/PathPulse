import type { SensorSample } from '@pathpulse/nav-core';
import type { SensorSource, SensorSourceCapabilities } from '../types.js';

/**
 * Capacitor-backed sensors for the Android APK.
 *
 * Behind the same SensorSource interface as everything else, so nothing
 * downstream — and certainly nothing in nav-core — knows or cares that the
 * samples now come from a native plugin.
 *
 * The Capacitor modules are imported lazily. This file is bundled into the web
 * build too, and a top-level import would drag native plugin code into the
 * browser bundle and break `next build`.
 */
export class NativeSource implements SensorSource {
  private listeners: Array<(s: SensorSample) => void> = [];
  private running = false;
  private startedAt = 0;
  private watchId: string | null = null;
  private accelHandle: { remove: () => Promise<void> } | null = null;
  private orientationHandle: { remove: () => Promise<void> } | null = null;

  private latestImu: SensorSample['imu'] | undefined;
  private imuCount = 0;
  private gnssCount = 0;

  readonly capabilities: SensorSourceCapabilities = {
    hasGnss: true,
    hasImu: true,
    hasBaro: false,
    // @capacitor/motion is a thin wrapper over the WebView's DeviceMotionEvent,
    // so the rate is whatever the WebView allows — not SENSOR_DELAY_FASTEST.
    // Phase 15 replaces this with a native Kotlin SensorManager loop.
    imuRateHz: 60,
    gnssRateHz: 1,
    name: 'Native (Capacitor)',
  };

  /** True only inside the APK; the web build falls back to WebSource. */
  static async isAvailable(): Promise<boolean> {
    try {
      const { Capacitor } = await import('@capacitor/core');
      return Capacitor.isNativePlatform();
    } catch {
      return false;
    }
  }

  onSample(cb: (s: SensorSample) => void): void {
    this.listeners.push(cb);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    const { Geolocation } = await import('@capacitor/geolocation');
    const { Motion } = await import('@capacitor/motion');

    // Ask explicitly rather than letting the first watch call trigger it —
    // a denial should surface as a clear state, not a silent absence of fixes.
    try {
      const perm = await Geolocation.requestPermissions();
      if (perm.location === 'denied') {
        this.capabilities.hasGnss = false;
      }
    } catch {
      this.capabilities.hasGnss = false;
    }

    try {
      this.accelHandle = await Motion.addListener('accel', (event) => {
        const acc = event.accelerationIncludingGravity;
        const rot = event.rotationRate;
        this.imuCount++;
        this.latestImu = {
          ax: acc?.x ?? 0,
          ay: acc?.y ?? 0,
          az: acc?.z ?? 0,
          // Motion reports deg/s; nav-core works in rad/s everywhere.
          gx: ((rot?.beta ?? 0) * Math.PI) / 180,
          gy: ((rot?.gamma ?? 0) * Math.PI) / 180,
          gz: ((rot?.alpha ?? 0) * Math.PI) / 180,
        };
        this.emit({ t: Date.now() - this.startedAt, imu: this.latestImu });
      });
    } catch {
      this.capabilities.hasImu = false;
    }

    if (this.capabilities.hasGnss) {
      try {
        this.watchId = await Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
          (position, err) => {
            if (err || !position) return;
            this.gnssCount++;
            const c = position.coords;
            this.emit({
              t: Date.now() - this.startedAt,
              imu: this.latestImu,
              gnss: {
                lat: c.latitude,
                lon: c.longitude,
                accuracyM: c.accuracy,
                speedMps: c.speed ?? undefined,
                headingDeg: c.heading ?? undefined,
              },
            });
          },
        );
      } catch {
        this.capabilities.hasGnss = false;
      }
    }
  }

  stop(): void {
    this.running = false;
    void this.accelHandle?.remove();
    void this.orientationHandle?.remove();
    this.accelHandle = null;
    this.orientationHandle = null;
    if (this.watchId) {
      void import('@capacitor/geolocation').then(({ Geolocation }) =>
        Geolocation.clearWatch({ id: this.watchId! }),
      );
      this.watchId = null;
    }
  }

  /** Measured, never hardcoded — the HUD has to be able to prove the rate. */
  get measuredRates(): { imuHz: number; gnssHz: number } {
    const elapsedS = (Date.now() - this.startedAt) / 1000 || 1;
    return { imuHz: this.imuCount / elapsedS, gnssHz: this.gnssCount / elapsedS };
  }

  private emit(sample: SensorSample): void {
    for (const cb of this.listeners) cb(sample);
  }
}
