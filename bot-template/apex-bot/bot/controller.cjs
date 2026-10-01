'use strict';

const { makeBoard } = require('./board.cjs');
const { plan, recover, growth } = require('./planner.cjs');
const { preview } = require('./rules.cjs');

function createController(playerId) {
  const memory = {
    playerId: Number(playerId) || 0,
    lastTurn: -1,
    target: null,
    staging: null,
    branch: 'none',
    actions: 0,
    rejected: 0,
    noActionTurns: 0,
    maxNoActionStreak: 0,
    byBranch: Object.create(null),
    threatDistance: Object.create(null),
    enemyHome: undefined,
  };

  function choose(raw) {
    const board = raw?.neighbors ? raw : makeBoard(raw, memory.playerId);
    if (!board.playerId || board.dead || board.ended || board.turn === memory.lastTurn) return null;
    memory.lastTurn = board.turn;
    for (let i = 0; i < board.size; i += 1) board.army[i] += growth(board, i, 1);
    // The opponent's first crown is its strategic core.  Remember it before
    // the frontier fills with newly built crowns; long campaigns should not
    // spend every window on the nearest disposable outpost.
    if (!Number.isInteger(memory.enemyHome)) {
      for (let at = 0; at < board.size; at += 1) {
        if (board.enemy(at) && board.kind(at) === 'crown') {
          memory.enemyHome = at;
          break;
        }
      }
    }
    let decision = plan(board, memory);
    if (!decision.action) {
      memory.noActionTurns += 1;
      // A short no-op is intentional during muster.  A longer one means the
      // selected corridor or logistics cursor is stale; recover locally
      // instead of appearing to idle forever on maze maps.
      const recoveryThreshold = board.size >= 800 ? 8 : 12;
      if (memory.noActionTurns >= recoveryThreshold) {
        const fallback = recover(
          board,
          memory,
          [...Array(board.size).keys()].filter((at) => board.own(at) && !board.isolated[at]),
        );
        if (fallback) {
          decision = fallback;
          memory.noActionTurns = 0;
        }
      }
      memory.maxNoActionStreak = Math.max(memory.maxNoActionStreak, memory.noActionTurns);
    } else {
      memory.noActionTurns = 0;
    }
    memory.branch = decision.branch;

    memory.byBranch[decision.branch] = (memory.byBranch[decision.branch] || 0) + 1;
    if (!decision.action) return null;
    const result = preview(board, decision.action);
    if (!result.ok) {
      memory.rejected += 1;
      return null;
    }
    if (decision.action.kind === 'attack' && memory.campaign && board.idx(decision.action.x, decision.action.y) === memory.campaign.at) {
      memory.campaign.at = board.idx(decision.action.dx, decision.action.dy);
      if (memory.branch !== 'muster') memory.campaign.phase = 'attack';
    }
    memory.actions += 1;
    return decision.action;
  }

  function reset() {
    memory.lastTurn = -1;
    memory.target = null;
    memory.staging = null;
    memory.branch = 'none';
    memory.actions = 0;
    memory.rejected = 0;
    memory.noActionTurns = 0;
    memory.maxNoActionStreak = 0;
    memory.byBranch = Object.create(null);
    memory.threatDistance = Object.create(null);
    memory.enemyHome = undefined;
    memory.campaign = null;
    memory.delivery = null;
    memory.blocked = null;
    memory.swampRatio = undefined;
    memory.site = undefined;
    memory.buildPlan = null;
    memory.rearEconomy = null;
    memory.rearGrowthNext = undefined;
    memory.forwardGrowthNext = undefined;
    memory.broadGrowthNext = undefined;
    memory.home = undefined;
    memory.musterWaitTurns = 0;
  }

  return {
    choose,
    reset,
    stats: () => ({ ...memory, byBranch: { ...memory.byBranch } }),
  };
}

function chooseAction(raw, playerId) {
  return createController(playerId || raw?.playerId).choose(raw);
}

module.exports = { createController, chooseAction };
