import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodeGraph, decodeGraph, COORD_PRECISION_M } from '../src/mapmatch/graphCodec.js';
import type { RoadGraph, RoadWay } from '../src/mapmatch/types.js';

/**
 * The compact road-graph codec.
 *
 * ★ WHY THIS FILE CARRIES MOST OF THE WORKSTREAM'S VALUE ★
 * The codec is what makes a 100 km offline radius cost single-digit MB instead
 * of tens, and it is entirely headless — no network, no map, no device. So the
 * things that would otherwise only be discovered on a phone in a tunnel are
 * discoverable here: a truncated download, a way that loses its `oneway` tag,
 * a coordinate that drifts far enough to change which road the estimator snaps
 * to.
 *
 * The tolerance below is not arbitrary. Quantisation is 1e-5 degrees, ~1.1 m,
 * which is well inside GNSS error and far inside roadsnap's 50 m search
 * radius — so it CANNOT change a match. Asserting the bound is how that stays
 * true if anyone retunes the precision.
 */

const HERE = new URL('.', import.meta.url).pathname;
const GRAPH_DIR = join(HERE, '../../../data/maps');

function way(id: string, coords: Array<[number, number]>, extra: Partial<RoadWay> = {}): RoadWay {
  return { id, coords, ...extra };
}

function graphOf(ways: RoadWay[]): RoadGraph {
  return { bbox: [79.87, 23.11, 79.99, 23.22], ways };
}

/**
 * A minimal version 1 encoder, written out longhand.
 *
 * ★ THE ONLY HONEST WAY TO TEST BACKWARD COMPATIBILITY ★
 * Asserting that v2 reads v1 is worthless if the v1 bytes were produced by the
 * v2 encoder with a flag flipped — that tests the encoder against itself. This
 * writes the old format directly, so if v2's reader drifts from what v1
 * actually wrote, this fails. It is deliberately duplicated rather than shared:
 * v1 is frozen, and a helper the production codec could refactor is not a
 * record of what shipped.
 */
function encodeV1(graph: RoadGraph): Uint8Array {
  const out: number[] = [];
  const varint = (v: number) => {
    let x = Math.floor(v);
    while (x >= 0x80) {
      out.push((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    out.push(x);
  };
  const zigzag = (v: number) => varint(v >= 0 ? v * 2 : -v * 2 - 1);
  const ascii = (str: string) => {
    varint(str.length);
    for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i));
  };

  out.push(0x50, 0x50, 0x47, 0x31, 1); // 'PPG1', version 1
  for (const v of graph.bbox) zigzag(Math.round(v * 1e7));

  const classes = new Map<string, number>();
  for (const w of graph.ways) {
    if (w.highway !== undefined && !classes.has(w.highway)) classes.set(w.highway, classes.size);
  }
  varint(classes.size);
  for (const c of classes.keys()) ascii(c);
  // No name table. That absence is the whole point of the fixture.

  varint(graph.ways.length);
  for (const w of graph.ways) {
    const numericId = /^w\d+$/.test(w.id);
    let flags = 0;
    if (w.oneway === true) flags |= 1;
    else if (w.oneway === false) flags |= 2;
    if (w.maxspeed !== undefined) flags |= 0b0000_0100;
    if (w.highway !== undefined) flags |= 0b0000_1000;
    if (numericId) flags |= 0b0001_0000;
    if (w.renderOnly === true) flags |= 0b0010_0000;
    out.push(flags);

    if (numericId) varint(Number(w.id.slice(1)));
    else ascii(w.id);
    if (w.highway !== undefined) varint(classes.get(w.highway)!);
    if (w.maxspeed !== undefined) varint(Math.round(w.maxspeed));

    varint(w.coords.length);
    let prevLon = 0;
    let prevLat = 0;
    for (const [lon, lat] of w.coords) {
      const qLon = Math.round(lon * 1e5);
      const qLat = Math.round(lat * 1e5);
      zigzag(qLon - prevLon);
      zigzag(qLat - prevLat);
      prevLon = qLon;
      prevLat = qLat;
    }
  }
  return new Uint8Array(out);
}

/** Largest distance, metres, between any original point and its round-trip. */
function worstCoordErrorM(before: RoadGraph, after: RoadGraph): number {
  let worst = 0;
  for (let i = 0; i < before.ways.length; i++) {
    const a = before.ways[i]!;
    const b = after.ways[i]!;
    expect(b.coords).toHaveLength(a.coords.length);
    for (let j = 0; j < a.coords.length; j++) {
      const [lon1, lat1] = a.coords[j]!;
      const [lon2, lat2] = b.coords[j]!;
      const dLat = (lat2 - lat1) * 110_574;
      const dLon = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
      worst = Math.max(worst, Math.hypot(dLat, dLon));
    }
  }
  return worst;
}

describe('graphCodec — round trip', () => {
  it('preserves geometry to within the quantisation bound', () => {
    const g = graphOf([
      way('w1', [
        [79.8905546, 23.1567999],
        [79.8905832, 23.1568602],
        [79.8912928, 23.1577125],
      ]),
      way('w2', [
        [79.9, 23.16],
        [79.95, 23.2],
      ]),
    ]);
    const back = decodeGraph(encodeGraph(g));
    expect(worstCoordErrorM(g, back)).toBeLessThan(1.5);
    expect(COORD_PRECISION_M).toBeLessThan(1.5);
  });

  it('★ preserves oneway, maxspeed and highway exactly', () => {
    // These three are not cosmetic. `oneway` drives rejectOnewayReverse, which
    // is worth 2.2 points of mean drift; `maxspeed` feeds speedclamp; and
    // `highway` decides both the render weight and which classes the matcher
    // is allowed to see. A codec that quietly dropped any of them would
    // degrade navigation in a way no round-trip-the-coordinates test notices.
    const g = graphOf([
      way('w1', [[79.9, 23.16], [79.91, 23.17]], {
        highway: 'primary',
        oneway: true,
        maxspeed: 60,
      }),
      way('w2', [[79.9, 23.16], [79.91, 23.17]], { highway: 'residential' }),
      way('w3', [[79.9, 23.16], [79.91, 23.17]], { highway: 'service', oneway: false }),
    ]);
    const back = decodeGraph(encodeGraph(g));
    expect(back.ways[0]!.oneway).toBe(true);
    expect(back.ways[0]!.maxspeed).toBe(60);
    expect(back.ways[0]!.highway).toBe('primary');
    expect(back.ways[1]!.highway).toBe('residential');
    expect(back.ways[1]!.maxspeed).toBeUndefined();
    expect(back.ways[2]!.highway).toBe('service');
    // false and undefined are different claims and must stay different.
    expect(back.ways[2]!.oneway).not.toBe(true);
  });

  it('★ preserves renderOnly, or stored footpaths become snappable', () => {
    // The nastiest possible loss. A round trip that dropped this bit would turn
    // every stored footpath back into an ordinary road the next time its cell
    // was read, and the symptom — a vehicle snapped onto a pavement beside the
    // road it is actually on — surfaces in the matcher, nowhere near here.
    const g = graphOf([
      way('a', [[79.9, 23.16], [79.91, 23.17]], { highway: 'footway', renderOnly: true }),
      way('b', [[79.9, 23.16], [79.91, 23.17]], { highway: 'residential' }),
    ]);
    const back = decodeGraph(encodeGraph(g));
    expect(back.ways[0]!.renderOnly).toBe(true);
    expect(back.ways[1]!.renderOnly).toBeUndefined();
  });

  it('preserves way ids, which continuity depends on', () => {
    // findRoadMatch's continuity bonus compares against lastWayId. Ids that
    // changed between decodes would silently disable it.
    const g = graphOf([
      way('w101274337', [[79.9, 23.16], [79.91, 23.17]]),
      way('some-non-numeric-id', [[79.9, 23.16], [79.91, 23.17]]),
    ]);
    const back = decodeGraph(encodeGraph(g));
    expect(back.ways.map((w) => w.id)).toEqual(['w101274337', 'some-non-numeric-id']);
  });

  it('is deterministic — the same graph encodes to the same bytes', () => {
    const g = graphOf([way('w1', [[79.9, 23.16], [79.91, 23.17]], { highway: 'primary' })]);
    expect(Array.from(encodeGraph(g))).toEqual(Array.from(encodeGraph(g)));
  });

  it('handles an empty graph', () => {
    const back = decodeGraph(encodeGraph(graphOf([])));
    expect(back.ways).toEqual([]);
  });

  it('preserves the bbox', () => {
    const g = graphOf([way('w1', [[79.9, 23.16], [79.91, 23.17]])]);
    const back = decodeGraph(encodeGraph(g));
    for (let i = 0; i < 4; i++) {
      expect(back.bbox[i]!).toBeCloseTo(g.bbox[i]!, 5);
    }
  });

  it('survives coordinates in every quadrant and at the extremes', () => {
    // Delta encoding with zigzag is where a sign error hides, and it hides
    // specifically in the southern and western hemispheres — which is most of
    // the world and none of the test data.
    const g: RoadGraph = {
      bbox: [-180, -85, 180, 85],
      ways: [
        way('a', [[-179.9, -84.9], [179.9, 84.9]]),
        way('b', [[-0.0001, -0.0001], [0.0001, 0.0001]]),
        way('c', [[151.2093, -33.8688], [151.21, -33.87]]),
      ],
    };
    const back = decodeGraph(encodeGraph(g));
    expect(worstCoordErrorM(g, back)).toBeLessThan(1.5);
  });
});

describe('graphCodec — hostile input', () => {
  const valid = () =>
    encodeGraph(graphOf([way('w1', [[79.9, 23.16], [79.91, 23.17]], { highway: 'primary' })]));

  it('★ throws on a truncated buffer rather than decoding a shorter way', () => {
    // The failure this prevents is silent. A download cut short mid-way decodes
    // into a graph that looks structurally fine and is missing geometry, and
    // the estimator then snaps to roads that stop existing halfway along.
    const full = valid();
    for (const cut of [1, 4, 8, Math.floor(full.length / 2), full.length - 1]) {
      expect(() => decodeGraph(full.slice(0, cut))).toThrow();
    }
  });

  it('throws on wrong magic bytes', () => {
    const b = valid();
    b[0] = 0x00;
    expect(() => decodeGraph(b)).toThrow(/magic|format/i);
  });

  it('throws on an unsupported version', () => {
    const b = valid();
    b[4] = 0x7f;
    expect(() => decodeGraph(b)).toThrow(/version/i);
  });

  it('throws on an empty buffer', () => {
    expect(() => decodeGraph(new Uint8Array(0))).toThrow();
  });

  it('refuses to encode a way with fewer than two points', () => {
    // A single-node "way" has no geometry to project onto. RoadIndex would
    // build a zero-length segment and projectOntoSegment would divide by zero.
    expect(() => encodeGraph(graphOf([way('w1', [[79.9, 23.16]])]))).toThrow(/two|points/i);
    expect(() => encodeGraph(graphOf([way('w1', [])]))).toThrow(/two|points/i);
  });

  it('refuses to encode non-finite coordinates', () => {
    expect(() =>
      encodeGraph(graphOf([way('w1', [[Number.NaN, 23.16], [79.91, 23.17]])])),
    ).toThrow();
    expect(() =>
      encodeGraph(graphOf([way('w1', [[Number.POSITIVE_INFINITY, 23.16], [79.91, 23.17]])])),
    ).toThrow();
  });

  it('refuses absurd coordinates', () => {
    expect(() => encodeGraph(graphOf([way('w1', [[999, 23.16], [79.91, 23.17]])]))).toThrow(
      /range|coordinate/i,
    );
  });
});

describe('graphCodec — property: random graphs round-trip', () => {
  it('round-trips 200 random graphs losslessly within tolerance', () => {
    // Deterministic PRNG: a property test that cannot be reproduced from its
    // failure output is a flaky test with extra steps.
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const classes = ['motorway', 'primary', 'residential', 'service', undefined];

    for (let g = 0; g < 200; g++) {
      const ways: RoadWay[] = [];
      const wayCount = 1 + Math.floor(rnd() * 6);
      for (let w = 0; w < wayCount; w++) {
        const n = 2 + Math.floor(rnd() * 8);
        const coords: Array<[number, number]> = [];
        let lon = -180 + rnd() * 360;
        let lat = -85 + rnd() * 170;
        for (let i = 0; i < n; i++) {
          lon = Math.max(-180, Math.min(180, lon + (rnd() - 0.5) * 0.01));
          lat = Math.max(-85, Math.min(85, lat + (rnd() - 0.5) * 0.01));
          coords.push([lon, lat]);
        }
        const cls = classes[Math.floor(rnd() * classes.length)];
        ways.push({
          id: `w${Math.floor(rnd() * 1e9)}`,
          coords,
          ...(cls ? { highway: cls } : {}),
          ...(rnd() > 0.5 ? { oneway: true } : {}),
          ...(rnd() > 0.5 ? { maxspeed: Math.floor(rnd() * 120) } : {}),
        });
      }
      const graph = graphOf(ways);
      const back = decodeGraph(encodeGraph(graph));
      expect(back.ways).toHaveLength(graph.ways.length);
      expect(worstCoordErrorM(graph, back)).toBeLessThan(1.5);
      for (let i = 0; i < graph.ways.length; i++) {
        expect(back.ways[i]!.id).toBe(graph.ways[i]!.id);
        expect(back.ways[i]!.highway).toBe(graph.ways[i]!.highway);
        expect(back.ways[i]!.maxspeed).toBe(graph.ways[i]!.maxspeed);
      }
    }
  });
});

describe('graphCodec — size, on the real committed graphs', () => {
  it('★ is at least 3.5x smaller than the raw JSON', () => {
    // The ratio is asserted, not just measured, because it is the entire
    // justification for the offline design: a 100 km radius costs single-digit
    // MB only if this holds. A refactor that reintroduced full-precision
    // coordinates would still round-trip perfectly and would silently make the
    // feature unaffordable.
    const file = join(GRAPH_DIR, 'road_graph_jabalpur.json');
    if (!existsSync(file)) return; // graphs are data, not code; skip if absent
    const raw = readFileSync(file);
    const graph = JSON.parse(raw.toString()) as RoadGraph;
    const encoded = encodeGraph(graph);
    const ratio = raw.length / encoded.length;
    expect(ratio).toBeGreaterThan(3.5);
  });

  it('round-trips every committed graph', () => {
    for (const name of ['road_graph_city.json', 'road_graph_highway.json', 'road_graph_jabalpur.json']) {
      const file = join(GRAPH_DIR, name);
      if (!existsSync(file)) continue;
      const graph = JSON.parse(readFileSync(file).toString()) as RoadGraph;
      const back = decodeGraph(encodeGraph(graph));
      expect(back.ways).toHaveLength(graph.ways.length);
      expect(worstCoordErrorM(graph, back)).toBeLessThan(1.5);
      for (let i = 0; i < graph.ways.length; i++) {
        expect(back.ways[i]!.id).toBe(graph.ways[i]!.id);
        expect(back.ways[i]!.oneway).toBe(graph.ways[i]!.oneway);
        expect(back.ways[i]!.maxspeed).toBe(graph.ways[i]!.maxspeed);
        expect(back.ways[i]!.highway).toBe(graph.ways[i]!.highway);
        expect(back.ways[i]!.name).toBe(graph.ways[i]!.name);
      }
    }
  });
});

describe('graphCodec — street names (v2)', () => {
  it('★ preserves names, which the offline basemap labels roads from', () => {
    // Dropped by v1 on a claim that measured wrong; see the note in the codec.
    // Without this a prefetched cell decodes to unnamed roads, so labels
    // appear only inside the three bounding boxes committed months ago —
    // which is every place except where the user actually is.
    const graph = graphOf([
      way('w1', [[79.9, 23.16], [79.91, 23.17]], { name: 'Napier Town Road', highway: 'primary' }),
      way('w2', [[79.92, 23.18], [79.93, 23.19]], { highway: 'residential' }),
    ]);
    const back = decodeGraph(encodeGraph(graph));
    expect(back.ways[0]!.name).toBe('Napier Town Road');
    // Absent stays absent rather than becoming an empty string: the basemap
    // filters on the property existing, and '' would render a blank label.
    expect(back.ways[1]!.name).toBeUndefined();
  });

  it('★ survives names that are not ASCII', () => {
    // The obvious implementation reuses the ASCII writer used for the class
    // table, which THROWS on a byte over 0x7f — so encoding a cell would fail
    // outright anywhere the roads are not named in English, which is most of
    // where this app is meant to work, including its own demo city.
    const names = ['छोटी लाइन', 'Champs-Élysées', '中山路', 'Grünstraße'];
    const graph = graphOf(
      names.map((n, i) =>
        way(`w${i + 1}`, [[79.9 + i / 100, 23.16], [79.91 + i / 100, 23.17]], { name: n }),
      ),
    );
    const back = decodeGraph(encodeGraph(graph));
    expect(back.ways.map((w) => w.name)).toEqual(names);
  });

  it('interns repeated names rather than storing one copy per way', () => {
    // OSM splits a street at every junction, so this is the common shape, not
    // a contrived one. Inline strings would make names cost what v1 assumed.
    const many = Array.from({ length: 200 }, (_, i) =>
      way(`w${i}`, [[79.9, 23.16 + i / 10_000], [79.9, 23.161 + i / 10_000]], {
        name: 'Marine Drive',
      }),
    );
    const shared = encodeGraph(graphOf(many)).length;
    const distinct = encodeGraph(
      graphOf(many.map((w, i) => ({ ...w, name: `Marine Drive ${i}` }))),
    ).length;
    // 200 copies of a 12-byte name against one copy plus 200 one-byte indices.
    expect(distinct - shared).toBeGreaterThan(1500);
  });

  it('★ still decodes a version 1 buffer, or stored coverage is wiped', () => {
    // Cells already on a device are v1, and there may be thousands of them.
    // Rejecting them would delete exactly the offline coverage the prefetcher
    // spent the user's data accumulating — and it would look like corruption.
    const graph = graphOf([
      way('w1', [[79.9, 23.16], [79.91, 23.17]], {
        highway: 'primary',
        oneway: true,
        maxspeed: 60,
      }),
      way('w2', [[79.92, 23.18], [79.93, 23.19]], { renderOnly: true }),
    ]);
    const v1 = encodeV1(graph);
    const back = decodeGraph(v1);
    expect(back.ways).toHaveLength(2);
    expect(back.ways[0]!.highway).toBe('primary');
    expect(back.ways[0]!.oneway).toBe(true);
    expect(back.ways[0]!.maxspeed).toBe(60);
    expect(back.ways[1]!.renderOnly).toBe(true);
    // v1 carried no names, and reading one out of an absent table would be
    // the worst outcome — a plausible wrong street name.
    expect(back.ways[0]!.name).toBeUndefined();
  });

  it('names cost a rounding error against the geometry on a real graph', () => {
    // The whole justification for reversing v1's decision. If a refactor ever
    // makes names expensive again this is where it shows up.
    const file = join(GRAPH_DIR, 'road_graph_city.json');
    if (!existsSync(file)) return;
    const graph = JSON.parse(readFileSync(file).toString()) as RoadGraph;
    const withNames = encodeGraph(graph).length;
    const without = encodeGraph({
      ...graph,
      ways: graph.ways.map(({ name: _drop, ...w }) => w as RoadWay),
    }).length;
    expect(graph.ways.some((w) => w.name)).toBe(true);
    expect((withNames - without) / without).toBeLessThan(0.05);
  });
});
