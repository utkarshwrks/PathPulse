import { describe, expect, it } from 'vitest';
import {
  angleDifference,
  bearingDeg,
  ecefToLatLon,
  enuToLatLon,
  haversineDistance,
  latLonToEcef,
  latLonToEnu,
  normalizeAngle,
  normalizeAngle360,
} from '../src/index.js';

// Two well-known Delhi landmarks, ~4.94 km apart.
const INDIA_GATE = { lat: 28.6129, lon: 77.2295 };
const RED_FORT = { lat: 28.6562, lon: 77.241 };
// Connaught Place, used as an ENU reference origin.
const CP = { lat: 28.6315, lon: 77.2167 };

describe('haversineDistance', () => {
  it('matches the known India Gate -> Red Fort distance', () => {
    const d = haversineDistance(INDIA_GATE.lat, INDIA_GATE.lon, RED_FORT.lat, RED_FORT.lon);
    expect(d).toBeGreaterThan(4850);
    expect(d).toBeLessThan(5050);
  });

  it('is zero for identical points', () => {
    expect(haversineDistance(CP.lat, CP.lon, CP.lat, CP.lon)).toBeCloseTo(0, 9);
  });

  it('is symmetric', () => {
    const ab = haversineDistance(INDIA_GATE.lat, INDIA_GATE.lon, RED_FORT.lat, RED_FORT.lon);
    const ba = haversineDistance(RED_FORT.lat, RED_FORT.lon, INDIA_GATE.lat, INDIA_GATE.lon);
    expect(ab).toBeCloseTo(ba, 6);
  });

  it('gives ~111.2 km for one degree of latitude', () => {
    const d = haversineDistance(28, 77, 29, 77);
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });
});

describe('bearingDeg', () => {
  it('reports due north', () => {
    expect(bearingDeg(28, 77, 29, 77)).toBeCloseTo(0, 6);
  });

  it('reports due east', () => {
    expect(bearingDeg(0, 77, 0, 78)).toBeCloseTo(90, 6);
  });

  it('always returns [0, 360)', () => {
    const b = bearingDeg(29, 77, 28, 77); // due south
    expect(b).toBeCloseTo(180, 6);
    const w = bearingDeg(0, 78, 0, 77); // due west
    expect(w).toBeCloseTo(270, 6);
  });

  it('points roughly north-north-east from India Gate to Red Fort', () => {
    const b = bearingDeg(INDIA_GATE.lat, INDIA_GATE.lon, RED_FORT.lat, RED_FORT.lon);
    expect(b).toBeGreaterThan(5);
    expect(b).toBeLessThan(35);
  });
});

describe('ENU conversion', () => {
  it('puts the reference point at the origin', () => {
    const { e, n, u } = latLonToEnu(CP.lat, CP.lon, CP.lat, CP.lon);
    expect(e).toBeCloseTo(0, 6);
    expect(n).toBeCloseTo(0, 6);
    expect(u ?? 0).toBeCloseTo(0, 6);
  });

  it('round-trips lat/lon -> ENU -> lat/lon to sub-millimetre', () => {
    for (const p of [INDIA_GATE, RED_FORT, { lat: 28.7041, lon: 77.1025 }]) {
      const enu = latLonToEnu(p.lat, p.lon, CP.lat, CP.lon);
      const back = enuToLatLon(enu.e, enu.n, CP.lat, CP.lon, enu.u ?? 0);
      // 1e-9 deg is ~0.1 mm.
      expect(back.lat).toBeCloseTo(p.lat, 9);
      expect(back.lon).toBeCloseTo(p.lon, 9);
    }
  });

  it('agrees with haversine on horizontal distance', () => {
    const enu = latLonToEnu(RED_FORT.lat, RED_FORT.lon, INDIA_GATE.lat, INDIA_GATE.lon);
    const enuDist = Math.hypot(enu.e, enu.n);
    const hav = haversineDistance(INDIA_GATE.lat, INDIA_GATE.lon, RED_FORT.lat, RED_FORT.lon);
    // Different earth models, so allow 0.5%.
    expect(Math.abs(enuDist - hav) / hav).toBeLessThan(0.005);
  });

  it('orients east positive and north positive', () => {
    const east = latLonToEnu(CP.lat, CP.lon + 0.01, CP.lat, CP.lon);
    expect(east.e).toBeGreaterThan(0);
    expect(Math.abs(east.n)).toBeLessThan(Math.abs(east.e) * 0.01);

    const north = latLonToEnu(CP.lat + 0.01, CP.lon, CP.lat, CP.lon);
    expect(north.n).toBeGreaterThan(0);
    expect(Math.abs(north.e)).toBeLessThan(1e-6);
  });

  it('moves exactly 100 m north for a 100 m north offset', () => {
    const p = enuToLatLon(0, 100, CP.lat, CP.lon);

    // Measured back in the same (ellipsoidal) model, this must be exact.
    const back = latLonToEnu(p.lat, p.lon, CP.lat, CP.lon);
    expect(back.e).toBeCloseTo(0, 6);
    expect(back.n).toBeCloseTo(100, 6);

    // Haversine is spherical (R = 6371.0 km) while ENU is on the WGS84
    // ellipsoid, whose meridian radius at 28.6N is ~6351 km. The models
    // therefore disagree by ~0.3%, which is model error, not drift.
    const d = haversineDistance(CP.lat, CP.lon, p.lat, p.lon);
    expect(Math.abs(d - 100) / 100).toBeLessThan(0.005);
  });
});

describe('ECEF conversion', () => {
  it('round-trips through ECEF', () => {
    const ecef = latLonToEcef(INDIA_GATE.lat, INDIA_GATE.lon, 216);
    const back = ecefToLatLon(ecef.x, ecef.y, ecef.z);
    expect(back.lat).toBeCloseTo(INDIA_GATE.lat, 9);
    expect(back.lon).toBeCloseTo(INDIA_GATE.lon, 9);
    expect(back.heightM).toBeCloseTo(216, 3);
  });

  it('places the equator/prime-meridian point on the +X axis', () => {
    const { x, y, z } = latLonToEcef(0, 0, 0);
    expect(x).toBeCloseTo(6378137.0, 3);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });
});

describe('angle helpers', () => {
  it('normalizes into (-180, 180]', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(190)).toBeCloseTo(-170, 9);
    expect(normalizeAngle(-190)).toBeCloseTo(170, 9);
    expect(normalizeAngle(540)).toBeCloseTo(180, 9);
    expect(normalizeAngle(360)).toBeCloseTo(0, 9);
  });

  it('normalizes into [0, 360)', () => {
    expect(normalizeAngle360(-90)).toBeCloseTo(270, 9);
    expect(normalizeAngle360(450)).toBeCloseTo(90, 9);
  });

  it('takes the short way around north', () => {
    // The bug this guards: 350 -> 10 is a 20 degree right turn, not -340.
    expect(angleDifference(10, 350)).toBeCloseTo(20, 9);
    expect(angleDifference(350, 10)).toBeCloseTo(-20, 9);
  });
});
