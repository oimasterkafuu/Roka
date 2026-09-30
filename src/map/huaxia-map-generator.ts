import {
  Grid,
  MAX_MOUNTAIN_RATIO,
  MAX_SWAMP_RATIO,
  SeededRandom,
  Tile,
  build2D,
  checkConnection,
  computeBaseMapDimensions,
  markLargestComponent,
} from './map-core';
import { getHuaxiaRegion } from './huaxia-regions';
import type { MapRegion } from '../types';
import type { GeneratedMap, MapGenerationConfig } from './random-map-generator';

interface HuaxiaMapGenerationConfig extends MapGenerationConfig {
  mapRegion: MapRegion;
}

/**
 * 华夏地图是基于公开地形资料与历史疆域资料的粗略矩形近似，经过确定性
 * 程序化扰动调整为可联通、可出生、可玩的游戏地图，并非真实历史地图复原。
 */
const generateHuaxiaMap = (rng: SeededRandom, config: HuaxiaMapGenerationConfig): GeneratedMap => {
  const { n, m } = computeBaseMapDimensions(rng, config.heightRatio, config.widthRatio);
  const region = getHuaxiaRegion(config.mapRegion);
  const owner = build2D(n, m, 0);
  const armyCnt = build2D(n, m, 0);
  const mountainRatio = MAX_MOUNTAIN_RATIO * config.mountainRatio * 0.7 * region.terrain.mountain;
  const swampRatio = MAX_SWAMP_RATIO * config.swampRatio * 0.75 * region.terrain.swamp;
  let gridType: Grid<Tile> = build2D<Tile>(n, m, 0);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const candidate = build2D<Tile>(n, m, 0);
    const ridgeWidth = Math.max(1, Math.floor(Math.min(n, m) * 0.035));
    for (let x = 0; x < n; x += 1) {
      for (let y = 0; y < m; y += 1) {
        const nx = x / Math.max(1, n - 1);
        const ny = y / Math.max(1, m - 1);
        const ridge = Math.abs(nx - region.terrain.ridgeX) < region.terrain.corridor;
        const cross = Math.abs(ny - region.terrain.ridgeY) < region.terrain.corridor * 0.7;
        const nearRidge = ridge || cross;
        const noise = rng.next();
        const localSwamp = swampRatio * (nearRidge ? 0.7 : 1.15);
        const localMountain = mountainRatio * (nearRidge ? 1.35 : 0.85);
        if (
          nearRidge &&
          (Math.abs(x - n * region.terrain.ridgeX) < ridgeWidth ||
            Math.abs(y - m * region.terrain.ridgeY) < ridgeWidth)
        ) {
          candidate[x][y] = noise < localSwamp * 0.45 ? 2 : 0;
        } else if (noise < localSwamp) {
          candidate[x][y] = 2;
        } else if (noise < localSwamp + localMountain) {
          candidate[x][y] = 1;
        }
      }
    }
    const [connectedX] = checkConnection(candidate, n, m);
    if (connectedX !== -1) {
      gridType = candidate;
      break;
    }
    if (attempt === 79) {
      gridType = candidate;
    }
  }

  const st = build2D(n, m, false);
  markLargestComponent(gridType, n, m, st);
  // 保证边缘仍有足够平地供现有随机出生点算法挑选。
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < m; y += 1) {
      if (st[x][y] && (x < 2 || y < 2 || x >= n - 2 || y >= m - 2) && gridType[x][y] === 1) {
        gridType[x][y] = 0;
      }
    }
  }

  return { n, m, owner, armyCnt, gridType, st };
};

export { generateHuaxiaMap };
export type { HuaxiaMapGenerationConfig };
