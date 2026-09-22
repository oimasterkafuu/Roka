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
 * 迷雾远征过滤（issue #52 语义）：
 * - 视野外（fog=1）：grid_type 只保留「沼泽 204 / 其余一律 201 未知占位」，
 *   不揭示真实地形；兵力与孤军状态归零；前端渲染为「山+问号」。
 * - 视野内：地形正常下发，但敌队的指挥所（owner+50）与主城（owner+100）
 *   降级为普通领地（owner），保留归属与兵力；中立城市（50）不受影响。
 * 并附带 fog 扁平数组（1 = 迷雾格）供前端加暗色遮罩与问号占位。
 */
const buildFoggedVisionArrays = (
  state: BoardState,
  visible: number[],
  teamOf: (ownerId: number) => number,
  teamId: number,
): FlatMapArrays & { fog: number[] } => {
  const full = buildFullVisionArrays(state);
  const fog = new Array<number>(state.n * state.m).fill(0);
  for (let idx = 0; idx < visible.length; idx += 1) {
    if (!visible[idx]) {
      fog[idx] = 1;
      const terrain = full.grid_type[idx];
      const isSwamp = terrain === 204 || (terrain >= 150 && terrain < 200);
      full.grid_type[idx] = isSwamp ? 204 : 201;
      full.army_cnt[idx] = 0;
      full.isolated[idx] = 0;
      continue;
    }
    const code = full.grid_type[idx];
    if (code > 50 && code < 150) {
      const ownerId = code % 50;
      if (ownerId > 0 && teamOf(ownerId) !== teamId) {
        full.grid_type[idx] = ownerId;
      }
    }
  }
  return { ...full, fog };
};

export { computeTeamVisibility, buildFoggedVisionArrays };
