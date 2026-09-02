import { describe, expect, it } from 'vitest';
import {
  FogSimulatorSource,
  GRADES,
  gyroBiasDegPerHour,
  parseGrade,
  runEdge,
  type EdgeSource,
} from '../src/index.js';
import { parseCsv, parseJsonl } from '../src/sources/ReplayFileSource.js';
import type { SensorSample } from '@pathpulse/nav-core';

describe('IMU grades', () => {
  it('parses names case-insensitively and rejects unknown ones', () => {
    expect(parseGrade('fog')).toBe('FOG');
    expect(parseGrade('phone-mems')).toBe('PHONE_MEMS');
    expect(parseGrade('TACTICAL')).toBe('TACTICAL');
    expect(() => parseGrade('nonsense')).toThrow(/unknown IMU grade/);
  });

  it('orders the grades the way the hardware actually ranks', () => {
    // Every claim the comparison table makes rests on this ordering being
    // true of the profiles themselves, not just of the run that used them.
    const { PHONE_MEMS, TACTICAL, FOG } = GRADES;
    expect(PHONE_MEMS.gyroBiasRadS).toBeGreaterThan(TACTICAL.gyroBiasRadS);
    expect(TACTICAL.gyroBiasRadS).toBeGreaterThan(FOG.gyroBiasRadS);
    expect(PHONE_MEMS.accelBiasMps2).toBeGreaterThan(FOG.accelBiasMps2);
    expect(FOG.nominalRateHz).toBe(200); // the rate the PS names
  });

  it('reports FOG bias as the 0.001 deg/hr the guide quotes', () => {
    expect(gyroBiasDegPerHour(GRADES.FOG)).toBeCloseTo(0.001, 6);
    // And the handset is the ~200 deg/hr that makes unaided heading hopeless.
    expect(gyroBiasDegPerHour(GRADES.PHONE_MEMS)).toBeGreaterThan(100);
  });
});

describe('the simulated external IMU', () => {
  it('is deterministic — the same seed gives byte-identical samples', () => {
    const a = new FogSimulatorSource({ grade: 'FOG', periodMs: 5, seed: 7 });
    const b = new FogSimulatorSource({ grade: 'FOG', periodMs: 5, seed: 7 });
    for (let i = 0; i < 200; i++) {
      expect(a.next(i * 5)).toEqual(b.next(i * 5));
    }
  });

  it('puts gravity in the accelerometer, because it measures specific force', () => {
    const sim = new FogSimulatorSource({ grade: 'FOG', periodMs: 5 });
    const s = sim.next(0);
    expect(s.imu!.az).toBeGreaterThan(9.5);
    expect(s.imu!.az).toBeLessThan(10.1);
  });

  it('★ emits gyro in the right-hand rule, not a compass sense', () => {
    // ★ REGRESSION ★ This simulator first emitted gz as a compass yaw rate,
    // so a right turn was positive. Real hardware — DeviceMotionEvent and
    // Android's SensorManager — uses the right-hand rule, where a right turn
    // about +Z is clockwise and therefore NEGATIVE, and SensorSample.imu
    // documents that contract. Getting it backwards turned the estimate the
    // wrong way and produced 135 degrees of heading error at every sensor
    // grade, which read as "sensor grade does not matter" when it really
    // meant "the simulator lied about its axes".
    const sim = new FogSimulatorSource({ grade: 'FOG', periodMs: 5, seed: 1 });
    // Drive far enough to leave the sinusoid's neutral region.
    let sawRightTurn = false;
    let hBefore = sim.truthHeadingDeg;
    for (let i = 0; i < 400; i++) {
      const s = sim.next(i * 5);
      const hAfter = sim.truthHeadingDeg;
      const delta = ((hAfter - hBefore + 540) % 360) - 180;
      // Truth turned right (bearing increased) => reported gz must be negative.
      if (delta > 0.001) {
        expect(s.imu!.gz).toBeLessThan(0);
        sawRightTurn = true;
      }
      hBefore = hAfter;
    }
    expect(sawRightTurn).toBe(true);
  });

  it('withholds GNSS entirely when asked for pure INS', () => {
    const sim = new FogSimulatorSource({ grade: 'FOG', periodMs: 5, gnssIntervalMs: 0 });
    for (let i = 0; i < 100; i++) {
      // Absent, never zeroed — the shape a real tunnel produces.
      expect(sim.next(i * 5).gnss).toBeUndefined();
    }
  });
});

describe('the edge runner', () => {
  it('sustains far above the 200 Hz the problem statement asks for', async () => {
    const sim = new FogSimulatorSource({ grade: 'FOG', periodMs: 5, gnssIntervalMs: 1000 });
    const report = await runEdge({
      source: sim,
      grade: 'FOG',
      rateHz: 200,
      maxSamples: 4000, // 20 s of stream
    });
    expect(report.samples).toBe(4000);
    // The claim is about the estimator, not about anybody's serial port.
    expect(report.achievedRateHz).toBeGreaterThan(200);
    expect(report.realTimeFactor).toBeGreaterThan(1);
    // Per-update budget at 200 Hz is 5 ms. We should be orders below it.
    expect(report.meanLatencyMs).toBeLessThan(1);
  });

  it('navigates rather than merely running — distance accrues under GNSS', async () => {
    const sim = new FogSimulatorSource({
      grade: 'FOG',
      periodMs: 5,
      gnssIntervalMs: 1000,
      speedMps: 16.7,
    });
    const report = await runEdge({ source: sim, grade: 'FOG', rateHz: 200, maxSamples: 12_000 });
    expect(report.finalState).not.toBeNull();
    expect(report.finalState!.mode).toBe('GNSS');
    // 60 s at 16.7 m/s is ~1002 m. Generous bounds: this asserts the engine
    // is actually integrating, not that the simulator is precise.
    expect(report.finalState!.distanceTravelledM).toBeGreaterThan(800);
    expect(report.finalState!.distanceTravelledM).toBeLessThan(1200);
  });

  it('stops cleanly when the stream ends', async () => {
    let n = 0;
    const finite: EdgeSource = {
      name: 'finite',
      next: (t) =>
        n++ < 50
          ? ({ t, imu: { ax: 0, ay: 0, az: 9.80665, gx: 0, gy: 0, gz: 0 } } as SensorSample)
          : null,
    };
    const report = await runEdge({ source: finite, grade: 'PHONE_MEMS', rateHz: 200 });
    expect(report.samples).toBe(50);
  });

  it('closes the source even when the engine throws', async () => {
    let closed = false;
    const bad: EdgeSource = {
      name: 'bad',
      next: () => {
        throw new Error('sensor exploded');
      },
      close: () => {
        closed = true;
      },
    };
    await expect(
      runEdge({ source: bad, grade: 'FOG', rateHz: 200 }),
    ).rejects.toThrow('sensor exploded');
    // A hardware adapter that is never closed leaks a port on every run.
    expect(closed).toBe(true);
  });

  it('rejects a nonsensical rate rather than dividing by zero', async () => {
    const sim = new FogSimulatorSource({ grade: 'FOG', periodMs: 5 });
    await expect(runEdge({ source: sim, grade: 'FOG', rateHz: 0 })).rejects.toThrow(
      /rateHz must be positive/,
    );
  });
});

describe('external log parsing', () => {
  it('reads the project\'s own JSONL, so phone logs run on the edge engine', () => {
    const text = [
      '{"t":0,"imu":{"ax":0,"ay":0,"az":9.8,"gx":0,"gy":0,"gz":0}}',
      '{"t":20,"imu":{"ax":0,"ay":0,"az":9.8,"gx":0,"gy":0,"gz":0},"gnss":{"lat":23.1,"lon":79.9,"accuracyM":4}}',
    ].join('\n');
    const out = parseJsonl(text);
    expect(out).toHaveLength(2);
    expect(out[1]!.gnss!.lat).toBeCloseTo(23.1, 6);
  });

  it('survives a malformed line instead of losing the whole recording', () => {
    const text = [
      '{"t":0,"imu":{"ax":0,"ay":0,"az":9.8,"gx":0,"gy":0,"gz":0}}',
      'this line is corrupt {{{',
      '{"t":20,"imu":{"ax":0,"ay":0,"az":9.8,"gx":0,"gy":0,"gz":0}}',
    ].join('\n');
    expect(parseJsonl(text)).toHaveLength(2);
  });

  it('reads CSV from an external logger', () => {
    const csv = ['t,ax,ay,az,gx,gy,gz', '0,0.1,0.2,9.8,0.01,0.02,0.03'].join('\n');
    const out = parseCsv(csv);
    expect(out).toHaveLength(1);
    expect(out[0]!.imu!.gz).toBeCloseTo(0.03, 6);
  });

  it('★ converts units only when told to, never by sniffing', () => {
    // A logger emitting deg/s would be wrong by a factor of 57 and the
    // estimator would produce confident nonsense. There is no guessing here.
    const csv = ['t,ax,ay,az,gx,gy,gz', '0,0,0,1,0,0,57.2958'].join('\n');
    const raw = parseCsv(csv);
    expect(raw[0]!.imu!.gz).toBeCloseTo(57.2958, 3);

    const converted = parseCsv(csv, { gyroDeg: true, accelG: true });
    expect(converted[0]!.imu!.gz).toBeCloseTo(1, 3);
    expect(converted[0]!.imu!.az).toBeCloseTo(9.80665, 3);
  });

  it('refuses a CSV missing the columns it needs', () => {
    expect(() => parseCsv('foo,bar\n1,2')).toThrow(/CSV needs at least/);
  });
});
