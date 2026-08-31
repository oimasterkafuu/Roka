import { Grid } from '../map/map-core';
import { LeaderboardEntry } from '../types';

interface LeaderboardInput {
  n: number;
  m: number;
  owner: Grid<number>;
  armyCnt: Grid<number>;
  playerSidsLength: number;
  names: string[];
  team: number[];
  pstat: number[];
  deadOrder: number[];
  leftGameValue: number;
}

const buildLeaderboard = (input: LeaderboardInput): LeaderboardEntry[] => {
  const playerValues = Array.from({ length: input.playerSidsLength }, () => [0, 0]);

  for (let i = 0; i < input.n; i += 1) {
    for (let j = 0; j < input.m; j += 1) {
      if (input.owner[i][j] > 0) {
        const idx = input.owner[i][j] - 1;
        playerValues[idx][0] += input.armyCnt[i][j];
        playerValues[idx][1] += 1;
      }
    }
  }

  const leaderboard: LeaderboardEntry[] = [];
  for (let i = 0; i < input.playerSidsLength; i += 1) {
    let className = '';
    if (input.pstat[i] === input.leftGameValue) {
      className = 'dead';
    } else if (input.pstat[i] !== 0) {
      className = 'afk';
    }
    if (input.team[i] !== 0) {
      leaderboard.push({
        team: input.team[i],
        uid: input.names[i],
        army: playerValues[i][0],
        land: playerValues[i][1],
        class_: className,
        dead: input.deadOrder[i],
        id: i + 1,
      });
    }
  }

  return leaderboard;
};

/**
 * 最终名次：严格分级排序，保证最后存活者一定是第一名。
 * 1. 存活者（dead === 0）永远排在被淘汰者之前；
 * 2. 被淘汰者之间按 deadOrder 降序（死得晚名次高）；
 * 3. deadOrder 相同（同 Tick 出局）时按 land 降序，再按 army 降序决胜。
 */
const buildFinalRank = (leaderboard: LeaderboardEntry[]): string[] =>
  [...leaderboard]
    .sort((a, b) => {
      const aliveA = a.dead === 0 ? 1 : 0;
      const aliveB = b.dead === 0 ? 1 : 0;
      if (aliveA !== aliveB) {
        return aliveB - aliveA;
      }
      if (a.dead !== b.dead) {
        return b.dead - a.dead;
      }
      if (a.land !== b.land) {
        return b.land - a.land;
      }
      return b.army - a.army;
    })
    .map((item) => item.uid);

export { buildFinalRank, buildLeaderboard };
