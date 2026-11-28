import { ReplayPatch, ReplayPatchPayload, ReplayFrame } from '../types';

const getDiff = (next: number[], prev: number[]): number[] => {
  const diff: number[] = [];
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] !== prev[i]) {
      diff.push(i, next[i]);
    }
  }
  return diff;
};

const buildReplayPatchPayload = (
  frame: ReplayFrame,
  gridDiff: number[],
  armyDiff: number[],
  isolatedDiff: number[],
): ReplayPatchPayload => ({
  grid_type: gridDiff,
  army_cnt: armyDiff,
  isolated: isolatedDiff,
  is_diff: true,
  lst_moves: frame.lst_moves,
  lst_move: frame.lst_move,
  leaderboard: frame.leaderboard,
  turn: frame.turn,
  kills: frame.kills,
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
