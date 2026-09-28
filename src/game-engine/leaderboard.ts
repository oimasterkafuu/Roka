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
 * 终局名次比较器（buildFinalRank 与 buildFinalRankTeams 共用，口径须逐字一致）：
 * 1. 存活者（dead === 0）永远排在被淘汰者之前；
 * 2. 被淘汰者之间按 deadOrder 降序（死得晚名次高）；
 * 3. deadOrder 相同（同 Tick 出局）时按 land 降序，再按 army 降序决胜。
 */
const compareFinalRank = (a: LeaderboardEntry, b: LeaderboardEntry): number => {
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
};

/**
 * 最终名次：严格分级排序，保证最后存活者一定是第一名。
 */
const buildFinalRank = (leaderboard: LeaderboardEntry[]): string[] =>
  [...leaderboard].sort(compareFinalRank).map((item) => item.uid);

/**
 * 终局名次的队伍分组投影：先按 buildFinalRank 口径排出个人全序，
 * 再按队伍分组（保持全序中的相对顺序）。组序即队伍名次序
 * （整队存活者在前；全灭队以队内最后死亡成员为准，死得越晚名次越前），
 * 组内成员顺序即个人名次序。非组队局每队一人，天然退化为个人名次。
 * color 取组内最小玩家 id，与回放页标题的 inline-color-block 配色一致。
 */
const buildFinalRankTeams = (leaderboard: LeaderboardEntry[]): { members: string[]; color: number }[] => {
  const sorted = [...leaderboard].sort(compareFinalRank);
  const teams: { members: string[]; color: number }[] = [];
  const teamIndex = new Map<number, number>();
  for (const entry of sorted) {
    const index = teamIndex.get(entry.team);
    if (index === undefined) {
      teamIndex.set(entry.team, teams.length);
      teams.push({ members: [entry.uid], color: entry.id });
    } else {
      teams[index].members.push(entry.uid);
      teams[index].color = Math.min(teams[index].color, entry.id);
    }
  }
  return teams;
};

export { buildFinalRank, buildFinalRankTeams, buildLeaderboard };
