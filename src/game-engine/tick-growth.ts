import { Grid, Tile } from '../map/map-core';

/**
 * 全局爆发期：第 26 ~ 50 Tick，正常状态的普通领土每 Tick 额外 +1 兵。
 */
const BURST_START_TURN = 26;
const BURST_END_TURN = 50;

/**
 * 普通地块基础经济：每 50 Tick +1 兵。
 */
const PLAIN_GROWTH_INTERVAL = 50;

interface TickGrowthInput {
  turn: number;
  n: number;
  m: number;
  gridType: Grid<Tile>;
  owner: Grid<number>;
  armyCnt: Grid<number>;
  isolated: Grid<boolean>;
  pstat: number[];
  leftGameValue: number;
}

/**
 * Roka 生产规则：
 * - 主城（crown, -2）：每 Tick +1，不生产于孤军之外（主城本身即锚点，恒为正常）。
 * - 普通地块（0）：每 50 Tick +1（仅正常状态）；爆发期内每 Tick 额外 +1。
 * - 指挥所（city, -1）：每 50 Tick +1（仅正常状态），不享受爆发期加成。
 * - 沼泽（2）/ 孤军 / 中立格：永远不生产兵力。
 */
const applyTickGrowth = (input: TickGrowthInput): void => {
  const burst = input.turn >= BURST_START_TURN && input.turn <= BURST_END_TURN;
  const plainGrowth = input.turn % PLAIN_GROWTH_INTERVAL === 0;
  if (!burst && !plainGrowth) {
    for (let i = 0; i < input.n; i += 1) {
      for (let j = 0; j < input.m; j += 1) {
        if (input.gridType[i][j] !== -2) {
          continue;
        }
        const ownerId = input.owner[i][j];
        if (ownerId > 0 && input.pstat[ownerId - 1] !== input.leftGameValue) {
          input.armyCnt[i][j] += 1;
        }
      }
    }
    return;
  }

  for (let i = 0; i < input.n; i += 1) {
    for (let j = 0; j < input.m; j += 1) {
      const tile = input.gridType[i][j];
      const ownerId = input.owner[i][j];
      if (ownerId <= 0 || input.pstat[ownerId - 1] === input.leftGameValue) {
        continue;
      }
      if (tile === -2) {
        input.armyCnt[i][j] += 1;
        continue;
      }
      if (tile === -1) {
        // 指挥所与普通地块一样每 50 Tick +1（仅正常状态），但不吃爆发期加成。
        if (plainGrowth && !input.isolated[i][j]) {
          input.armyCnt[i][j] += 1;
        }
        continue;
      }
      if (tile !== 0 || input.isolated[i][j]) {
        continue;
      }
      if (plainGrowth) {
        input.armyCnt[i][j] += 1;
      }
      if (burst) {
        input.armyCnt[i][j] += 1;
      }
    }
  }
};

export { applyTickGrowth, BURST_START_TURN, BURST_END_TURN, PLAIN_GROWTH_INTERVAL };
