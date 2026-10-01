'use strict';
const { connectedToAnchor } = require('./board.cjs');

function visiblePath(board, crown) {
  const distance = Array(board.size).fill(Infinity);
  const parent = Array(board.size).fill(-1);
  const queue = [crown];
  distance[crown] = 0;
  for (let h = 0; h < queue.length; h += 1) {
    const at = queue[h];
    for (const next of board.neighbors(at)) {
      if (distance[next] !== Infinity || !board.visible[next] || ['mountain', 'unknown'].includes(board.kind(next))) continue;
      distance[next] = distance[at] + 1;
      parent[next] = at;
      queue.push(next);
    }
  }
  return { distance, parent };
}

function pathToCrown(parent, source, crown) {
  const path = [];
  for (let at = source; at >= 0; at = parent[at]) {
    path.push(at);
    if (at === crown) break;
  }
  return path[path.length - 1] === crown ? path : null;
}

function estimate(board, crown, source, path) {
  const crownDefense = Math.max(1, board.army[crown]);
  let carried = Math.max(0, board.army[source] - 1);
  let routeLoss = 0;
  let pushes = 1;
  // Enemy territory is traversable without pretending it is ours. Known own
  // and neutral cells need to be taken before a stack can continue through.
  for (let p = 1; p < path.length - 1; p += 1) {
    const cell = path[p];
    if (board.enemy(cell)) continue;
    const entry = Math.max(1, board.army[cell] + 1);
    routeLoss += entry;
    carried -= entry;
    if (carried <= 0) return null;
  }
  const distance = path.length - 1;
  const adjacentPower = board.neighbors(crown).reduce((sum, i) => sum + (i !== source && board.enemy(i) ? Math.max(0, board.army[i] - 1) : 0), 0);
  // Growth while the route is being crossed is deliberately conservative: it
  // only raises the crown requirement, never the attacking arrival estimate.
  const required = crownDefense + 1 + Math.max(0, distance - 1);
  const arrival = carried + adjacentPower;
  const eta = distance + Math.max(0, Math.ceil(required / Math.max(1, board.army[source] - 1)) - 1);
  const closeEnough = eta <= 6 && arrival >= crownDefense * 0.5;
  const dangerous = eta <= 6 && (arrival >= required || closeEnough) || (distance <= 1 && arrival >= crownDefense * 0.5);
  return { crown, source, path, distance, eta, arrival, required, pushes, routeLoss, adjacentPower, dangerous };
}

function threatMap(board, owner = board.playerId) {
  if (!board._threatCache) board._threatCache = new Map();
  if (board._threatCache.has(owner)) return board._threatCache.get(owner);
  const crowns = [], sources = [];
  for (let i = 0; i < board.size; i += 1) {
    if (!board.visible[i]) continue;
    if (board.kind(i) === 'crown' && board.owner(i) === owner) crowns.push(i);
    if (board.enemy(i) && !board.isolated[i] && board.army[i] > 1) sources.push(i);
  }
  const threats = [];
  for (const crown of crowns) {
    const { distance, parent } = visiblePath(board, crown);
    for (const source of sources) {
      if (!Number.isFinite(distance[source]) || distance[source] < 1) continue;
      const path = pathToCrown(parent, source, crown);
      const candidate = path && estimate(board, crown, source, path);
      if (candidate) threats.push(candidate);
    }
  }
  threats.sort((a, b) => a.eta - b.eta || b.arrival - a.arrival || a.distance - b.distance);
  const connected = connectedToAnchor(board, owner);
  const threatenedCrowns = threats.filter((t) => t.dangerous);
  const result = {
    crowns,
    threats,
    threatenedCrowns,
    imminent: threatenedCrowns.length > 0,
    fatal: threatenedCrowns.some((t) => t.eta <= 1 && t.arrival >= t.required),
    connected,
  };
  board._threatCache.set(owner, result);
  return result;
}
function nearestThreat(board, owner = board.playerId) {
  return threatMap(board, owner).threats.filter((t) => t.dangerous).sort((a, b) => a.eta - b.eta || b.arrival - a.arrival)[0] || null;
}
module.exports = { threatMap, nearestThreat };
