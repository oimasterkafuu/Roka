import type { MapRegion } from '../types';

export interface HuaxiaRegionConfig {
  id: MapRegion;
  name: string;
  /** Approximate representative-period viewing rectangle, not a historical border. */
  bounds: { west: number; east: number; south: number; north: number };
  /** Spherical area of the full viewport (land AND sea), not dynasty territory. */
  viewportAreaKm2: number;
  /** Historical territorial area is not known from these rectangles. */
  territoryAreaKm2: null;
}

const EARTH_RADIUS_KM = 6371.0088;
const viewportArea = (west: number, east: number, south: number, north: number): number =>
  Math.round(
    EARTH_RADIUS_KM ** 2 *
      (((east - west) * Math.PI) / 180) *
      (Math.sin((north * Math.PI) / 180) - Math.sin((south * Math.PI) / 180)),
  );

/** Hand-estimated viewports for representative eras; these do not trace historical frontiers. */
const regions: readonly { id: MapRegion; name: string; bounds: HuaxiaRegionConfig['bounds'] }[] = [
  { id: 'qin', name: '秦', bounds: { west: 96, east: 111, south: 30, north: 39 } },
  { id: 'han', name: '汉', bounds: { west: 73, east: 135, south: 18, north: 49 } },
  { id: 'tang', name: '唐', bounds: { west: 70, east: 140, south: 16, north: 55 } },
  { id: 'song', name: '宋', bounds: { west: 97, east: 125, south: 18, north: 43 } },
  { id: 'yuan', name: '元', bounds: { west: 70, east: 142, south: 8, north: 59 } },
  { id: 'ming', name: '明', bounds: { west: 90, east: 135, south: 17, north: 52 } },
  { id: 'qing', name: '清', bounds: { west: 70, east: 145, south: 17, north: 57 } },
  { id: 'china', name: '中国', bounds: { west: 97, east: 123, south: 20, north: 42 } },
  { id: 'hong-kong', name: '香港', bounds: { west: 113.7, east: 114.5, south: 22.1, north: 22.6 } },
  { id: 'taiwan', name: '台湾省', bounds: { west: 119, east: 122.2, south: 21.5, north: 25.5 } },
];

export const HUAXIA_REGIONS: readonly HuaxiaRegionConfig[] = regions.map(({ id, name, bounds }) => ({
  id,
  name,
  bounds,
  viewportAreaKm2: viewportArea(bounds.west, bounds.east, bounds.south, bounds.north),
  territoryAreaKm2: null,
}));

export const DEFAULT_MAP_REGION: MapRegion = 'han';

const REGION_BY_ID = new Map(HUAXIA_REGIONS.map((region) => [region.id, region]));

export const isMapRegion = (value: unknown): value is MapRegion => REGION_BY_ID.has(value as MapRegion);

const LEGACY_REGION_ALIASES: Readonly<Record<string, MapRegion>> = {
  'three-kingdoms': 'han',
  'northern-dynasties': 'han',
};

export const normalizeMapRegion = (value: unknown): MapRegion => {
  if (isMapRegion(value)) return value;
  if (typeof value === 'string') return LEGACY_REGION_ALIASES[value] ?? DEFAULT_MAP_REGION;
  return DEFAULT_MAP_REGION;
};

export const getHuaxiaRegion = (value: unknown): HuaxiaRegionConfig =>
  REGION_BY_ID.get(normalizeMapRegion(value)) ?? HUAXIA_REGIONS[0];
