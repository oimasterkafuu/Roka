'use strict';
const { project } = require('./board.cjs');
const { rankBySearch } = require('./search.cjs');
function createController(playerId) {
  const memory = { lastTurn: -1, moves: new Map(), searchMs: 0, searches: 0 };
  function choose(frame) {
    const board = project(frame, playerId ?? frame.playerId);
    if (board.dead || board.ended || board.playerId <= 0) return null;
    const turn = Number(frame.turn ?? 0);
    if (memory.lastTurn === turn) return null;
    memory.lastTurn = turn;
    for (const [key, at] of memory.moves) if (turn - at > 3) memory.moves.delete(key);
    const ranked = rankBySearch(board);
    memory.searchMs += board.searchStats?.elapsedMs || 0;
    memory.searches += 1;
    for (const candidate of ranked) {
      const { action, result } = candidate;
      if (action.kind === 'attack') {
        // No attrition-only sends: accumulate until a capture/merge is possible.
        if (!board.friendly(board.playerId, board.owner(result.to)) && !result.captured) continue;
        const reverse = `${result.to}>${result.from}`;
        const urgent = result.decap || (board.kind(result.to) === 'crown' && board.own(result.to) && board.neighbors(result.to).some(board.enemy));
        if (!urgent && memory.moves.has(reverse)) continue;
        if (candidate.score < 0 && !result.decap) continue;
        memory.moves.set(`${result.from}>${result.to}`, turn);
      } else if (candidate.score < 0) continue;
      return action;
    }
    return null;
  }
  return { choose, stats() { return { searchMs: memory.searchMs, searches: memory.searches }; }, reset() { memory.lastTurn = -1; memory.moves.clear(); } };
}
function chooseAction(frame, playerId) { return createController(playerId).choose(frame); }
module.exports = { createController, chooseAction };
