'use strict';
const { candidates } = require('./candidates.cjs');
const { scoreAction, bestResponse } = require('./evaluate.cjs');
// Bounded own beam, exhaustive legal one-action enemy replies within each node.
function rankBySearch(board) {
  const started = process.hrtime.bigint();
  const ranked = candidates(board).map((action) => ({ action, quick: scoreAction(board, action) }))
    .sort((a, b) => b.quick - a.quick).slice(0, 10)
    .map(({ action }) => ({ action, ...bestResponse(board, action, candidates) }))
    .sort((a, b) => b.score - a.score);
  board.searchStats = { candidates: ranked.length, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
  return ranked;
}
function chooseBySearch(board) { return rankBySearch(board)[0]?.action || null; }
module.exports = { chooseBySearch, rankBySearch };
