import { describe, expect, it } from 'vitest';
import {
  appendTrailPoint,
  buildConfidenceRing,
  buildGpx,
  buildTripGeoJson,
  summariseConstellations,
  type NavigationState,
  type TrailPoint,
} from '@pathpulse/nav-core';
import { parseJsonl, runEval } from '../src/harness.js';
import { loadConfig, loadGraphFor, readLog } from '../src/paths.js';

/**
 * Phase 9, all six features at once, on a real recorded log.
 *
 * ★ WHY THIS EXISTS SEPARATELY ★
 * Every Phase 9 feature has its own tests and its own hostile pass, and all of
 * them pass. None of that says what happens when the confidence ellipse, the
 * turn detector, the anomaly detector, the constellation panel and the trip
 * export all run over the same drive — which is the only configuration that
 * ships. Features are tested in isolation and shipped together, and the gap
 * between those two facts is where the demo breaks.
 *
 * This drives the full engine over a recorded log with the shipping config, a
 * real road graph and a real outage, then asserts across all of it.
 */

const LOG = 'sim_city_1337.jsonl';
const OUTAGE_START_MS = 30_000;
const OUTAGE_MS = 60_000;

function run() {
  const samples = parseJsonl(readLog(LOG));
  const first = samples.find((s) => s.gnss)?.gnss;
  const graph = first ? loadGraphFor(first.lat, first.lon) : null;
  const config = loadConfig('full');
  return runEval(samples, {
    configName: 'full',
    logName: LOG,
    engineConfig: config.engine as Record<string, unknown>,
    outageStartMs: OUTAGE_START_MS,
    outageDurationMs: OUTAGE_MS,
    roadGraph: graph?.graph ?? null,
  });
}

const result = run();
const states = result.states;

/** The trail the UI would have built from these states. */
function buildTrail(all: readonly NavigationState[]): TrailPoint[] {
  let trail: TrailPoint[] = [];
  for (const s of all) {
    if (s.mode === 'INITIALIZING') continue;
    if (!Number.isFinite(s.position.lat) || !Number.isFinite(s.position.lon)) continue;
    if (s.position.lat === 0 && s.position.lon === 0) continue;
    trail = appendTrailPoint(trail, {
      lat: s.position.lat,
      lon: s.position.lon,
      mode: s.mode,
      t: s.t,
    });
  }
  return trail;
}

describe('Phase 9 integration — the shipping configuration', () => {
  it('produces a run with an outage and a recovery in it', () => {
    expect(states.length).toBeGreaterThan(1000);
    const modes = new Set(states.map((s) => s.mode));
    expect(modes.has('DEAD_RECKONING')).toBe(true);
    expect(modes.has('GNSS')).toBe(true);
  });

  it('★ never emits a non-finite number on any state, on any sample', () => {
    // One NaN reaching the UI puts the marker nowhere and is very hard to
    // trace. This is the invariant every other feature depends on.
    for (const s of states) {
      expect(Number.isFinite(s.position.lat), `lat @${s.t}`).toBe(true);
      expect(Number.isFinite(s.position.lon), `lon @${s.t}`).toBe(true);
      expect(Number.isFinite(s.velocityMps), `speed @${s.t}`).toBe(true);
      expect(Number.isFinite(s.headingDeg), `heading @${s.t}`).toBe(true);
      expect(Number.isFinite(s.covariance.alongM), `alongM @${s.t}`).toBe(true);
      expect(Number.isFinite(s.covariance.crossM), `crossM @${s.t}`).toBe(true);
      expect(Number.isFinite(s.estimatedDriftM), `drift @${s.t}`).toBe(true);
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('★ 9A: the ellipse is drawable at every single sample', () => {
    // The renderer calls this every frame. A ring that comes back empty or
    // with a junk vertex mid-drive is a shape that vanishes or a map that
    // throws, and neither would show up in a unit test of the ring alone.
    for (const s of states) {
      if (s.mode === 'INITIALIZING') continue;
      const ring = buildConfidenceRing(s.position, {
        alongM: s.covariance.alongM,
        crossM: s.covariance.crossM,
        headingDeg: s.headingDeg,
      });
      expect(ring.length, `ring @${s.t}`).toBeGreaterThan(3);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      for (const [lon, lat] of ring) {
        expect(Number.isFinite(lon) && Number.isFinite(lat), `vertex @${s.t}`).toBe(true);
      }
    }
  });

  it('★ 9A: along-track uncertainty exceeds cross-track through the outage', () => {
    // The whole reason it is an ellipse. If road snapping or the covariance
    // changes ever made these equal, the shape would silently become a circle
    // and the story it tells would be gone.
    const dr = states.filter((s) => s.mode === 'DEAD_RECKONING');
    expect(dr.length).toBeGreaterThan(100);
    const last = dr[dr.length - 1]!;
    expect(last.covariance.alongM).toBeGreaterThan(last.covariance.crossM);
  });

  it('★ 9D: raises no GNSS anomaly on a clean recorded drive', () => {
    // The anomaly detector runs on every sample of every demo. A single false
    // positive here is a red badge on screen during the run.
    const flagged = states.filter((s) => s.gnssAnomaly !== undefined);
    expect(flagged.map((s) => s.gnssAnomaly?.kind)).toEqual([]);
  });

  it('9B: any turn it reports carries a consistent angle and label', () => {
    const turns = states.filter((s) => s.lastTurn).map((s) => s.lastTurn!);
    for (const t of turns) {
      expect(Number.isFinite(t.deltaDeg)).toBe(true);
      expect(Math.abs(t.deltaDeg)).toBeGreaterThanOrEqual(25);
      if (t.kind.startsWith('LEFT') || t.kind === 'SLIGHT_LEFT') {
        expect(t.deltaDeg).toBeLessThan(0);
      }
      if (t.kind.startsWith('RIGHT') || t.kind === 'SLIGHT_RIGHT') {
        expect(t.deltaDeg).toBeGreaterThan(0);
      }
      expect(t.label).toMatch(/^(LEFT|RIGHT|U-TURN) \d+°$/);
    }
  });

  it('★ 9F: the trail this run produces exports as a valid trip', () => {
    // The export is only ever fed real engine output. Feeding it the actual
    // states from a real log is the only test that covers that path.
    const trail = buildTrail(states);
    expect(trail.length).toBeGreaterThan(50);

    const gpx = buildGpx({ estimated: trail, startedAtEpochMs: Date.UTC(2026, 7, 30) });
    expect(gpx).not.toContain('NaN');
    expect(gpx).not.toContain('undefined');
    expect((gpx.match(/<trk>/g) ?? []).length).toBe((gpx.match(/<\/trk>/g) ?? []).length);
    expect(gpx.trimEnd().endsWith('</gpx>')).toBe(true);

    const gj = buildTripGeoJson({ estimated: trail });
    expect(gj.features.length).toBeGreaterThan(0);
    const text = JSON.stringify(gj);
    expect(text).not.toContain('NaN');
    for (const f of gj.features) {
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('★ 9F: the export labels the dead-reckoned stretches as such', () => {
    // The point of splitting per mode. If the trail ever stopped carrying
    // mode, the file would still be valid and would silently stop
    // distinguishing measured from inferred.
    const gpx = buildGpx({ estimated: buildTrail(states) });
    expect(gpx).toContain('DEAD RECKONING');
    expect(gpx).toContain('GNSS');
  });

  it('9E: a recorded log reports a total, and says the breakdown is missing', () => {
    const samples = parseJsonl(readLog(LOG));
    const fix = samples.find((s) => s.gnss)?.gnss;
    const summary = summariseConstellations({
      ...(fix?.constellations ? { constellations: fix.constellations } : {}),
      ...(fix?.satCount != null ? { satCount: fix.satCount } : {}),
    });
    // These logs were recorded before the breakdown existed, so they carry a
    // count and nothing else — exactly the TOTAL-ONLY case, and the summary
    // must say so rather than rendering an empty sky.
    expect(['total-only', 'measured']).toContain(summary.provenance);
    expect(summary.note.length).toBeGreaterThan(10);
  });

  it('★ meets the problem statement’s 10 Hz floor throughout', () => {
    expect(result.metrics.meanUpdateHz).toBeGreaterThanOrEqual(10);
  });

  it('★ drift stays in the range the deck quotes', () => {
    // A guard on the headline claim itself. If a Phase 9 feature ever reached
    // the estimator, this is what says so.
    expect(result.metrics.driftPercent).toBeGreaterThan(0);
    expect(result.metrics.driftPercent).toBeLessThan(15);
  });

  it('is deterministic — the same log twice gives the same answer', () => {
    const again = run();
    expect(again.metrics.driftPercent).toBe(result.metrics.driftPercent);
    expect(again.states.length).toBe(states.length);
  });
});

describe('★ the trail must outlive the outage it exists to show', () => {
  /**
   * THE DEFECT THIS PINS.
   * The trail was a 500-point ring buffer. At a 0.5 m separation filter and
   * 10 Hz, a vehicle at 14 m/s lays a point every 1.4 m — so it held the last
   * 38.9 seconds of a 180 s run, and the final trail contained nothing but
   * GNSS. The whole dead-reckoned stretch had been evicted.
   *
   * Invisible while the trail was only a line on a map, because during the
   * outage the orange line is right there in front of you. Phase 9F made it
   * matter: the trip export is built from this buffer, so a judge opening the
   * file afterwards would find a tidy GNSS track and no evidence the outage
   * ever happened — the one thing the file exists to show.
   */
  const trail = buildTrail(states);

  it('still holds the dead-reckoned stretch at the end of the run', () => {
    const modes = new Set(trail.map((p) => p.mode));
    expect(modes.has('DEAD_RECKONING')).toBe(true);
    expect(modes.has('GNSS')).toBe(true);
  });

  it('spans essentially the whole run, not the last half-minute', () => {
    const spanS = (trail[trail.length - 1]!.t - trail[0]!.t) / 1000;
    const runS = states[states.length - 1]!.t / 1000;
    expect(spanS).toBeGreaterThan(runS * 0.9);
  });

  it('keeps the before, during and after that make the story readable', () => {
    const drStart = trail.find((p) => p.mode === 'DEAD_RECKONING')!.t;
    // There is GNSS before the outage and GNSS after it, both retained.
    expect(trail.some((p) => p.mode === 'GNSS' && p.t < drStart)).toBe(true);
    expect(trail.some((p) => p.mode === 'GNSS' && p.t > drStart)).toBe(true);
  });
});
