'use strict';

const { makeBoard } = require('./board.cjs');
const { plan, recover, secureDecision, growth, isMazeBoard, mazeActionGuard } = require('./planner.cjs');
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
    mazeHistory: {
      lastFrom: -1,
      lastTo: -1,
      edge: '',
      edgeStreak: 0,
      recent: [],
      blockedUntil: Object.create(null),
      reroutes: 0,
      holds: 0,
      holdStreak: 0,
    },
  };

  function recordMazeAction(board, action) {
    if (!memory.maze) return;
    const history = memory.mazeHistory;
    if (action.kind !== 'attack') {
      history.lastFrom = -1;
      history.lastTo = -1;
      history.edge = '';
      history.edgeStreak = 0;
      // Preserve recent corridor edges across a build/hold.  Resetting this
      // list lets a funding branch immediately reverse the same maze lane.
      history.holdStreak = 0;
      return;
    }
    const from = board.idx(action.x, action.y);
    const to = board.idx(action.dx, action.dy);
    const edge = from < to ? `${from}:${to}` : `${to}:${from}`;
    history.edgeStreak = history.edge === edge ? history.edgeStreak + 1 : 1;
    history.edge = edge;
    history.lastFrom = from;
    history.lastTo = to;
    history.recent = [...history.recent.filter((item) => item !== edge), edge].slice(-10);
  }

  function choose(raw) {
    const board = raw?.neighbors ? raw : makeBoard(raw, memory.playerId);
    if (!board.playerId || board.dead || board.ended || board.turn === memory.lastTurn) return null;
    memory.lastTurn = board.turn;
    if (memory.maze === undefined) memory.maze = isMazeBoard(board);
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
    let decision = secureDecision(board, plan(board, memory));
    decision = mazeActionGuard(board, memory, decision);
    if (!decision.action) {
      memory.noActionTurns += 1;
      // A short no-op is intentional during muster.  A longer one means the
      // selected corridor or logistics cursor is stale; recover locally
      // instead of appearing to idle forever on maze maps.
      const recoveryThreshold = memory.maze ? 4 : board.size >= 800 ? 8 : 12;
      if (memory.noActionTurns >= recoveryThreshold) {
        const fallback = recover(
          board,
          memory,
          [...Array(board.size).keys()].filter((at) => board.own(at) && !board.isolated[at]),
        );
        if (fallback) {
          decision = mazeActionGuard(board, memory, secureDecision(board, fallback));
          if (decision.action) memory.noActionTurns = 0;
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
    if (decision.action.kind === 'attack' && memory.campaign) {
      const source = board.idx(decision.action.x, decision.action.y);
      const target = board.idx(decision.action.dx, decision.action.dy);
      if (source === memory.campaign.at) {
        // `preview` is authoritative for the local frame.  Advancing the
        // campaign cursor merely because an attack was emitted used to leave
        // it pointing at an enemy cell after a failed corridor push.  The
        // next plan then treated the stale enemy cell as a valid rally and
        // could spend the rest of a maze game expanding on a side branch.
        const hiddenAdvance = Number(board.fog?.[target]) !== 0 && board.passable(target);
        if ((result.after?.own(target) && !result.after.isolated[target]) || hiddenAdvance) {
          memory.campaign.at = target;
          // A maze reroute is evidence that the cached branch was blocked or
          // became too expensive.  Keep a successful ordinary march locked,
          // but force a fresh route after this explicit escape so the next
          // decision cannot continue from a stale branch.
          if (memory.maze && /maze-reroute/.test(String(memory.branch || ''))) {
            memory.campaign.route = null;
          }
          if (memory.branch !== 'muster') memory.campaign.phase = 'attack';
        } else if (memory.branch !== 'muster') {
          memory.campaign.phase = 'gather';
          memory.delivery = null;
          if (memory.maze) memory.campaign.route = null;
        }
      }
    }
    recordMazeAction(board, decision.action);
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
    memory.maze = undefined;
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
    memory.mazeHistory = {
      lastFrom: -1,
      lastTo: -1,
      edge: '',
      edgeStreak: 0,
      recent: [],
      blockedUntil: Object.create(null),
      reroutes: 0,
      holds: 0,
      holdStreak: 0,
    };
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
