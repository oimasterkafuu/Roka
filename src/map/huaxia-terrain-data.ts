import landRings from './huaxia-land.json';

/** Natural Earth 1:50m land v4.0.0, simplified by scripts/generate-huaxia-land.py.
 * Coordinates are [longitude, latitude] in WGS84 degrees; not historical borders.
 */
export const HUAXIA_LAND_RINGS: readonly (readonly (readonly number[])[])[] = landRings;

export interface HuaxiaPoint {
  lon: number;
  lat: number;
}

export interface HuaxiaRidge {
  name: string;
  /** Approximate half-width in degrees; game terrain, not surveyed relief. */
  width: number;
  points: readonly HuaxiaPoint[];
}

/** Gameplay approximation of mountain axes anchored in geography, not a DEM. */
export const HUAXIA_RIDGES: readonly HuaxiaRidge[] = [
  {
    name: '天山',
    width: 0.9,
    points: [
      { lon: 74, lat: 42 },
      { lon: 81, lat: 42 },
      { lon: 89, lat: 43 },
    ],
  },
  {
    name: '昆仑—祁连',
    width: 1.1,
    points: [
      { lon: 77, lat: 36 },
      { lon: 87, lat: 36 },
      { lon: 96, lat: 39 },
      { lon: 103, lat: 37 },
    ],
  },
  {
    name: '阴山—燕山',
    width: 1.0,
    points: [
      { lon: 106, lat: 41 },
      { lon: 113, lat: 41 },
      { lon: 120, lat: 41 },
    ],
  },
  {
    name: '太行',
    width: 1.2,
    points: [
      { lon: 114, lat: 40 },
      { lon: 113, lat: 35 },
    ],
  },
  {
    name: '秦岭',
    width: 1.0,
    points: [
      { lon: 104, lat: 34 },
      { lon: 109, lat: 34 },
      { lon: 112, lat: 33 },
    ],
  },
  {
    name: '横断',
    width: 1.0,
    points: [
      { lon: 98, lat: 33 },
      { lon: 100, lat: 29 },
      { lon: 99, lat: 24 },
    ],
  },
  {
    name: '南岭',
    width: 1.4,
    points: [
      { lon: 108, lat: 25 },
      { lon: 113, lat: 25 },
      { lon: 116, lat: 26 },
    ],
  },
  {
    name: '武夷',
    width: 1.1,
    points: [
      { lon: 117, lat: 28 },
      { lon: 118, lat: 25 },
    ],
  },
  {
    name: '大兴安岭',
    width: 1.3,
    points: [
      { lon: 120, lat: 50 },
      { lon: 121, lat: 46 },
      { lon: 119, lat: 42 },
    ],
  },
];

/** Approximate gameplay passes, cut only through mountains and never through sea. */
export const HUAXIA_PASSES: readonly (HuaxiaPoint & { name: string; radius: number })[] = [
  { name: '河西走廊', lon: 100, lat: 39, radius: 1.2 },
  { name: '潼关', lon: 110, lat: 34.5, radius: 1.2 },
  { name: '雁门关', lon: 112.8, lat: 39.2, radius: 1 },
  { name: '剑门关', lon: 105.5, lat: 32.2, radius: 1 },
  { name: '梅关', lon: 114.3, lat: 25.1, radius: 1 },
];
