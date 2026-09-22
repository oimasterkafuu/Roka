import { Grid, Tile } from '../map/map-core';
import { FOG_VISION_RADIUS } from './constants';
import { buildFullVisionArrays, FlatMapArrays } from './map-encoding';

interface BoardState {
  n: number;
  m: number;
  gridType: Grid<Tile>;
  owner: Grid<number>;
  armyCnt: Grid<number>;
  isolated: Grid<boolean>;
  isolatedAge: Grid<number>;
}

/**
 * 计算一支队伍的可见格子（扁平 0/1 数组）：己方（含队友）任意格子
 * 切比雪夫距离 FOG_VISION_RADIUS 范围内均可见。
 */
const computeTeamVisibility = (
  n: number,
  m: number,
  owner: Grid<number>,
  teamOf: (ownerId: number) => number,
  teamId: number,
): number[] => {
  const visible = new Array<number>(n * m).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const ownerId = owner[i][j];
      if (ownerId <= 0 || teamOf(ownerId) !== teamId) {
        continue;
      }
      for (let dx = -FOG_VISION_RADIUS; dx <= FOG_VISION_RADIUS; dx += 1) {
        const x = i + dx;
        if (x < 0 || x >= n) {
          continue;
        }
        for (let dy = -FOG_VISION_RADIUS; dy <= FOG_VISION_RADIUS; dy += 1) {
          const y = j + dy;
          if (y >= 0 && y < m) {
            visible[x * m + y] = 1;
          }
        }
      }
    }
  }
  return visible;
};

/**
 * 迷雾远征过滤：视野内按全视野编码；视野外只保留地形
 * （山 201 / 中立沼泽 204 / 其余一律按中立空地 200），兵力与孤军状态归零，
 * 并附带 fog 扁平数组（1 = 迷雾格）供前端加暗色遮罩。
 */
const buildFoggedVisionArrays = (state: BoardState, visible: number[]): FlatMapArrays & { fog: number[] } => {
  const full = buildFullVisionArrays(state);
  const fog = new Array<number>(state.n * state.m).fill(0);
  for (let idx = 0; idx < visible.length; idx += 1) {
    if (visible[idx]) {
      continue;
    }
    fog[idx] = 1;
    const terrain = full.grid_type[idx];
    full.grid_type[idx] = terrain === 201 || terrain === 204 ? terrain : 200;
    full.army_cnt[idx] = 0;
    full.isolated[idx] = 0;
  }
  return { ...full, fog };
};

export { computeTeamVisibility, buildFoggedVisionArrays };
