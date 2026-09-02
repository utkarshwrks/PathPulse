import type { SensorSample } from '@pathpulse/nav-core';

/**
 * One interface, four implementations:
 *   SimulationSource - a virtual vehicle; pure physics, usable in nav-core tests
 *   WebSource        - DeviceMotion + navigator.geolocation
 *   NativeSource     - Capacitor plugins on Android (Phase 3)
 *   ReplaySource     - a recorded JSONL log, replayed with original timing
 *
 * Swapping the source must never require touching nav-core. This package MAY
 * use browser APIs; nav-core may not.
 */
export interface SensorSourceCapabilities {
  hasGnss: boolean;
  hasImu: boolean;
  /**
   * Whether the platform is actually delivering rotation rate.
   *
   * ★ THE SILENT FAILURE THIS EXISTS TO END ★
   * `DeviceMotionEvent.rotationRate` is null on a WebView that exposes no
   * gyroscope, and both live sources read it as `rot?.alpha ?? 0`. Zero is a
   * perfectly valid yaw rate, so the engine integrated "not turning" for the
   * whole outage and dead reckoning drew a dead straight line however hard the
   * vehicle cornered — with nothing on screen saying why.
   *
   * Undefined until the first motion event decides it: absent means "not
   * measured yet", never "no gyroscope".
   */
  hasGyro?: boolean;
  hasBaro: boolean;
  imuRateHz: number;
  gnssRateHz: number;
  name: string;
}

export interface SensorSource {
  start(): Promise<void>;
  stop(): void;
  onSample(cb: (s: SensorSample) => void): void;
  readonly capabilities: SensorSourceCapabilities;
}
