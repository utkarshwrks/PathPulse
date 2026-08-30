import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NavMode } from '@pathpulse/nav-core';
import { MapContext } from './MapContext';
import ConfidenceEllipse from './ConfidenceEllipse';
import { MODE_COLORS } from '@/config/modes';

/**
 * The confidence ellipse layer, against a mocked map.
 *
 * The ring geometry itself is nav-core's problem and is tested there. What is
 * tested here is everything that would make a correct ring invisible or wrong
 * on screen: that the source and both layers get created, that the polygon is
 * valid GeoJSON, that it carries the mode the colour expression reads, and
 * that it is torn down cleanly when the marker goes away.
 */

function makeMap() {
  const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  const layers: Array<Record<string, unknown>> = [];
  return {
    sources,
    layers,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, def: { data: unknown }) => {
      const entry = {
        data: def.data,
        setData(d: unknown) {
          entry.data = d;
        },
      };
      sources.set(id, entry);
    },
    addLayer: (def: Record<string, unknown>) => layers.push(def),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    removeLayer: (id: string) => {
      const i = layers.findIndex((l) => l.id === id);
      if (i >= 0) layers.splice(i, 1);
    },
    removeSource: (id: string) => sources.delete(id),
  };
}

type MockMap = ReturnType<typeof makeMap>;

interface Props {
  lat?: number;
  lon?: number;
  alongM?: number;
  crossM?: number;
  headingDeg?: number | null;
  mode?: NavMode;
}

function withMap(map: MockMap, props: Props = {}) {
  return render(
    <MapContext.Provider value={map as never}>
      <ConfidenceEllipse
        lat={props.lat ?? 28.6315}
        lon={props.lon ?? 77.2167}
        alongM={props.alongM ?? 40}
        crossM={props.crossM ?? 10}
        headingDeg={props.headingDeg ?? 90}
        mode={props.mode ?? 'DEAD_RECKONING'}
      />
    </MapContext.Provider>,
  );
}

/** The single polygon feature currently in the source. */
function feature(map: MockMap) {
  const data = map.sources.get('pathpulse-confidence')?.data as {
    features: Array<{
      properties: { mode: string };
      geometry: { type: string; coordinates: Array<Array<[number, number]>> };
    }>;
  };
  return data.features[0];
}

afterEach(cleanup);

describe('ConfidenceEllipse', () => {
  it('creates the source and both the fill and the outline', () => {
    const map = makeMap();
    withMap(map);

    expect(map.sources.has('pathpulse-confidence')).toBe(true);
    expect(map.getLayer('pathpulse-confidence-fill')).toBeDefined();
    expect(map.getLayer('pathpulse-confidence-outline')).toBeDefined();
  });

  it('draws a closed polygon ring', () => {
    const map = makeMap();
    withMap(map);

    const f = feature(map);
    expect(f.geometry.type).toBe('Polygon');
    const ring = f.geometry.coordinates[0]!;
    expect(ring.length).toBeGreaterThan(3);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('carries the mode the paint expression matches on', () => {
    const map = makeMap();
    withMap(map, { mode: 'RECOVERING' });
    expect(feature(map).properties.mode).toBe('RECOVERING');
  });

  it('colours by mode through a data-driven expression, not a fixed colour', () => {
    const map = makeMap();
    withMap(map);

    const fill = map.getLayer('pathpulse-confidence-fill') as {
      paint: Record<string, unknown>;
    };
    const expr = fill.paint['fill-color'] as unknown[];
    expect(expr[0]).toBe('match');
    expect(expr).toContain(MODE_COLORS.DEAD_RECKONING);
    expect(expr).toContain(MODE_COLORS.GNSS);
  });

  it('keeps the fill faint enough to read the map underneath', () => {
    const map = makeMap();
    withMap(map);
    const fill = map.getLayer('pathpulse-confidence-fill') as {
      paint: Record<string, number>;
    };
    expect(fill.paint['fill-opacity']).toBeLessThan(0.3);
    expect(fill.paint['fill-opacity']).toBeGreaterThan(0);
  });

  it('redraws when the covariance grows, which is the whole point during an outage', () => {
    const map = makeMap();
    const { rerender } = withMap(map, { alongM: 20 });
    const before = feature(map).geometry.coordinates[0]!;

    rerender(
      <MapContext.Provider value={map as never}>
        <ConfidenceEllipse
          lat={28.6315}
          lon={77.2167}
          alongM={200}
          crossM={10}
          headingDeg={90}
          mode="DEAD_RECKONING"
        />
      </MapContext.Provider>,
    );

    const after = feature(map).geometry.coordinates[0]!;
    const spread = (ring: Array<[number, number]>) =>
      Math.max(...ring.map(([lon]) => lon)) - Math.min(...ring.map(([lon]) => lon));
    // Heading is east, so growing the along axis must widen the ring in
    // longitude — not in latitude, which the cross axis owns.
    expect(spread(after)).toBeGreaterThan(spread(before) * 5);
  });

  it('empties the source rather than throwing when the position is not real', () => {
    const map = makeMap();
    withMap(map, { lat: NaN });
    const data = map.sources.get('pathpulse-confidence')?.data as { features: unknown[] };
    expect(data.features).toHaveLength(0);
  });

  it('accepts a null heading — stationary means no known direction, not no ellipse', () => {
    const map = makeMap();
    withMap(map, { headingDeg: null });
    expect(feature(map).geometry.coordinates[0]!.length).toBeGreaterThan(3);
  });

  it('removes its layers and source on unmount, so a source switch cannot leak them', () => {
    const map = makeMap();
    const { unmount } = withMap(map);
    unmount();

    expect(map.sources.has('pathpulse-confidence')).toBe(false);
    expect(map.getLayer('pathpulse-confidence-fill')).toBeUndefined();
    expect(map.getLayer('pathpulse-confidence-outline')).toBeUndefined();
  });

  it('does not add a second source when re-rendered', () => {
    const map = makeMap();
    const { rerender } = withMap(map);
    rerender(
      <MapContext.Provider value={map as never}>
        <ConfidenceEllipse
          lat={28.64}
          lon={77.22}
          alongM={50}
          crossM={12}
          headingDeg={45}
          mode="GNSS"
        />
      </MapContext.Provider>,
    );
    expect(map.layers.filter((l) => l.id === 'pathpulse-confidence-fill')).toHaveLength(1);
  });
});
