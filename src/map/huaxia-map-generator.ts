import { Tile, build2D, computeFixedMapDimensions, markLargestComponent } from './map-core';
import {
  HUAXIA_LAND_OUTLINE,
  HUAXIA_PASSES,
  HUAXIA_RIDGES,
  HUAXIA_SEA_BAYS,
  type HuaxiaPoint,
} from './huaxia-terrain-data';
import { getHuaxiaRegion } from './huaxia-regions';
import type { MapRegion } from '../types';
import type { GeneratedMap, MapGenerationConfig } from './random-map-generator';

interface HuaxiaMapGenerationConfig extends MapGenerationConfig {
  mapRegion: MapRegion;
}

const pointInPolygon = (point: HuaxiaPoint, polygon: readonly HuaxiaPoint[]): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > point.y !== b.y > point.y;
    if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

const distanceToSegment = (point: HuaxiaPoint, a: HuaxiaPoint, b: HuaxiaPoint): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
};

const distanceToPolyline = (point: HuaxiaPoint, line: readonly HuaxiaPoint[]): number => {
  let distance = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i += 1) {
    distance = Math.min(distance, distanceToSegment(point, line[i - 1], line[i]));
  }
  return distance;
};

const isSea = (point: HuaxiaPoint): boolean =>
  !pointInPolygon(point, HUAXIA_LAND_OUTLINE) || HUAXIA_SEA_BAYS.some((bay) => pointInPolygon(point, bay));

const isPass = (point: HuaxiaPoint): boolean =>
  HUAXIA_PASSES.some((pass) => Math.hypot(point.x - pass.x, point.y - pass.y) <= pass.radius);

/**
 * 华夏地图使用固定离线折线栅格化，不读取地图种子：种子只会在引擎
 * 随后的 selectRandomGenerals 中影响出生点选择。海域是 Tile 2，平原
 * 是 Tile 0，山系来自 huaxia-terrain-data.ts 的主脉/支脉宽度。
 */
const generateHuaxiaMap = (_rng: unknown, config: HuaxiaMapGenerationConfig): GeneratedMap => {
  const { n, m } = computeFixedMapDimensions(config.heightRatio, config.widthRatio);
  const region = getHuaxiaRegion(config.mapRegion);
  const owner = build2D(n, m, 0);
  const armyCnt = build2D(n, m, 0);
  const gridType = build2D<Tile>(n, m, 0);
  const mountainScale = 0.58 + region.terrain.mountain * 0.08;

  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < m; y += 1) {
      const point = {
        x: (x + 0.5) / n,
        y: (y + 0.5) / m,
      };
      if (isSea(point)) {
        gridType[x][y] = 2;
        continue;
      }
      const mountain = HUAXIA_RIDGES.some(
        (ridge) => distanceToPolyline(point, ridge.points) <= ridge.width * mountainScale,
      );
      if (mountain && !isPass(point)) {
        gridType[x][y] = 1;
      }
    }
  }

  // 所有资料折线都在主体陆地内；只清理确定性山口周围的格子，避免
  // 山系把平原切成孤岛，同时保留海岸与山脉的固定轮廓。
  for (const pass of HUAXIA_PASSES) {
    const passPoint = { x: pass.x, y: pass.y };
    const radiusX = Math.ceil(pass.radius * n);
    const radiusY = Math.ceil(pass.radius * m);
    const centerX = Math.floor(pass.x * n);
    const centerY = Math.floor(pass.y * m);
    for (let x = Math.max(0, centerX - radiusX); x <= Math.min(n - 1, centerX + radiusX); x += 1) {
      for (let y = Math.max(0, centerY - radiusY); y <= Math.min(m - 1, centerY + radiusY); y += 1) {
        const point = { x: (x + 0.5) / n, y: (y + 0.5) / m };
        if (!isSea(point) && Math.hypot(point.x - passPoint.x, point.y - passPoint.y) <= pass.radius) {
          gridType[x][y] = 0;
        }
      }
    }
  }

  const st = build2D(n, m, false);
  markLargestComponent(gridType, n, m, st);
  return { n, m, owner, armyCnt, gridType, st };
};

export { generateHuaxiaMap };
export type { HuaxiaMapGenerationConfig };
