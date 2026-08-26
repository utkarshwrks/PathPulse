'use client';

import { createContext, useContext } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

/** Lets marker/trail layers attach themselves without prop-drilling the map. */
export const MapContext = createContext<MapLibreMap | null>(null);

export function useMap(): MapLibreMap | null {
  return useContext(MapContext);
}
