import type { SensorSample } from '@pathpulse/nav-core';

/**
 * One interface, four implementations (Phase 2+):
 *   SimulationSource - a virtual vehicle, pure TS, usable inside nav-core tests
 *   WebSource        - DeviceMotion + navigator.geolocation
 *   NativeSource     - Capacitor plugins on Android
 *   ReplaySource     - a recorded JSONL log, replayed with original timing
 *
 * Swapping the source must never require touching nav-core.
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
