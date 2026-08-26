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
