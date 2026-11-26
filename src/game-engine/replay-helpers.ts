import { LeaderboardEntry, ReplayPatch, ReplayPatchPayload, ReplayFrame } from '../types';

const getDiff = (next: number[], prev: number[]): number[] => {
  const diff: number[] = [];
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] !== prev[i]) {
      diff.push(i, next[i]);
    }
  }
  return diff;
};

const cloneMovePayload = (move: ReplayFrame['lst_move']): ReplayFrame['lst_move'] => ({
  x: move.x,
  y: move.y,
  dx: move.dx,
  dy: move.dy,
  half: move.half,
  mode: move.mode,
  op: move.op,
});

const cloneLeaderboard = (leaderboard: LeaderboardEntry[]): LeaderboardEntry[] =>
  leaderboard.map((item) => ({
    team: item.team,
    uid: item.uid,
    army: item.army,
    land: item.land,
    class_: item.class_,
    dead: item.dead,
    id: item.id,
  }));

const buildReplayPatchPayload = (
  frame: ReplayFrame,
  gridDiff: number[],
  armyDiff: number[],
  isolatedDiff: number[],
): ReplayPatchPayload => ({
  grid_type: gridDiff,
  army_cnt: armyDiff,
  isolated: isolatedDiff,
  lst_move: cloneMovePayload(frame.lst_move),
  leaderboard: cloneLeaderboard(frame.leaderboard),
  turn: frame.turn,
  kills: { ...frame.kills },
  game_end: frame.game_end,
});

const buildReplayPatch = (prevFrame: ReplayFrame, nextFrame: ReplayFrame): ReplayPatch => ({
  forward: buildReplayPatchPayload(
    nextFrame,
    getDiff(nextFrame.grid_type, prevFrame.grid_type),
    getDiff(nextFrame.army_cnt, prevFrame.army_cnt),
    getDiff(nextFrame.isolated, prevFrame.isolated),
  ),
  backward: buildReplayPatchPayload(
    prevFrame,
    getDiff(prevFrame.grid_type, nextFrame.grid_type),
    getDiff(prevFrame.army_cnt, nextFrame.army_cnt),
    getDiff(prevFrame.isolated, nextFrame.isolated),
  ),
});

export { buildReplayPatch, getDiff };
