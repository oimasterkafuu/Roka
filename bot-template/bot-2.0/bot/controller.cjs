'use strict';

const { makeBoard } = require('./board.cjs');
const { plan, recover, secureDecision, growth, isMazeBoard, mazeActionGuard } = require('./planner.cjs');
const { preview } = require('./rules.cjs');
const { createDeadline, DEFAULT_BUDGET_MS } = require('./deadline.cjs');
const { chooseKillStrike } = require('./duel/strike.cjs');

function envDecisionBudget() {
  const raw = process.env.BOT_DECISION_BUDGET_MS;
  if (raw === undefined || String(raw).trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function resolveDecisionBudget(options) {
  const fromOptions = Number(options?.decisionBudgetMs);
  if (Number.isFinite(fromOptions)) return Math.max(0, fromOptions);
  return envDecisionBudget() ?? DEFAULT_BUDGET_MS;
}

function ownFrontierCells(board) {
  const cells = [];
  for (let at = 0; at < board.size; at += 1) if (board.own(at) && !board.isolated[at]) cells.push(at);
  return cells;
}

function attackAction(board, from, to, mode) {
  const source = board.xy(from);
  const target = board.xy(to);
  return {
    kind: 'attack',
    x: source.x,
    y: source.y,
    dx: target.x,
    dy: target.y,
    mode,
    half: mode === 1,
  };
}

// Cheapest legal capture/expansion step.  Friendly transfers are skipped: a
// timeout fallback should take ground, not shuffle supply.
function cheapestLegalMove(board) {
  let best = null;
  for (let at = 0; at < board.size; at += 1) {
    if (!board.own(at) || board.isolated[at]) continue;
    for (const to of board.neighbors(at)) {
      if (!board.passable(to)) continue;
      const owner = board.owner(to);
      if (owner > 0 && board.sameTeam(owner, board.playerId)) continue;
      const action = attackAction(board, at, to, 0);
      const result = preview(board, action);
      if (!result.ok || !result.captured) continue;
      if (!best || result.send < best.send) best = { action, send: result.send };
    }
  }
  return best?.action || null;
}

// A timeout should still decapitate when the killing blow is already adjacent.
function lethalCrownAttack(board) {
  let best = null;
  for (let at = 0; at < board.size; at += 1) {
    if (!board.own(at) || board.isolated[at]) continue;
    for (const to of board.neighbors(at)) {
      if (!board.enemy(to) || board.kind(to) !== 'crown') continue;
      const action = attackAction(board, at, to, 2);
      const result = preview(board, action);
      if (!result.ok || !result.captured || !result.decap) continue;
      if (!best || result.send < best.send) best = { action, send: result.send };
    }
  }
  return best?.action || null;
}

// Cheap, always-legal last resort for an expired decision budget.  Ranking:
// lethal crown strike, planner `recover` suggestion, cheapest legal capture.
// Every candidate is validated with `preview` before it is returned.  `recover`
// runs against a scratch copy so a timeout cannot corrupt campaign state.
function legalFallback(board, memory) {
  const crown = lethalCrownAttack(board);
  if (crown && preview(board, crown).ok) return crown;
  const own = ownFrontierCells(board);
  if (own.length) {
    const scratch = { ...memory };
    if (memory.campaign) scratch.campaign = { ...memory.campaign };
    if (memory.delivery) scratch.delivery = { ...memory.delivery };
    if (memory.blocked) scratch.blocked = { ...memory.blocked };
    const recovered = recover(board, scratch, own);
    const secured = recovered ? secureDecision(board, recovered) : null;
    if (secured?.action && preview(board, secured.action).ok) return secured.action;
  }
  return cheapestLegalMove(board);
}

function createController(playerId, options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const decisionBudgetMs = resolveDecisionBudget(options);
  // Finish layer, on by default.  `duelStrike:false` (BOT_DUEL_STRIKE=0) keeps
  // the controller byte-identical to the planner-only behaviour for A/B runs.
  const duelStrike = options.duelStrike !== false;
  const memory = {
    budgetExceeded: 0,
    fallbacks: 0,
    lastDecisionMs: 0,
    maxDecisionMs: 0,
    playerId: Number(playerId) || 0,
    lastTurn: -1,
    target: null,
    staging: null,
    branch: 'none',
    strikes: 0,
    lastStrike: null,
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
    const startedAt = clock();
    // One budget per decision, not per game: a slow tick must never bleed into
    // the next one.  `expired()` probes the clock, `check()` is amortized.
    const deadline = createDeadline({
      budgetMs: decisionBudgetMs,
      now: clock,
      marginMs: options.marginMs,
      checkInterval: options.checkInterval,
    });
    let decision;
    if (deadline.expired()) {
      decision = { action: null, branch: 'deadline' };
    } else {
      // Finish layer: when the race-gated kill-path search proves a crown
      // strike we can land first, take its first step instead of letting the
      // heuristic planner miss the window.  The strike is skipped once the
      // budget is spent; if the search itself is slow, the timeout fallback
      // below still applies because `preview` re-validates the action.
      // The maze reroute guard is bypassed on purpose: a proven kill must not
      // be replaced by a lane change, and the strike is re-derived next turn
      // anyway.
      const strike = duelStrike && !deadline.check() ? chooseKillStrike(board) : null;
      // Do not preempt the planner's own campaign on the very same crown and
      // stack.  There the planner is already marching, and its build/supply
      // phases are what keeps that stack alive; re-deciding the same march one
      // tick earlier measurably throws games (replay regression).  The layer is
      // for windows the planner does not cover, not for racing it.
      const ownedByCampaign =
        Boolean(strike) &&
        Boolean(memory.campaign) &&
        memory.campaign.crown === strike.plan.goal &&
        memory.campaign.at === strike.plan.tap;
      if (strike && !ownedByCampaign) {
        decision = { action: strike.action, branch: strike.branch };
        memory.strikes += 1;
        memory.lastStrike = {
          eta: strike.plan.eta,
          goal: strike.plan.goal,
          tap: strike.plan.tap,
          decap: strike.plan.decap,
          theirEta: strike.race.theirEta,
        };
      } else {
        decision = secureDecision(board, plan(board, memory, deadline));
        decision = mazeActionGuard(board, memory, decision);
      }
    }
    if (!decision.action && !deadline.expired()) {
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
    } else if (decision.action) {
      memory.noActionTurns = 0;
    }
    const timedOut = deadline.expired();
    if (timedOut) memory.budgetExceeded += 1;
    let action = decision.action;
    if (timedOut && (!action || !preview(board, action).ok)) {
      const cheap = legalFallback(board, memory);
      if (cheap) {
        action = cheap;
        decision = { action: cheap, branch: 'deadline-fallback' };
        memory.fallbacks += 1;
      }
    }
    memory.branch = decision.branch;
    memory.byBranch[decision.branch] = (memory.byBranch[decision.branch] || 0) + 1;
    // Wall-clock accounting is reported through stats() for imbalance hunting.
    const elapsed = Math.max(0, clock() - startedAt);
    memory.lastDecisionMs = elapsed;
    if (elapsed > memory.maxDecisionMs) memory.maxDecisionMs = elapsed;
    if (!action) return null;
    const result = preview(board, action);
    if (!result.ok) {
      memory.rejected += 1;
      return null;
    }
    if (action.kind === 'attack' && memory.campaign) {
      const source = board.idx(action.x, action.y);
      const target = board.idx(action.dx, action.dy);
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
    recordMazeAction(board, action);
    memory.actions += 1;
    return action;
  }

  function reset() {
    memory.lastTurn = -1;
    memory.target = null;
    memory.staging = null;
    memory.branch = 'none';
    memory.strikes = 0;
    memory.lastStrike = null;
    memory.actions = 0;
    memory.rejected = 0;
    memory.noActionTurns = 0;
    memory.maxNoActionStreak = 0;
    memory.budgetExceeded = 0;
    memory.fallbacks = 0;
    memory.lastDecisionMs = 0;
    memory.maxDecisionMs = 0;
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

module.exports = { createController, chooseAction, legalFallback };
