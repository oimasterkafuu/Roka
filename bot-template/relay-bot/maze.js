'use strict';

// Maze (corridor) layer for the Bot(3.0) 1v1 planner.
//
// On a corridor board a tick is serial: exactly one order leaves the empire,
// so a one-unit transfer that shuffles troops between two garrisons costs the
// whole tick and cannot change any outcome. Relay already routes through walls
// correctly (`campaignRoute` pays for resistance), but it lacks three things a
// corridor needs:
//
//   1. lane bookkeeping - the same edge (or its reversal) must not be selected
//      again and again. `mazeActionGuard` in Bot(2.0) records the recent edge
//      history and forces a different lane unless the move is a real cut,
//      defence or crown capture (kept below as an opt-in layer);
//   2. the open-map front planner is the wrong shape for a corridor: on a maze
//      it stalls the empire on a single rival crown while the opponent paints
//      the tree, and in a mirror it freezes both sides into a trickle. The
//      generic expansion path that the fog and multi-line seats already use
//      wins these boards instead, so a maze board keeps it for much longer.
//
// Everything here is gated by `isMazeBoard`, so open maps (random, archipelago,
// mediterranean) keep the exact previous scoring. The measured effect of each
// switch is recorded in BOT3_MAZE.md.

const WALL = 201;
// Random maps use ~12% mountains (0.24 * 0.5 mountain ratio), a maze is a
// spanning tree and ends up near 50% walls. 30% separates them safely.
const MAZE_WALL_RATIO = 0.3;
// Tick at which the open-map front planner may take over a corridor board.
// 250 is the measured optimum: the first 250 ticks are the paint phase that a
// maze rewards, and the concentrated front still finishes the endgame.
const SINGLE_FROM = Number(process.env.BOT3_MAZE_SINGLE_FROM ?? 250);
// Opt-in lane discipline (port of bot-2.0 `mazeActionGuard`). Off by default:
// blocking a lane costs relay a whole serial tick and measured -11.5pp on the
// maze matrix, so the bookkeeping is kept for a narrower future experiment.
const LANE = process.env.BOT3_MAZE_LANE === '1';

function isMazeBoard(b) {
  const size = b.size;
  if (!size) return false;
  let walls = 0;
  for (let i = 0; i < size; i++) if (b.grid_type[i] === WALL) walls++;
  return walls > size * MAZE_WALL_RATIO;
}

function laneState(b) {
  return (b.lane ??= {
    from: -1,
    to: -1,
    edge: '',
    streak: 0,
    recent: [],
    blockedUntil: Object.create(null),
    blocked: 0,
    reroutes: 0,
  });
}

function edgeKey(from, to) {
  return from < to ? `${from}:${to}` : `${to}:${from}`;
}

// Record the order that was actually emitted. Builds keep the recent list so a
// funding branch cannot immediately reverse the lane the column just used.
function recordLane(b, from, to) {
  const state = laneState(b);
  if (from === undefined || to === undefined || from === to) return;
  const key = edgeKey(from, to);
  state.streak = state.edge === key ? state.streak + 1 : 1;
  state.edge = key;
  state.from = from;
  state.to = to;
  state.recent = [...state.recent.filter((item) => item !== key), key].slice(-10);
}

// A lane is blocked when it only repeats ground we already covered: the exact
// reverse of the last move, a third consecutive use of the same edge, or an
// edge still cooling down after a block. A move that still makes progress
// toward the objective (a corridor has dead ends, a column must walk back) and
// any real cut/capture/defence is always allowed.
function laneBlocked(b, from, to, turn, forward, emergency) {
  if (emergency || forward) return false;
  const state = laneState(b);
  const key = edgeKey(from, to);
  const reverse = state.from === to && state.to === from;
  const repeated = state.edge === key && state.streak >= 2;
  const cooldown = Number(state.blockedUntil[key] || 0) > turn;
  if (!reverse && !repeated && !cooldown) return false;
  state.blockedUntil[key] = turn + (reverse ? 4 : 3);
  state.blocked += 1;
  state.reroutes += 1;
  return true;
}

module.exports = {
  isMazeBoard,
  laneState,
  laneBlocked,
  recordLane,
  MAZE_WALL_RATIO,
  LANE,
  SINGLE_FROM,
};
