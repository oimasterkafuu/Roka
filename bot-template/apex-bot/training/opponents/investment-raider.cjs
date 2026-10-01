'use strict';

const { project } = require('../../bot/board.cjs');
const { candidates } = require('../../bot/candidates.cjs');
const { preview } = require('../../bot/rules.cjs');

function traversable(board, i) {
  return board.visible[i] && !['unknown', 'mountain'].includes(board.kind(i));
}

function crownPaths(board) {
  const crowns = [];
  for (let i = 0; i < board.size; i += 1) {
    if (traversable(board, i) && board.enemy(i) && board.kind(i) === 'crown') crowns.push(i);
  }
  return crowns.map((crown) => {
    const distance = Array(board.size).fill(Infinity);
    distance[crown] = 0;
    const queue = [crown];
    for (let h = 0; h < queue.length; h += 1) {
      for (const next of board.neighbors(queue[h])) {
        if (distance[next] !== Infinity || !traversable(board, next)) continue;
        distance[next] = distance[queue[h]] + 1;
        queue.push(next);
      }
    }
    return { crown, distance };
  }).sort((a, b) => a.distance.reduce((x, y) => Math.min(x, y), Infinity) - b.distance.reduce((x, y) => Math.min(x, y), Infinity));
}

function createInvestmentRaider(playerId, options = {}) {
  const memory = {
    playerId: Number(playerId), phase: 'invest', lastTurn: -1, actions: 0,
    raidStarted: null, targetCrown: null, estimatedArrival: null,
  };
  const investUntil = Number.isInteger(options.investUntil) ? options.investUntil : 250;

  const choose = (raw) => {
    const board = project(raw, memory.playerId);
    if (board.playerId !== memory.playerId || board.dead || board.ended || board.turn === memory.lastTurn) return null;
    memory.lastTurn = Number(board.turn);
    const all = candidates(board).filter((action) => preview(board, action).ok);
    const paths = crownPaths(board);
    const target = paths[0];
    const targetCrown = target?.crown ?? null;
    const targetDistance = target ? target.distance : null;
    const countKind = (kind) => board.grid.reduce((count, code, i) => count + (board.visible[i] && board.owner(i) === memory.playerId && board.kind(i) === kind ? 1 : 0), 0);
    const invested = board.turn >= investUntil || countKind('city') >= 3 || countKind('crown') >= 2;
    if (memory.phase === 'invest' && invested) memory.phase = 'raid';

    let ranked;
    if (memory.phase === 'invest') {
      ranked = all.map((action) => {
        const result = preview(board, action);
        const targetKind = action.kind === 'attack' ? board.kind(result.to) : null;
        const neutral = targetKind === 'neutral' ? 3000 : 0;
        const build = action.kind === 'build' ? (targetKind === null ? 1500 : 0) : 0;
        const merge = action.kind === 'attack' && board.friendly(memory.playerId, board.owner(result.to)) ? 500 : 0;
        const distance = action.kind === 'attack' && targetDistance ? targetDistance[result.to] : Infinity;
        return { action, score: neutral + build + merge - (Number.isFinite(distance) ? distance : 0) };
      });
    } else {
      ranked = all.map((action) => {
        const result = preview(board, action);
        const distance = action.kind === 'attack' && targetDistance ? targetDistance[result.to] : Infinity;
        const onRoute = Number.isFinite(distance) ? 100000 - distance * 1000 : 0;
        const crown = action.kind === 'attack' && result.to === targetCrown ? 1000000 : 0;
        const enemy = action.kind === 'attack' && board.enemy(result.to) ? 10000 : 0;
        const mass = action.kind === 'attack' ? board.army[result.from] : 0;
        const mode = action.kind === 'attack' && action.mode === 2 ? 1000 : 0;
        return { action, score: crown + onRoute + enemy + mass + mode };
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    const selected = ranked[0]?.action || null;
    if (selected) {
      const result = preview(board, selected);
      if (memory.phase === 'raid' && memory.raidStarted === null && selected.kind === 'attack' && board.enemy(result.to)) {
        memory.raidStarted = board.turn;
        memory.targetCrown = targetCrown;
        memory.estimatedArrival = Number.isFinite(targetDistance?.[result.to]) ? board.turn + targetDistance[result.to] : null;
      }
      memory.actions += 1;
    }
    return selected;
  };
  choose.stats = () => ({ ...memory });
  return choose;
}

module.exports = { createInvestmentRaider, crownPaths };
