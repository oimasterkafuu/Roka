'use strict';
const { project, connectedToAnchor } = require('./board.cjs');
const bad = (reason) => ({ ok: false, reason });
function validXY(board, x, y) { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < board.n && y < board.m; }
function movable(board, i) { return board.own(i) && !board.isolated[i] && connectedToAnchor(board).has(i); }
// Mirrors computePush (src/game-engine.ts). Empty neutral neighbours contribute -1.
function computePush(board, from, to, mode) {
  const cap = Math.max(0, board.army[from] - 1);
  if (mode === 2) return cap;
  let defense = 0;
  for (const j of board.neighbors(from)) {
    if (j === to || board.kind(j) === 'mountain') continue;
    // Unknown neighbours cannot supply a reliable reservation estimate.
    if (board.kind(j) === 'unknown') return 0;
    if (!board.friendly(board.owner(from), board.owner(j))) defense += board.army[j] - 1;
  }
  const theoretical = Math.max(0, board.army[from] - defense - 1);
  return Math.min(cap, mode === 1 ? Math.floor(theoretical / 2) : theoretical);
}
function previewAttack(board, action) {
  if (!validXY(board, action.x, action.y) || !validXY(board, action.dx, action.dy)) return bad('bounds');
  const from = board.idx(action.x, action.y), to = board.idx(action.dx, action.dy), mode = action.mode ?? 0;
  if (![0, 1, 2].includes(mode)) return bad('mode');
  if (!movable(board, from) || !board.neighbors(from).includes(to)) return bad('illegal-source');
  if (!board.visible[to] || ['unknown', 'mountain'].includes(board.kind(to))) return bad('illegal-target');
  const send = computePush(board, from, to, mode);
  if (send < 1) return bad('no-send');
  const grid = board.grid.slice(), army = board.army.slice(), isolated = board.isolated.slice();
  const defender = board.owner(to), target = army[to];
  let captured = false, decap = false;
  army[from] -= send;
  if (board.friendly(board.playerId, defender)) {
    army[to] += send;
    if (defender !== board.playerId && board.kind(to) !== 'crown') grid[to] = board.playerId + (board.kind(to) === 'city' ? 50 : board.kind(to) === 'swamp' ? 150 : 0);
  } else if (send > target) {
    captured = true;
    const wasCrown = board.kind(to) === 'crown';
    grid[to] = board.playerId + (board.kind(to) === 'swamp' ? 150 : 0);
    army[to] = send - target;
    isolated[to] = 0;
    decap = wasCrown && defender > 0 && !grid.some((code) => code === defender + 100) && !board.fog.some(Boolean);
    if (decap) {
      // Last-crown kill tears down buildings, halves normal troops and isolates the empire.
      for (let i = 0; i < board.size; i++) if (i !== to && board.owner(i) === defender) {
        if (['city', 'crown'].includes(board.kind(i))) grid[i] = defender;
        if (!isolated[i]) army[i] = army[i] === 1 ? 1 : Math.floor(army[i] / 2);
        isolated[i] = 1;
        if (army[i] <= 0) { grid[i] = board.kind(i) === 'swamp' ? 204 : 200; isolated[i] = 0; }
      }
    }
  } else army[to] -= send;
  return { ok: true, from, to, send, captured, decap, mode, grid, army, isolated };
}
function previewBuild(board, action) {
  if (!validXY(board, action.x, action.y)) return bad('bounds');
  const i = board.idx(action.x, action.y), op = action.op ?? 'b';
  if (!['b', 'c'].includes(op)) return bad('op');
  if (!board.own(i) || !board.visible[i]) return bad('illegal-site');
  if (board.isolated[i] || !connectedToAnchor(board).has(i)) return bad('cutoff');
  if (board.kind(i) !== (op === 'c' ? 'city' : 'land')) return bad('type');
  if (board.army[i] < 50) return bad('cost');
  const grid = board.grid.slice(), army = board.army.slice();
  grid[i] = board.playerId + (op === 'c' ? 100 : 50); army[i] -= 50;
  return { ok: true, index: i, op, grid, army, isolated: board.isolated.slice() };
}
function preview(board, action) { return action?.kind === 'build' ? previewBuild(board, action) : action ? previewAttack(board, action) : bad('empty'); }
// Action-only successor: growth/turn order/periodic isolated decay are not simulated.
function successor(board, result, playerId = board.playerId) {
  return project({ ...board, grid: result.grid, army: result.army, isolated: result.isolated }, playerId);
}
module.exports = { preview, previewAttack, previewBuild, computePush, successor, movable };
