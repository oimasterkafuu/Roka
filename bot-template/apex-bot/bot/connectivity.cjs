'use strict';

const { connectedToAnchor } = require('./board.cjs');

function teamCells(board, owner = board.playerId) {
  const team = board.teamOf(owner);
  const out = new Set();
  for (let i = 0; i < board.size; i += 1) {
    if (!board.visible[i] || board.owner(i) <= 0 || board.teamOf(board.owner(i)) !== team) continue;
    out.add(i);
  }
  return out;
}

function articulationPoints(board, owner = board.playerId) {
  const cells = teamCells(board, owner);
  const anchors = [...cells].filter((i) => ['city', 'crown'].includes(board.kind(i)));
  const points = new Set();
  // Small, deterministic removal test is safer than a Tarjan implementation on fogged graphs.
  for (const cut of cells) {
    if (anchors.length < 2 || !anchors.includes(cut)) {
      const seen = new Set();
      const queue = anchors.filter((i) => i !== cut);
      queue.forEach((i) => seen.add(i));
      for (let h = 0; h < queue.length; h += 1) for (const j of board.neighbors(queue[h])) {
        if (j === cut || seen.has(j) || !cells.has(j)) continue;
        seen.add(j); queue.push(j);
      }
      if ([...cells].some((i) => i !== cut && !seen.has(i))) points.add(cut);
    }
  }
  return points;
}

function connectivityReport(board, owner = board.playerId) {
  const connected = connectedToAnchor(board, owner);
  const points = articulationPoints(board, owner);
  const isolated = new Set();
  for (const i of teamCells(board, owner)) if (!connected.has(i)) isolated.add(i);
  return { connected, points, isolated, healthy: isolated.size === 0 };
}

function actionProtectsConnectivity(board, action, owner = board.playerId) {
  if (!action || action.kind !== 'attack') return false;
  const before = connectivityReport(board, owner);
  if (before.points.size === 0 && before.isolated.size === 0) return false;
  const { preview } = require('./rules.cjs');
  const result = preview(board, action);
  if (!result.ok) return false;
  const after = connectivityReport(require('./board.cjs').project({ ...board, grid: result.grid, army: result.army, isolated: result.isolated }, owner), owner);
  return after.isolated.size < before.isolated.size || [...before.points].some((i) => after.connected.has(i));
}

module.exports = { teamCells, articulationPoints, connectivityReport, actionProtectsConnectivity };
