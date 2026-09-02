# edge-engine — the edge-deployable software engine (Phase 16)

The same `nav-core` that runs inside the Android app, running **outside a
phone**, against an external inertial stream, at rates a handset cannot reach.

> SIH26168: *"The final deliverable must be a working mobile application **and**
> an Edge deployable software engine."*
>
> It is "and", not "or". This package is the second half.

```
nav-core (pure TypeScript)
   ├─→ Capacitor APK      phone MEMS,   ~10 Hz
   └─→ Node edge engine   external IMU, ~200 Hz
```

**This package contains no navigation mathematics of its own.** That is the
whole point. It is adapters, a driven loop, and a report; every line of
estimation is the code the handset runs. Golden Rule #1 — `nav-core` never
takes a browser dependency — is what made this a port rather than a rewrite.

## Run it

```bash
pnpm --filter @pathpulse/edge-engine edge -- --grade FOG --rate 200 --seconds 60 --gnss 1000
pnpm --filter @pathpulse/edge-engine edge -- --replay ../../data/replay/sim_city_4242.jsonl --rate 200
pnpm --filter @pathpulse/edge-engine edge -- --list-grades
pnpm --filter @pathpulse/edge-engine bench      # the three-grade comparison
```

| Option | Meaning |
| --- | --- |
| `--grade` | `PHONE_MEMS` \| `TACTICAL` \| `FOG` (default `FOG`) |
| `--rate` | target output rate, Hz (default: the grade's nominal rate) |
| `--seconds` | how much stream to generate (default 60) |
| `--replay` | a `.jsonl` or `.csv` recording instead of the simulator |
| `--gnss` | emit a simulated fix every N ms; `0` = pure INS |
| `--json` | write every `NavigationState` as JSON lines |

## Measured on this machine

```
pathpulse-edge · Fibre-optic gyro · target 200 Hz

samples processed         12000
stream duration           60.0 s
wall-clock time           0.163 s
SUSTAINED RATE            73573 Hz
real-time factor          368x
mean update latency       0.0132 ms
p99 update latency        0.0474 ms
final mode                GNSS
distance travelled        1006.4 m
```

The per-update budget at 200 Hz is 5 ms; the estimator uses ~0.013 ms of it.

**What that claim is, precisely:** `meanLatencyMs` times `engine.update()`
alone. It excludes reading a serial port or a socket, because those are
properties of somebody's hardware and would make the figure unreproducible. So
the supported claim is *"the estimator is not the bottleneck"*. Whether a given
IMU can be **read** at 200 Hz is a question about that IMU.

## Sensor grades

Generated into [`docs/edge-benchmarks.md`](../../docs/edge-benchmarks.md) by
`pnpm bench`. Only the noise and bias model changes between rows.

| Grade | Rate | Gyro bias | Drift % | Heading err |
| --- | --- | --- | --- | --- |
| Phone MEMS | 50 Hz | 206 °/hr | 26.4 | 3.08° |
| Tactical | 100 Hz | 2 °/hr | 20.3 | 0.05° |
| Fibre-optic gyro | 200 Hz | 0.001 °/hr | 15.0 | 0.08° |

> ⚠️ **Every row is SIMULATED.** We do not own a fibre-optic or tactical-grade
> IMU — they cost several lakh rupees, and the requirement is to support that
> class of *data*, not to possess the hardware. Those rows are datasheet-class
> noise models. They demonstrate that sensor grade is a **configuration** of
> this engine; they are not a measurement of any real external IMU.

Read the heading column, not the total. Along-track error comes from not
knowing the speed, and no gyroscope fixes that — unaided, it is the same
problem at every grade. Heading comes from the gyroscope, and that is where
three orders of magnitude of bias show up: 3.08° → 0.05°.

## Feeding it real hardware

Implement `EdgeSource` — three methods, no framework:

```ts
export interface EdgeSource {
  readonly name: string;
  open?(): Promise<void> | void;
  next(tMs: number): Promise<SensorSample | null> | SensorSample | null;
  close?(): Promise<void> | void;
}
```

It is **pull**, not push, unlike the browser's `SensorSource`. In a browser the
sensors decide when they fire and the app reacts; off the phone the requirement
is to *sustain* a rate, so the engine owns the clock. That is also what lets a
replay run 368× faster than real time, which is what makes the benchmark
runnable in CI instead of only on a bench.

### CSV contract

Header row, case-insensitive: `t`/`time`/`timestamp` (ms), `ax,ay,az`
(m/s², **including gravity**), `gx,gy,gz` (rad/s, **right-hand rule**), and
optionally `lat,lon,acc`.

**Units are never sniffed.** A logger emitting deg/s or g would be wrong by a
factor of 57 or 9.81 and the estimator would produce confident nonsense. Pass
`--gyro-deg` / `--accel-g` to convert explicitly.

### The axis trap, recorded because we fell into it

`gz` is the **right-hand rule**, so a right turn about +Z is clockwise and
therefore **negative** — the convention `DeviceMotionEvent` and Android's
`SensorManager` already use. The simulator here first emitted a compass sense
instead. The estimator turned the wrong way and accumulated **135° of heading
error at every sensor grade**, which read as "sensor grade does not matter"
when it actually meant "the simulator lied about its axes". A test now pins it.

## Status

Built: the runner, the grade profiles, the simulator, JSONL/CSV replay, the
benchmark, 17 tests. Not built: serial and UDP adapters (the interface is
there and takes about an hour each once there is hardware to point at), and a
Docker image.
