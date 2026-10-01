'use strict';

const { makeBoard } = require('./board.cjs');
const { plan, growth } = require('./planner.cjs');
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
    byBranch: Object.create(null),
    threatDistance: Object.create(null),
  };

  function choose(raw) {
    const board = raw?.neighbors ? raw : makeBoard(raw, memory.playerId);
    if (!board.playerId || board.dead || board.ended || board.turn === memory.lastTurn) return null;
    memory.lastTurn = board.turn;
    for (let i = 0; i < board.size; i += 1) board.army[i] += growth(board, i, 1);
    const decision = plan(board, memory);
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
    memory.byBranch = Object.create(null);
    memory.threatDistance = Object.create(null);
    memory.campaign = null;
    memory.delivery = null;
    memory.blocked = null;
    memory.site = undefined;
    memory.buildPlan = null;
    memory.home = undefined;
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
