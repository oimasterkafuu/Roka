'use strict';

const { project } = require('./board.cjs');
const { preview } = require('./rules.cjs');
const { connectedToAnchor } = require('./board.cjs');

const GRACE = 10;
function cloneState(board) {
  return { n: board.n, m: board.m, grid: board.grid.slice(), army: board.army.slice(), isolated: board.isolated.slice(), isolatedAge: (board.isolatedAge || Array(board.size).fill(0)).slice(), teams: board.teams, turn: Number(board.turn || 0), playerId: board.playerId };
}
function terrainKind(code) { if (code === 201) return 'mountain'; if (code === 204) return 'swamp'; if (code >= 151 && code <= 199) return 'swamp'; return 'land'; }
function ownerOf(code) { if (code >= 1 && code <= 49) return code; if (code >= 51 && code <= 99) return code - 50; if (code >= 101 && code <= 149) return code - 100; if (code >= 151 && code <= 199) return code - 150; return 0; }
function grow(s) {
  const burst = s.turn >= 26 && s.turn <= 50, plain = s.turn % 50 === 0;
  for (let i = 0; i < s.grid.length; i += 1) {
    const owner = ownerOf(s.grid[i]); if (!owner || s.isolated[i]) continue;
    const kind = s.grid[i] >= 101 && s.grid[i] <= 149 ? 'crown' : s.grid[i] >= 51 && s.grid[i] <= 99 ? 'city' : terrainKind(s.grid[i]);
    if (kind === 'crown' || kind === 'city' && plain || kind === 'land' && (plain || burst)) s.army[i] += 1;
  }
}
function applyConnectivity(s, teams = new Map()) {
  const owners = new Set(s.grid.map(ownerOf).filter(Boolean));
  for (const owner of owners) {
    const b = project({ n: s.n, m: s.m, grid: s.grid, army: s.army, isolated: s.isolated, teams }, owner);
    const connected = connectedToAnchor(b, owner);
    for (let i = 0; i < s.grid.length; i += 1) {
      if (ownerOf(s.grid[i]) !== owner) continue;
      if (connected.has(i)) { if (s.isolated[i]) s.army[i] *= 2; s.isolated[i] = 0; s.isolatedAge[i] = 0; continue; }
      if (!s.isolated[i]) { s.army[i] = s.army[i] === 1 ? 1 : Math.floor(s.army[i] / 2); s.isolated[i] = 1; s.isolatedAge[i] = 1; continue; }
      s.isolatedAge[i] += 1;
      if (s.isolatedAge[i] > GRACE && s.isolatedAge[i] % 2 === 1) {
        s.army[i] -= Math.max(1, Math.ceil(s.army[i] * 0.05));
        if (s.army[i] <= 0) { s.grid[i] = 200; s.army[i] = 0; s.isolated[i] = 0; s.isolatedAge[i] = 0; }
      }
    }
  }
}
function applyAction(s, action, playerId) {
  const b = project({ n: s.n, m: s.m, grid: s.grid, army: s.army, isolated: s.isolated, teams: s.teams, turn: s.turn }, playerId);
  const result = preview(b, action); if (!result.ok) return { state: s, result };
  s.grid = result.grid; s.army = result.army; s.isolated = result.isolated; return { state: s, result };
}
function simulateTick(board, actions = new Map(), options = {}) {
  const deadline = options.deadline ?? (Date.now() + 40), s = cloneState(board); s.turn += 1;
  if (Date.now() > deadline) return { state: s, timeout: true };
  grow(s);
  const players = [...actions.keys()].sort((a, b) => (s.turn % 2 ? b - a : a - b));
  const results = [];
  for (const player of players) { if (Date.now() > deadline) return { state: s, results, timeout: true }; const r = applyAction(s, actions.get(player), player); results.push({ player, ...r }); }
  applyConnectivity(s, s.teams);
  return { state: s, results, timeout: false };
}
function successor(board, action, playerId = board.playerId, options = {}) { return simulateTick(board, new Map([[playerId, action]]), options); }
module.exports = { cloneState, grow, applyConnectivity, applyAction, simulateTick, successor };
