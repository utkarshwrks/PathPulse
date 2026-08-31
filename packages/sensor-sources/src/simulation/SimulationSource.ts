import type { SensorSample } from '@pathpulse/nav-core';
import type { SensorSource, SensorSourceCapabilities } from '../types.js';
import { RoutePath, type RouteGeoJson } from './route.js';
import { VehicleModel, CITY_VEHICLE, type VehicleConfig } from './vehicle.js';
import { PHONE_MEMS_NOISE, synthesizeImu, type ImuNoiseConfig } from './imu.js';
import { createGaussian } from './rng.js';

export interface SimulationOptions {
  route: RouteGeoJson;
  vehicle?: VehicleConfig;
  noise?: ImuNoiseConfig;
  imuRateHz?: number;
  gnssRateHz?: number;
  /** 1-sigma GNSS horizontal error, metres. */
  gnssAccuracyM?: number;
  seed?: number;
  /** Restart from the beginning when the route ends. */
  loop?: boolean;
}

interface OutageWindow {
  startMs: number;
  endMs: number;
}

/**
 * A virtual vehicle driving a route, emitting realistic sensor samples.
 *
 * ★ The physics here is pure and deterministic — same seed, same samples.
 * Nothing in this class touches a browser API; `start()` takes its clock from
 * the injected scheduler. That is what lets the eval harness (Phase 7) replay
 * an identical drive headlessly, and lets nav-core tests drive a full outage
 * in microseconds instead of waiting a real minute.
 *
 * Development runs against this, not a phone: a browser refresh is one second,
 * an APK rebuild is three minutes.
 */
export class SimulationSource implements SensorSource {
  readonly capabilities: SensorSourceCapabilities;

  private readonly route: RoutePath;
  private readonly vehicle: VehicleModel;
  private readonly noise: ImuNoiseConfig;
  private readonly gaussian: () => number;
  private readonly imuIntervalMs: number;
  private readonly gnssIntervalMs: number;
  private readonly gnssAccuracyM: number;
  private readonly opts: SimulationOptions;

  private listeners: Array<(s: SensorSample) => void> = [];
  private tMs = 0;
  private nextGnssAtMs = 0;
  private outages: OutageWindow[] = [];
  private running = false;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private playbackRate = 1;
  /**
   * Simulated time asked for but not yet spent, carried between `advance()`
   * calls.
   *
   * ★ THE DEMO DESYNC THIS EXISTS TO END ★
   * `advance()` consumes whole IMU steps and used to discard the remainder.
   * The wall timer asks for 50 ms and the step is 20 ms, so it spent 40 and
   * threw 10 away — every tick, for ever. The simulation ran at 0.8× real
   * time: 64 s of driving in 80 s of demo.
   *
   * That is invisible until something else keeps real time, and the scripted
   * demo does. `useDemoMode` fires the outage on a wall clock at 15 s, but the
   * outage's own 60 s is simulated time, so GNSS came back at 90 s of wall
   * clock while the banner announced the recovery at 75 s. The last five
   * seconds of every demo narrated a fix return that had not happened: the
   * banner read "the marker slides back, the drift is measured" over a screen
   * still saying DEAD RECKONING with no drift on it.
   *
   * Keeping the remainder costs one number and makes simulated time track the
   * time actually requested.
   */
  private carryMs = 0;

  constructor(options: SimulationOptions) {
    this.opts = options;
    this.route = new RoutePath(options.route);
    this.vehicle = new VehicleModel(this.route, options.vehicle ?? CITY_VEHICLE);
    this.noise = options.noise ?? PHONE_MEMS_NOISE;
    this.gaussian = createGaussian(options.seed ?? 1337);
    this.imuIntervalMs = 1000 / (options.imuRateHz ?? 50);
    this.gnssIntervalMs = 1000 / (options.gnssRateHz ?? 1);
    this.gnssAccuracyM = options.gnssAccuracyM ?? 4.2;

    this.capabilities = {
      hasGnss: true,
      hasImu: true,
      hasBaro: false,
      imuRateHz: options.imuRateHz ?? 50,
      gnssRateHz: options.gnssRateHz ?? 1,
      name: `Simulation — ${this.route.name}`,
    };
  }

  onSample(cb: (s: SensorSample) => void): void {
    this.listeners.push(cb);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.scheduleTimer();
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  reset(): void {
    this.stop();
    this.tMs = 0;
    this.nextGnssAtMs = 0;
    this.outages = [];
    // Rebuilding is simpler than unwinding vehicle state, and guarantees a
    // reset run is bit-identical to a fresh one.
    const fresh = new SimulationSource(this.opts);
    Object.assign(this, fresh, { listeners: this.listeners });
  }

  /** Playback multiplier, 1x-5x. Affects wall-clock pace, not sample spacing. */
  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.1, Math.min(10, rate));
    if (this.running) {
      this.scheduleTimer();
    }
  }

  get playbackRateValue(): number {
    return this.playbackRate;
  }

  get elapsedMs(): number {
    return this.tMs;
  }

  get progressFraction(): number {
    return this.route.lengthM > 0 ? this.vehicle.current.s / this.route.lengthM : 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Hide GNSS for a window of simulated time — the tunnel.
   * Times are relative to simulation start, not wall clock.
   */
  simulateGnssOutage(startMs: number, durationMs: number): void {
    this.outages.push({ startMs, endMs: startMs + durationMs });
  }

  /** Begin an outage right now, for the demo button. */
  startOutageNow(durationMs = 60_000): void {
    this.simulateGnssOutage(this.tMs, durationMs);
  }

  clearOutages(): void {
    this.outages = [];
  }

  isInOutage(tMs = this.tMs): boolean {
    return this.outages.some((o) => tMs >= o.startMs && tMs < o.endMs);
  }

  /**
   * Advance simulated time and emit every sample due in that span.
   *
   * This is the pure entry point. Tests call it directly to run a 60-second
   * drive instantly; `start()` just calls it on a timer.
   */
  advance(simDtMs: number): SensorSample[] {
    const emitted: SensorSample[] = [];
    // Whatever the last call could not spend is spent now. Callers that pass
    // whole multiples of the IMU step — the tests and the eval harness — never
    // accumulate a remainder, so this changes nothing for them.
    let remaining = simDtMs + this.carryMs;

    while (remaining >= this.imuIntervalMs) {
      const step = this.imuIntervalMs;
      remaining -= step;
      this.tMs += step;

      const state = this.vehicle.step(step);

      if (state.finished && !this.opts.loop) {
        const sample = this.buildSample();
        emitted.push(sample);
        this.emit(sample);
        this.stop();
        // The route is over; a carried remainder would only be spent by a
        // caller that restarts, which resets this anyway.
        remaining = 0;
        break;
      }

      const sample = this.buildSample();
      emitted.push(sample);
      this.emit(sample);
    }

    this.carryMs = remaining;
    return emitted;
  }

  private buildSample(): SensorSample {
    const state = this.vehicle.current;
    const imu = synthesizeImu(state, this.tMs, this.noise, this.gaussian);
    const sample: SensorSample = { t: this.tMs, imu };

    if (this.tMs >= this.nextGnssAtMs) {
      this.nextGnssAtMs += this.gnssIntervalMs;
      // Inside an outage the GNSS field is simply absent — the same shape the
      // engine sees in a real tunnel. It is never zeroed or faked.
      if (!this.isInOutage()) {
        const truth = this.route.latLonAt(state.s);
        // Position noise scaled to the reported accuracy figure.
        const dLat = (this.gnssAccuracyM * this.gaussian() * 0.5) / 111_132;
        const dLon =
          (this.gnssAccuracyM * this.gaussian() * 0.5) /
          (111_320 * Math.cos((truth.lat * Math.PI) / 180));
        sample.gnss = {
          lat: truth.lat + dLat,
          lon: truth.lon + dLon,
          accuracyM: this.gnssAccuracyM,
          speedMps: Math.max(0, state.speedMps + 0.15 * this.gaussian()),
          headingDeg: state.headingDeg,
          satCount: 17,
          meanCn0: 34.2,
          // A plausible sky over the Indian subcontinent: NavIC's regional
          // constellation is only visible here, which is the point of showing
          // it. These numbers are INVENTED — the simulator is the only source
          // that can produce them at all, because the Capacitor WebView
          // exposes no per-constellation data (Phase 15's native GnssStatus
          // does). Anything rendering them must label them simulated; see
          // nav-core/src/gnss/constellations.ts.
          constellations: { GPS: 7, NAVIC: 4, GALILEO: 3, GLONASS: 2, BEIDOU: 1 },
          constellationsSimulated: true,
        };
      }
    }

    return sample;
  }

  private emit(sample: SensorSample): void {
    for (const cb of this.listeners) cb(sample);
  }

  /**
   * The only impure part of the class, and it is isolated here: a timer that
   * calls `advance()`. Node and the browser both provide setInterval, so this
   * needs no DOM.
   */
  private scheduleTimer(): void {
    if (this.timerId !== null) clearInterval(this.timerId);
    const wallTickMs = 50;
    /**
     * ★ ADVANCE BY THE TIME THAT PASSED, NOT THE TIME WE ASKED FOR ★
     * `setInterval(50)` is a request, not a promise. On a phone rendering a
     * map it lands late, and assuming it landed on time slows simulated time
     * against the wall clock the demo script is counting on. Measuring the gap
     * means a late tick costs smoothness rather than sequence — the same
     * reason `useDemoMode` reads elapsed time instead of counting ticks.
     */
    let last = Date.now();
    this.timerId = setInterval(() => {
      if (!this.running) return;
      const now = Date.now();
      const wallDtMs = Math.max(0, now - last);
      last = now;
      // A backgrounded tab throttles this timer to a second or more, and a
      // sleeping phone stops it entirely. Catching up on the whole gap would
      // teleport the vehicle down the route on return, so a long freeze is
      // treated as a pause. The cap is generous enough to absorb ordinary
      // jank, which is what actually needs absorbing.
      const maxCatchUpMs = wallTickMs * 5;
      this.advance(Math.min(wallDtMs, maxCatchUpMs) * this.playbackRate);
    }, wallTickMs);
  }
}
