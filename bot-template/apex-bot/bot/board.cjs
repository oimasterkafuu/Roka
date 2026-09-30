'use strict';

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
function index(n, m, x, y) { return x * m + y; }
function ownerOf(code) {
  if (!Number.isInteger(code) || code === 200 || code === 201 || code === 204 || code >= 202) return 0;
  if (code >= 1 && code <= 49) return code;
  if (code >= 51 && code <= 99) return code - 50;
  if (code >= 101 && code <= 149) return code - 100;
  if (code >= 151 && code <= 199) return code - 150;
  return 0;
}
function kindOf(code) {
  if (code === 201) return 'mountain';
  if (code === 200) return 'neutral';
  if (code === 204) return 'swamp';
  if (code >= 151 && code <= 199) return 'swamp';
  if (code >= 101 && code <= 149) return 'crown';
  if (code >= 51 && code <= 99) return 'city';
  if (code >= 1 && code <= 49) return 'land';
  return 'unknown';
}
function isMountain(code) { return kindOf(code) === 'mountain'; }
function isSwamp(code) { return kindOf(code) === 'swamp'; }
function isKnown(code) { return kindOf(code) !== 'unknown'; }
function neighbors(n, m, i) {
  const x = Math.floor(i / m), y = i % m, out = [];
  for (const [dx, dy] of DIRS) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < n && ny < m) out.push(index(n, m, nx, ny)); }
  return out;
}
function project(frame, playerId) {
  const n = Number(frame?.n), m = Number(frame?.m), size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000) throw new Error('invalid board');
  const grid = Array.isArray(frame.grid_type) ? frame.grid_type : frame.grid;
  const army = Array.isArray(frame.army_cnt) ? frame.army_cnt : frame.army;
  if (!Array.isArray(grid) || !Array.isArray(army) || grid.length !== size || army.length !== size) throw new Error('incomplete board');
  const fog = Array.isArray(frame.fog) ? frame.fog.slice() : Array(size).fill(0);
  if (fog.length !== size || fog.some((v) => !Number.isFinite(v))) throw new Error('invalid fog');
  const isolated = Array.isArray(frame.isolated) && frame.isolated.length === size ? frame.isolated.slice() : Array(size).fill(0);
  const teams = frame.teams instanceof Map ? new Map(frame.teams) : new Map((frame.leaderboard || []).map((p) => [Number(p.id), Number(p.team) || Number(p.id)]));
  const visible = fog.map((v) => v === 0);
  const board = { n, m, size, grid: grid.slice(), army: army.slice(), isolated, fog, visible, playerId: Number(playerId ?? frame.playerId) || 0, teams, turn: frame.turn ?? -1, dead: Boolean(frame.dead), ended: Boolean(frame.ended || frame.game_end), leaderboard: frame.leaderboard || [] };
  board.owner = (i) => visible[i] && isKnown(board.grid[i]) ? ownerOf(board.grid[i]) : 0;
  board.kind = (i) => visible[i] ? kindOf(board.grid[i]) : 'unknown';
  board.teamOf = (owner) => teams.get(owner) || owner;
  board.friendly = (a, b) => a > 0 && b > 0 && board.teamOf(a) === board.teamOf(b);
  board.own = (i) => visible[i] && board.owner(i) === board.playerId;
  board.enemy = (i) => visible[i] && board.owner(i) > 0 && !board.friendly(board.playerId, board.owner(i));
  // Immutable projected snapshots own their caches; never reuse across a changed grid.
  const adjacency = Array.from({ length: size }, (_, i) => neighbors(n, m, i));
  board.connections = new Map();
  board.neighbors = (i) => adjacency[i];
  board.xy = (i) => ({ x: Math.floor(i / m), y: i % m });
  board.idx = (x, y) => index(n, m, x, y);
  board.withPlayer = (p) => project({ ...board, grid: board.grid, army: board.army, fog: board.fog, isolated: board.isolated, teams }, p);
  return board;
}
function connectedToAnchor(board, owner = board.playerId) {
  const seen = new Set(), queue = [];
  const team = board.teamOf(owner);
  if (board.connections.has(team)) return board.connections.get(team);
  board.connections.set(team, seen);
  for (let i = 0; i < board.size; i++) {
    if (board.visible[i] && board.owner(i) > 0 && board.teamOf(board.owner(i)) === team && ['city', 'crown'].includes(board.kind(i))) seen.add(i), queue.push(i);
  }
  for (let h = 0; h < queue.length; h++) for (const j of board.neighbors(queue[h])) {
    if (seen.has(j) || !board.visible[j] || board.owner(j) <= 0 || board.teamOf(board.owner(j)) !== team || board.kind(j) === 'mountain') continue;
    seen.add(j); queue.push(j);
  }
  return seen;
}
module.exports = { DIRS, ownerOf, kindOf, isMountain, isSwamp, isKnown, neighbors, project, connectedToAnchor };
