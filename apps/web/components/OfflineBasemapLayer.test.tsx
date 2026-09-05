import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoadGraph } from '@pathpulse/nav-core';
import { MapContext } from './MapContext';
import OfflineBasemapLayer from './OfflineBasemapLayer';

/**
 * The basemap drawn from the road graph.
 *
 * This is what makes the map survive going offline, and it is invisible in
 * every other test: it renders nothing to the DOM and only talks to MapLibre.
 * The one property that actually matters — that it goes BELOW the tile layer —
 * is also the easiest to break by accident, because appending is what
 * `addLayer` does by default and the result looks fine until tiles load and
 * cover the roads.
 */

/** A map stub that records ordering, which is the thing under test. */
function makeMap(styleLayers: Array<{ id: string; type: string }>) {
  const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  const layers: Array<Record<string, unknown>> = [];
  const insertedBefore: Record<string, string | undefined> = {};
  return {
    sources,
    layers,
    insertedBefore,
    isStyleLoaded: () => true,
    once: () => undefined,
    getStyle: () => ({ layers: styleLayers }),
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
    addLayer: (def: Record<string, unknown>, before?: string) => {
      layers.push(def);
      insertedBefore[def.id as string] = before;
    },
    getLayer: (id: string) => layers.find((l) => l.id === id),
    removeLayer: (id: string) => {
      const i = layers.findIndex((l) => l.id === id);
      if (i >= 0) layers.splice(i, 1);
    },
    removeSource: (id: string) => sources.delete(id),
  };
}

type MockMap = ReturnType<typeof makeMap>;

function withMap(map: MockMap, graph: RoadGraph | null) {
  return render(
    <MapContext.Provider value={map as never}>
      <OfflineBasemapLayer graph={graph} />
    </MapContext.Provider>,
  );
}

function graphOf(ways: RoadGraph['ways']): RoadGraph {
  return { bbox: [79.8, 23.1, 80.0, 23.3], ways };
}

const OSM_STYLE = [
  { id: 'background', type: 'background' },
  { id: 'osm', type: 'raster' },
];

afterEach(cleanup);

describe('OfflineBasemapLayer', () => {
  it('★ inserts beneath the tile layer, not on top of it', () => {
    // The whole design rests on this. Raster tiles are opaque, so drawn on top
    // these roads would double every road while online; underneath they are
    // hidden by tiles that arrive and revealed by tiles that do not — which is
    // what makes going offline degrade tile by tile instead of all at once.
    const map = makeMap(OSM_STYLE);
    withMap(
      map,
      graphOf([{ id: 'w1', coords: [[79.9, 23.15], [79.91, 23.16]], highway: 'primary' }]),
    );
    expect(map.insertedBefore['offline-basemap-casing']).toBe('osm');
    expect(map.insertedBefore['offline-basemap-line']).toBe('osm');
  });

  it('skips the background layer when choosing what to sit beneath', () => {
    // Inserting before `background` would put the roads behind an opaque fill,
    // which draws nothing at all — a failure that looks exactly like the bug
    // this component exists to fix.
    const map = makeMap([
      { id: 'background', type: 'background' },
      { id: 'maptiler-roads', type: 'line' },
    ]);
    withMap(map, graphOf([{ id: 'w1', coords: [[79.9, 23.15], [79.91, 23.16]] }]));
    expect(map.insertedBefore['offline-basemap-line']).toBe('maptiler-roads');
  });

  it('draws every way in the graph', () => {
    const map = makeMap(OSM_STYLE);
    withMap(
      map,
      graphOf([
        { id: 'w1', coords: [[79.9, 23.15], [79.91, 23.16]], highway: 'motorway' },
        { id: 'w2', coords: [[79.92, 23.17], [79.93, 23.18]], highway: 'service' },
      ]),
    );
    const src = map.sources.get('offline-basemap');
    const data = src!.data as { features: Array<{ properties: { weight: number } }> };
    expect(data.features).toHaveLength(2);
    // A motorway must draw heavier than a service road, or the result is a
    // uniform mesh with no readable structure.
    expect(data.features[0]!.properties.weight).toBeGreaterThan(
      data.features[1]!.properties.weight,
    );
  });

  it('gives a _link the weight of its parent class', () => {
    const map = makeMap(OSM_STYLE);
    withMap(
      map,
      graphOf([
        { id: 'a', coords: [[79.9, 23.15], [79.91, 23.16]], highway: 'motorway' },
        { id: 'b', coords: [[79.9, 23.15], [79.91, 23.16]], highway: 'motorway_link' },
      ]),
    );
    const data = map.sources.get('offline-basemap')!.data as {
      features: Array<{ properties: { weight: number } }>;
    };
    expect(data.features[1]!.properties.weight).toBe(data.features[0]!.properties.weight);
  });

  it('★ draws a render-only way, which the matcher never sees', () => {
    // The whole point of the split: the map gets footpaths, RoadIndex does not.
    // Asserted on both sides — here that it is drawn, and in nav-core's
    // roadsnap tests that findRoadMatch can never return one.
    const map = makeMap(OSM_STYLE);
    withMap(
      map,
      graphOf([
        { id: 'road', coords: [[79.9, 23.15], [79.91, 23.16]], highway: 'residential' },
        {
          id: 'pavement',
          coords: [[79.9, 23.15], [79.91, 23.16]],
          highway: 'footway',
          renderOnly: true,
        },
      ]),
    );
    const data = map.sources.get('offline-basemap')!.data as {
      features: Array<{ properties: { weight: number; renderOnly: number } }>;
    };
    expect(data.features).toHaveLength(2);
    expect(data.features[1]!.properties.renderOnly).toBe(1);
    expect(data.features[0]!.properties.renderOnly).toBe(0);
    // And it draws thinner than a real road, so it reads as context.
    expect(data.features[1]!.properties.weight).toBeLessThan(
      data.features[0]!.properties.weight,
    );
  });

  it('adds nothing at all without a graph', () => {
    // No graph is a real state — outside every downloaded region — and it must
    // render an empty map rather than throwing inside the map callback.
    const map = makeMap(OSM_STYLE);
    withMap(map, null);
    expect(map.layers).toHaveLength(0);
    expect(map.sources.size).toBe(0);
  });

  it('removes its layers before its source on unmount', () => {
    // MapLibre refuses to remove a source that a layer still references, and
    // the throw happens inside an effect cleanup where nothing reports it.
    const map = makeMap(OSM_STYLE);
    const { unmount } = withMap(
      map,
      graphOf([{ id: 'w1', coords: [[79.9, 23.15], [79.91, 23.16]] }]),
    );
    expect(map.sources.size).toBe(1);
    unmount();
    expect(map.layers).toHaveLength(0);
    expect(map.sources.size).toBe(0);
  });
});
