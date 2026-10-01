'use strict';
const { project } = require('./board.cjs');
const { rankBySearch } = require('./search.cjs');
const { candidates } = require('./candidates.cjs');
const { preview } = require('./rules.cjs');
const { threatMap } = require('./threat.cjs');

function defensiveRoute(board, threats) {
  const route = new Set();
  for (const threat of threats.threatenedCrowns) for (const cell of threat.path || []) route.add(cell);
  return route;
}

function createController(playerId) {
  const memory = { lastTurn: -1, moves: new Map(), searchMs: 0, searches: 0 };
  function choose(frame) {
    const board = project(frame, playerId ?? frame.playerId);
    if (board.dead || board.ended || board.playerId <= 0) return null;
    const turn = Number(frame.turn ?? 0);
    if (memory.lastTurn === turn) return null;
    memory.lastTurn = turn;
    for (const [key, at] of memory.moves) if (turn - at > 3) memory.moves.delete(key);
    const threats = threatMap(board);
    const warning = threats.threatenedCrowns.length > 0;
    const route = defensiveRoute(board, threats);
    const ranked = rankBySearch(board);
    memory.searchMs += board.searchStats?.elapsedMs || 0;
    memory.searches += 1;
    const acceptable = (candidate) => {
      const { action, result } = candidate;
      if (action.kind === 'build') return !warning && candidate.score >= 0;
      const routeAction = route.has(result.from) || route.has(result.to);
      if (!board.friendly(board.playerId, board.owner(result.to)) && !result.captured && !(warning && routeAction)) return false;
      if (warning && !route.has(result.from) && !route.has(result.to)) return false;
      const reverse = `${result.to}>${result.from}`;
      const urgent = result.decap || (board.kind(result.to) === 'crown' && board.own(result.to) && board.neighbors(result.to).some(board.enemy));
      if (!urgent && memory.moves.has(reverse)) return false;
      if (candidate.score < 0 && !result.decap && !warning) return false;
      return true;
    };
    for (const candidate of ranked) {
      if (!acceptable(candidate)) continue;
      const { action, result } = candidate;
      memory.moves.set(`${result.from}>${result.to}`, turn);
      return action;
    }
    if (warning) {
      // Search can reject every defensive merge because its short reply score
      // is negative. Pick the closest legal transport toward a threatened route.
      const fallback = candidates(board).map((action) => ({ action, result: preview(board, action) }))
        .filter(({ action, result }) => action.kind === 'attack' && result.ok && board.friendly(board.playerId, board.owner(result.to)) && route.has(result.to))
        .sort((a, b) => b.result.send - a.result.send)[0];
      if (fallback) return fallback.action;
    }
    return null;
  }
  return { choose, stats() { return { searchMs: memory.searchMs, searches: memory.searches }; }, reset() { memory.lastTurn = -1; memory.moves.clear(); } };
}
function chooseAction(frame, playerId) { return createController(playerId).choose(frame); }
module.exports = { createController, chooseAction };
