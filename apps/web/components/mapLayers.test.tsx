import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrailPoint } from '@pathpulse/nav-core';
import { MapContext } from './MapContext';
import { MODE_COLORS } from '@/config/modes';

/**
 * The two MapLibre layers, against a mocked map.
 *
 * They were both at 0% coverage, and between them they are everything the
 * judge actually looks at: where the arrow is, which way it points, and which
 * stretch of the trail was satellite-fixed versus estimated. A marker placed at
 * the wrong coordinate or a trail coloured by the wrong mode would be
 * completely invisible to every other test in the project.
 *
 * MapLibre needs WebGL, which jsdom has not got — so the map itself is a stub
 * that records what the components ask it to do.
 */

const markerInstances: MockMarker[] = [];

class MockMarker {
  lngLat: [number, number] | null = null;
  added = false;
  removed = false;
  constructor(public readonly opts: { element?: HTMLElement } = {}) {
    markerInstances.push(this);
  }
  setLngLat(v: [number, number]) {
    this.lngLat = v;
    return this;
  }
  addTo() {
    this.added = true;
    return this;
  }
  remove() {
    this.removed = true;
  }
}

vi.mock('maplibre-gl', () => ({
  default: { Marker: MockMarker },
  Marker: MockMarker,
}));

/** Records every source/layer operation the component performs. */
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

function withMap(map: MockMap, ui: React.ReactNode) {
  return render(
    <MapContext.Provider value={map as never}>{ui}</MapContext.Provider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  markerInstances.length = 0;
});

/** jsdom reports inline colours as rgb(r, g, b), never as the source hex. */
function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('VehicleMarker', () => {
  it('places the marker at the given position, lon first', async () => {
    // ★ MapLibre takes [lon, lat]; everything else in this project says
    // lat, lon. Swapping them puts the vehicle in the wrong hemisphere and
    // nothing else in the codebase would notice.
    const { default: VehicleMarker } = await import('./VehicleMarker');
    const map = makeMap();
    withMap(map, <VehicleMarker lat={23.16} lon={79.93} headingDeg={87} mode="GNSS" />);

    expect(markerInstances).toHaveLength(1);
    expect(markerInstances[0]!.lngLat).toEqual([79.93, 23.16]);
    expect(markerInstances[0]!.added).toBe(true);
  });

  it('moves rather than recreating the marker when the position changes', async () => {
    const { default: VehicleMarker } = await import('./VehicleMarker');
    const map = makeMap();
    const { rerender } = withMap(
      map,
      <VehicleMarker lat={23.16} lon={79.93} headingDeg={0} mode="GNSS" />,
    );
    rerender(
      <MapContext.Provider value={map as never}>
        <VehicleMarker lat={23.17} lon={79.94} headingDeg={0} mode="GNSS" />
      </MapContext.Provider>,
    );
    // Recreating it every frame would kill the CSS transition that stops the
    // marker looking like it teleports.
    expect(markerInstances).toHaveLength(1);
    expect(markerInstances[0]!.lngLat).toEqual([79.94, 23.17]);
  });

  it('rotates the arrow to the heading', async () => {
    const { default: VehicleMarker } = await import('./VehicleMarker');
    const map = makeMap();
    withMap(map, <VehicleMarker lat={0} lon={0} headingDeg={87} mode="GNSS" />);
    const el = markerInstances[0]!.opts.element!;
    expect(el.innerHTML + el.outerHTML).toMatch(/87/);
  });

  it('keeps the last heading when it goes null at a standstill', async () => {
    // GNSS reports no heading when stationary. Snapping back to north would
    // spin the arrow every time the vehicle stopped.
    const { default: VehicleMarker } = await import('./VehicleMarker');
    const map = makeMap();
    const { rerender } = withMap(
      map,
      <VehicleMarker lat={0} lon={0} headingDeg={140} mode="GNSS" />,
    );
    rerender(
      <MapContext.Provider value={map as never}>
        <VehicleMarker lat={0} lon={0} headingDeg={null} mode="GNSS" />
      </MapContext.Provider>,
    );
    const el = markerInstances[0]!.opts.element!;
    expect(el.outerHTML).toMatch(/140/);
    expect(el.outerHTML).not.toMatch(/rotate\(0deg\)/);
  });

  it.each(['GNSS', 'GNSS_DEGRADED', 'DEAD_RECKONING', 'RECOVERING'] as const)(
    'colours the arrow for %s from the shared mode palette',
    async (mode) => {
      const { default: VehicleMarker } = await import('./VehicleMarker');
      const map = makeMap();
      withMap(map, <VehicleMarker lat={0} lon={0} headingDeg={0} mode={mode} />);
      // Colours come from MODE_COLORS so the badge, marker and trail can never
      // disagree about what a mode looks like. jsdom normalises an inline hex
      // colour to rgb(), so compare against the parsed channels rather than
      // the literal string.
      const el = markerInstances[0]!.opts.element!;
      const arrow = el.querySelector<HTMLElement>('*[style*="color"]') ?? el;
      const expected = hexToRgb(MODE_COLORS[mode]);
      expect(`${arrow.style.color} ${el.outerHTML}`).toContain(expected);
    },
  );

  it('removes itself from the map on unmount', async () => {
    const { default: VehicleMarker } = await import('./VehicleMarker');
    const map = makeMap();
    const { unmount } = withMap(
      map,
      <VehicleMarker lat={0} lon={0} headingDeg={0} mode="GNSS" />,
    );
    unmount();
    expect(markerInstances[0]!.removed).toBe(true);
  });

  it('does nothing at all without a map', async () => {
    const { default: VehicleMarker } = await import('./VehicleMarker');
    render(
      <MapContext.Provider value={null}>
        <VehicleMarker lat={0} lon={0} headingDeg={0} mode="GNSS" />
      </MapContext.Provider>,
    );
    expect(markerInstances).toHaveLength(0);
  });
});

describe('TrailLayer', () => {
  const trail: TrailPoint[] = [
    { lat: 23.16, lon: 79.93, mode: 'GNSS', t: 0 },
    { lat: 23.161, lon: 79.931, mode: 'GNSS', t: 1000 },
    { lat: 23.162, lon: 79.932, mode: 'DEAD_RECKONING', t: 2000 },
    { lat: 23.163, lon: 79.933, mode: 'DEAD_RECKONING', t: 3000 },
  ];

  it('adds exactly one source and one layer', async () => {
    // ★ One data-driven layer, not one layer per segment. ★ Otherwise the
    // layer count grows every time the mode flips and the map slows down over
    // the course of a demo.
    const { default: TrailLayer } = await import('./TrailLayer');
    const map = makeMap();
    withMap(map, <TrailLayer trail={trail} />);
    expect(map.sources.size).toBe(1);
    expect(map.layers).toHaveLength(1);
  });

  it('draws a line layer, not a fill', async () => {
    const { default: TrailLayer } = await import('./TrailLayer');
    const map = makeMap();
    withMap(map, <TrailLayer trail={trail} />);
    expect(map.layers[0]!.type).toBe('line');
  });

  it('publishes the trail as GeoJSON features', async () => {
    const { default: TrailLayer } = await import('./TrailLayer');
    const map = makeMap();
    withMap(map, <TrailLayer trail={trail} />);
    const data = [...map.sources.values()][0]!.data as {
      type: string;
      features: Array<{ geometry: { coordinates: Array<[number, number]> } }>;
    };
    expect(data.type).toBe('FeatureCollection');
    expect(data.features.length).toBeGreaterThan(0);
    // lon, lat — the same ordering trap as the marker.
    const [lon, lat] = data.features[0]!.geometry.coordinates[0]!;
    expect(lon).toBeCloseTo(79.93, 2);
    expect(lat).toBeCloseTo(23.16, 2);
  });

  it('splits the trail where the mode changes, so each stretch is coloured', async () => {
    // This is the whole point of the trail: a judge can see at a glance which
    // stretch was satellite-fixed and which was estimated.
    const { default: TrailLayer } = await import('./TrailLayer');
    const map = makeMap();
    withMap(map, <TrailLayer trail={trail} />);
    const data = [...map.sources.values()][0]!.data as {
      features: Array<{ properties: { mode: string } }>;
    };
    const modes = data.features.map((f) => f.properties.mode);
    expect(modes).toContain('GNSS');
    expect(modes).toContain('DEAD_RECKONING');
  });

  it('updates the existing source rather than adding another', async () => {
    const { default: TrailLayer } = await import('./TrailLayer');
    const map = makeMap();
    const { rerender } = withMap(map, <TrailLayer trail={trail.slice(0, 2)} />);
    rerender(
      <MapContext.Provider value={map as never}>
        <TrailLayer trail={trail} />
      </MapContext.Provider>,
    );
    expect(map.sources.size).toBe(1);
    expect(map.layers).toHaveLength(1);
  });

  it('handles an empty trail without throwing', async () => {
    const { default: TrailLayer } = await import('./TrailLayer');
    const map = makeMap();
    expect(() => withMap(map, <TrailLayer trail={[]} />)).not.toThrow();
  });

  it('does nothing at all without a map', async () => {
    const { default: TrailLayer } = await import('./TrailLayer');
    const map = makeMap();
    render(
      <MapContext.Provider value={null}>
        <TrailLayer trail={trail} />
      </MapContext.Provider>,
    );
    expect(map.sources.size).toBe(0);
  });
});
