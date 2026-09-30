import type { MapRegion } from '../types';

export interface HuaxiaRegionConfig {
  id: MapRegion;
  name: string;
  /** Based on public terrain and historical-frontier references, simplified for playability. */
  terrain: {
    mountain: number;
    swamp: number;
    ridgeX: number;
    ridgeY: number;
    corridor: number;
  };
}

export const HUAXIA_REGIONS: readonly HuaxiaRegionConfig[] = [
  {
    id: 'han',
    name: '汉',
    terrain: { mountain: 0.82, swamp: 0.9, ridgeX: 0.42, ridgeY: 0.58, corridor: 0.16 },
  },
  {
    id: 'three-kingdoms',
    name: '三国',
    terrain: { mountain: 1.02, swamp: 0.78, ridgeX: 0.34, ridgeY: 0.66, corridor: 0.2 },
  },
  {
    id: 'northern-dynasties',
    name: '北朝',
    terrain: { mountain: 1.14, swamp: 0.48, ridgeX: 0.62, ridgeY: 0.32, corridor: 0.18 },
  },
  {
    id: 'tang',
    name: '唐',
    terrain: { mountain: 0.9, swamp: 0.72, ridgeX: 0.5, ridgeY: 0.42, corridor: 0.22 },
  },
  {
    id: 'song',
    name: '宋',
    terrain: { mountain: 0.86, swamp: 1.12, ridgeX: 0.64, ridgeY: 0.6, corridor: 0.2 },
  },
  {
    id: 'yuan',
    name: '元',
    terrain: { mountain: 0.62, swamp: 0.56, ridgeX: 0.3, ridgeY: 0.44, corridor: 0.13 },
  },
  {
    id: 'ming',
    name: '明',
    terrain: { mountain: 0.98, swamp: 0.86, ridgeX: 0.56, ridgeY: 0.68, corridor: 0.19 },
  },
  {
    id: 'qing',
    name: '清',
    terrain: { mountain: 1.08, swamp: 0.62, ridgeX: 0.7, ridgeY: 0.38, corridor: 0.17 },
  },
] as const;

export const DEFAULT_MAP_REGION: MapRegion = 'han';

const REGION_BY_ID = new Map(HUAXIA_REGIONS.map((region) => [region.id, region]));

export const isMapRegion = (value: unknown): value is MapRegion => REGION_BY_ID.has(value as MapRegion);

export const normalizeMapRegion = (value: unknown): MapRegion =>
  isMapRegion(value) ? value : DEFAULT_MAP_REGION;

export const getHuaxiaRegion = (value: unknown): HuaxiaRegionConfig =>
  REGION_BY_ID.get(normalizeMapRegion(value)) ?? HUAXIA_REGIONS[0];
