'use strict';

function corridorFrame({ turn = 300, rearArmy = 72 } = {}) {
  return {
    n: 1, m: 10, turn,
    grid_type: [101, 1, 1, 1, 1, 2, 2, 2, 2, 102],
    army_cnt: [8, 12, 18, 24, 32, 4, 8, 16, rearArmy, 5],
    fog: Array(10).fill(0), isolated: Array(10).fill(0),
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  };
}

function deepStackFrame({ turn = 300 } = {}) {
  return {
    n: 1, m: 7, turn,
    grid_type: [101, 1, 1, 1, 1, 2, 102],
    army_cnt: [10, 1, 1, 1, 1, 100, 5],
    fog: Array(7).fill(0), isolated: Array(7).fill(0),
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  };
}

function sideRouteFrame({ turn = 300 } = {}) {
  return {
    n: 3, m: 7, turn,
    grid_type: [101, 1, 1, 200, 2, 2, 102, 1, 1, 200, 200, 2, 2, 1, 1, 1, 1, 200, 2, 2, 2],
    army_cnt: [8, 16, 20, 3, 5, 12, 5, 4, 8, 3, 3, 8, 12, 4, 4, 6, 10, 3, 6, 12, 8],
    fog: Array(21).fill(0), isolated: Array(21).fill(0),
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  };
}

function dualCrownFrame({ turn = 300 } = {}) {
  return {
    n: 2, m: 8, turn,
    grid_type: [101, 1, 1, 1, 2, 2, 102, 2, 101, 1, 1, 1, 2, 2, 102, 2],
    army_cnt: [8, 12, 18, 24, 6, 14, 20, 5, 7, 10, 16, 22, 6, 14, 18, 5],
    fog: Array(16).fill(0), isolated: Array(16).fill(0),
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  };
}

function metadata(frame, playerId = 1) {
  const crowns = frame.grid_type.map((code, index) => ({ code, index })).filter(({ code }) => code >= 101 && code <= 199 && code - 100 !== playerId);
  return {
    startTick: frame.turn,
    targetCrown: crowns[0]?.index ?? null,
    estimatedArrival: crowns[0] ? frame.turn + Math.max(1, Math.abs(crowns[0].index - (playerId === 1 ? 0 : frame.grid_type.length - 1))) : null,
  };
}

module.exports = { corridorFrame, deepStackFrame, sideRouteFrame, dualCrownFrame, metadata };
