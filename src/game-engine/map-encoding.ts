import { Grid, Tile } from '../map/map-core';
import { ISOLATED_GRACE_TICKS } from './constants';

interface BoardState {
  n: number;
  m: number;
  gridType: Grid<Tile>;
  owner: Grid<number>;
  armyCnt: Grid<number>;
  isolated: Grid<boolean>;
  isolatedAge: Grid<number>;
}

interface FlatMapArrays {
  grid_type: number[];
  army_cnt: number[];
  isolated: number[];
}

const encodeFullVisionTile = (tile: Tile, owner: number, army: number): number => {
  if (tile === 2) {
    return owner === 0 ? 204 : owner + 150;
  }
  if (tile === 1) {
    return 201;
  }
  if (tile === -1) {
    return owner + 50;
  }
  if (tile === -2) {
    return owner + 100;
  }
  return owner || army ? owner : 200;
};

// Roka 无战雾：所有局面快照均为全图视野。
// isolated 编码：0 = 正常；1 = 断链宽限期（前 5 回合，快速闪烁、尚未衰减）；2 = 衰减期。
const buildFullVisionArrays = (state: BoardState): FlatMapArrays => {
  const gridTypeFlat: number[] = [];
  const armyCntFlat: number[] = [];
  const isolatedFlat: number[] = [];

  for (let i = 0; i < state.n; i += 1) {
    for (let j = 0; j < state.m; j += 1) {
      const owner = state.owner[i][j];
      const army = state.armyCnt[i][j];
      gridTypeFlat.push(encodeFullVisionTile(state.gridType[i][j], owner, army));
      armyCntFlat.push(army);
      isolatedFlat.push(
        state.isolated[i][j] && owner > 0 ? (state.isolatedAge[i][j] <= ISOLATED_GRACE_TICKS ? 1 : 2) : 0,
      );
    }
  }

  return {
    grid_type: gridTypeFlat,
    army_cnt: armyCntFlat,
    isolated: isolatedFlat,
  };
};

export { buildFullVisionArrays };
export type { FlatMapArrays };
