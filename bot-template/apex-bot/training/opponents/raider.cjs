'use strict';
const { candidates } = require('../../bot/candidates.cjs');
const { threatMap } = require('../../bot/threat.cjs');
const { project } = require('../../bot/board.cjs');
const { preview } = require('../../bot/rules.cjs');
function createRaider(playerId) {
  const memory = { lastTurn: -1, actions: 0 };
  return (raw) => {
    const board = raw.teamOf ? raw : project(raw, playerId);
    if (board.playerId !== Number(playerId) || board.dead || board.ended || board.turn === memory.lastTurn) return null;
    memory.lastTurn = board.turn;
    const threats = threatMap(board, playerId);
    const moves = candidates(board).filter((action) => {
      const result = preview(board, action);
      return result.ok && (action.kind === 'attack' && (result.captured || board.friendly(board.playerId, board.owner(result.to))));
    });
    moves.sort((a, b) => {
      const ra = preview(board, a), rb = preview(board, b);
      const ta = threats.threats.find((t) => t.crown === ra.to), tb = threats.threats.find((t) => t.crown === rb.to);
      const ca = board.kind(ra.to) === 'crown' ? 1000 : board.kind(ra.to) === 'city' ? 200 : 0;
      const cb = board.kind(rb.to) === 'crown' ? 1000 : board.kind(rb.to) === 'city' ? 200 : 0;
      return (tb?.dangerous ? 500 : 0) + cb - ((ta?.dangerous ? 500 : 0) + ca);
    });
    const action = moves[0] || candidates(board).find((a) => preview(board, a).ok) || null;
    if (action) memory.actions += 1;
    return action;
  };
}
module.exports = { createRaider };
