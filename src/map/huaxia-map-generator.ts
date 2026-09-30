import { Tile, build2D, computeFixedMapDimensions, markLargestComponent } from './map-core';
import { HUAXIA_LAND_RINGS, HUAXIA_PASSES, HUAXIA_RIDGES, type HuaxiaPoint } from './huaxia-terrain-data';
import { getHuaxiaRegion } from './huaxia-regions';
import type { MapRegion } from '../types';
import type { GeneratedMap, MapGenerationConfig } from './random-map-generator';

interface HuaxiaMapGenerationConfig extends MapGenerationConfig {
  mapRegion: MapRegion;
}

const rings = HUAXIA_LAND_RINGS.map((points) => ({
  points,
  west: Math.min(...points.map((p) => p[0])),
  east: Math.max(...points.map((p) => p[0])),
  south: Math.min(...points.map((p) => p[1])),
  north: Math.max(...points.map((p) => p[1])),
}));

/** Even-odd fill across Natural Earth polygon rings (including island and lake holes). */
const isLand = (lon: number, lat: number): boolean => {
  let inside = false;
  for (const ring of rings) {
    if (lon < ring.west || lon > ring.east || lat < ring.south || lat > ring.north) continue;
    const { points } = ring;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const a = points[i];
      const b = points[j];
      if (a[1] > lat !== b[1] > lat && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
    }
  }
  return inside;
};

const distanceToSegment = (point: HuaxiaPoint, a: HuaxiaPoint, b: HuaxiaPoint): number => {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.lon - a.lon) * dx + (point.lat - a.lat) * dy) / lengthSquared));
  return Math.hypot(point.lon - (a.lon + t * dx), point.lat - (a.lat + t * dy));
};

const isMountain = (point: HuaxiaPoint, cellWidth: number): boolean =>
  HUAXIA_RIDGES.some((ridge) => {
    const width = Math.max(ridge.width, cellWidth * 0.28);
    for (let i = 1; i < ridge.points.length; i += 1) {
      if (distanceToSegment(point, ridge.points[i - 1], ridge.points[i]) <= width) return true;
    }
    return false;
  }) && !HUAXIA_PASSES.some((pass) => Math.hypot(point.lon - pass.lon, point.lat - pass.lat) <= pass.radius);

/** Each dynasty rectangle is a geographic viewport; land outside its historical territory stays land.
 * Seed is unused here, and only affects the subsequent selectRandomGenerals call.
 */
const generateHuaxiaMap = (_rng: unknown, config: HuaxiaMapGenerationConfig): GeneratedMap => {
  const region = getHuaxiaRegion(config.mapRegion);
  const { west, east, south, north } = region.bounds;
  const base = computeFixedMapDimensions(config.heightRatio, config.widthRatio);
  const aspect = ((east - west) * Math.cos((((north + south) / 2) * Math.PI) / 180)) / (north - south);
  const scale = Math.sqrt(aspect);
  const odd = (value: number): number => Math.max(7, Math.floor(value) | 1);
  const n = odd(base.n / scale);
  const m = odd(base.m * scale);
  const owner = build2D(n, m, 0);
  const armyCnt = build2D(n, m, 0);
  const gridType = build2D<Tile>(n, m, 0);

  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < m; y += 1) {
      const point = {
        lon: west + ((y + 0.5) * (east - west)) / m,
        lat: north - ((x + 0.5) * (north - south)) / n,
      };
      if (!isLand(point.lon, point.lat)) gridType[x][y] = 2;
      else if (isMountain(point, (east - west) / m)) gridType[x][y] = 1;
    }
  }

  const st = build2D(n, m, false);
  markLargestComponent(gridType, n, m, st);
  return { n, m, owner, armyCnt, gridType, st };
};

export { generateHuaxiaMap, isLand };
export type { HuaxiaMapGenerationConfig };
