import type { SensorSample } from '@pathpulse/nav-core';
import type { SensorSource, SensorSourceCapabilities } from '../types.js';

/**
 * Real browser sensors: DeviceMotion for IMU, Geolocation for GNSS.
 *
 * Browser IMU has hard limits that the native Capacitor source (Phase 3) does
 * not: no satellite metadata, throttled rates, and an iOS permission model
 * that requires a user gesture. Those are reported honestly through
 * `capabilities` rather than papered over.
 */
export class WebSource implements SensorSource {
  private listeners: Array<(s: SensorSample) => void> = [];
  private running = false;
  private watchId: number | null = null;
  private startedAt = 0;

  private latestImu: SensorSample['imu'] | undefined;
  private pendingGnss: SensorSample['gnss'] | undefined;
  private imuCount = 0;
  private gnssCount = 0;

  private motionHandler: ((e: DeviceMotionEvent) => void) | null = null;

  readonly capabilities: SensorSourceCapabilities = {
    hasGnss: typeof navigator !== 'undefined' && !!navigator.geolocation,
    hasImu: typeof window !== 'undefined' && 'DeviceMotionEvent' in window,
    hasBaro: false,
    // Browsers cap DeviceMotion well below a native SENSOR_DELAY_FASTEST loop.
    imuRateHz: 60,
    gnssRateHz: 1,
    name: 'Live browser sensors',
  };

  onSample(cb: (s: SensorSample) => void): void {
    this.listeners.push(cb);
  }

  /**
   * iOS requires requestPermission() to be called from a user gesture, so
   * start() must be invoked from a click handler, never on mount.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    if (typeof window !== 'undefined' && 'DeviceMotionEvent' in window) {
      const DME = window.DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      };
      if (typeof DME.requestPermission === 'function') {
        try {
          const res = await DME.requestPermission();
          if (res !== 'granted') this.capabilities.hasImu = false;
        } catch {
          // Not a user gesture, or the user dismissed it. Degrade, do not throw.
          this.capabilities.hasImu = false;
        }
      }

      if (this.capabilities.hasImu) {
        this.motionHandler = (e: DeviceMotionEvent) => {
          const acc = e.accelerationIncludingGravity;
          const rot = e.rotationRate;
          if (!acc) return;
          this.imuCount++;
          this.latestImu = {
            ax: acc.x ?? 0,
            ay: acc.y ?? 0,
            az: acc.z ?? 0,
            // DeviceMotion reports deg/s; nav-core works in rad/s throughout.
            gx: ((rot?.beta ?? 0) * Math.PI) / 180,
            gy: ((rot?.gamma ?? 0) * Math.PI) / 180,
            gz: ((rot?.alpha ?? 0) * Math.PI) / 180,
          };
          // One sample stream: a fix that arrived since the last motion event
          // rides along here instead of being emitted as its own sample, which
          // would push this same IMU reading through every filter window twice.
          const gnss = this.pendingGnss;
          this.pendingGnss = undefined;
          this.emit({
            t: Date.now() - this.startedAt,
            imu: this.latestImu,
            ...(gnss ? { gnss } : {}),
          });
        };
        window.addEventListener('devicemotion', this.motionHandler);
      }
    }

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.gnssCount++;
          const c = pos.coords;
          const gnss = {
            lat: c.latitude,
            lon: c.longitude,
            accuracyM: c.accuracy,
            speedMps: typeof c.speed === 'number' && !Number.isNaN(c.speed) ? c.speed : undefined,
            headingDeg:
              typeof c.heading === 'number' && !Number.isNaN(c.heading) ? c.heading : undefined,
          };
          this.pendingGnss = gnss;
          // With no motion events the fix would queue forever. Emit it alone.
          if (!this.capabilities.hasImu) {
            this.pendingGnss = undefined;
            this.emit({ t: Date.now() - this.startedAt, gnss });
          }
        },
        () => {
          // Errors are surfaced by the UI's own geolocation hook; a source
          // must not tear itself down mid-drive over one bad fix.
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 },
      );
    }
  }

  stop(): void {
    this.running = false;
    if (this.motionHandler && typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', this.motionHandler);
      this.motionHandler = null;
    }
    if (this.watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  /** Measured rates, so the HUD never has to hardcode a number. */
  get measuredRates(): { imuHz: number; gnssHz: number } {
    const elapsedS = (Date.now() - this.startedAt) / 1000 || 1;
    return { imuHz: this.imuCount / elapsedS, gnssHz: this.gnssCount / elapsedS };
  }

  private emit(sample: SensorSample): void {
    for (const cb of this.listeners) cb(sample);
  }
}
