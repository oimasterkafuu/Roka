'use strict';

const { connectedSet, kindOf, makeBoard } = require('./board.cjs');

function invalid(reason) {
  return { ok: false, reason };
}

function computePush(board, from, to, mode = 0) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 2) return 0;
  const total = Math.max(0, Number(board.army[from]) || 0);
  const cap = Math.max(0, total - 1);
  if (mode === 2) return cap;
  let reserve = 0;
  for (const next of board.neighbors(from)) {
    if (next === to || board.kind(next) === 'mountain') continue;
    if (board.kind(next) === 'unknown') return 0;
    const nextOwner = board.owner(next);
    if (nextOwner > 0 && board.sameTeam(board.owner(from), nextOwner)) continue;
    reserve += board.army[next] - 1;
  }
  const smart = Math.max(0, total - reserve - 1);
  return Math.min(cap, mode === 1 ? Math.floor(smart / 2) : smart);
}

function validMove(board, action) {
  if (!action || !Number.isInteger(action.x) || !Number.isInteger(action.y) || !Number.isInteger(action.dx) || !Number.isInteger(action.dy)) return false;
  if (action.x < 0 || action.x >= board.n || action.y < 0 || action.y >= board.m || action.dx < 0 || action.dx >= board.n || action.dy < 0 || action.dy >= board.m) return false;
  return board.neighbors(board.idx(action.x, action.y)).includes(board.idx(action.dx, action.dy));
}

function previewAttack(board, action) {
  if (!validMove(board, action)) return invalid('bounds-or-adjacency');
  const from = board.idx(action.x, action.y);
  const to = board.idx(action.dx, action.dy);
  const mode = action.mode ?? (action.half ? 1 : 0);
  if (![0, 1, 2].includes(mode)) return invalid('mode');
  if (!board.own(from) || board.isolated[from]) return invalid('source');
  if (!board.passable(to)) return invalid('target');
  const send = computePush(board, from, to, mode);
  if (send <= 0) return invalid('zero-send');
  const grid = board.grid.slice();
  const army = board.army.slice();
  const isolated = board.isolated.slice();
  const defender = board.owner(to);
  const targetArmy = army[to];
  const friendly = defender > 0 && board.sameTeam(board.playerId, defender);
  let captured = false;
  let decap = false;
  army[from] -= send;
  if (friendly) {
    army[to] += send;
    if (defender !== board.playerId && board.kind(to) !== 'crown') grid[to] = board.playerId + (board.kind(to) === 'city' ? 50 : board.kind(to) === 'swamp' ? 150 : 0);
  } else if (send > targetArmy) {
    captured = true;
    const targetKind = kindOf(board.grid[to]);
    grid[to] = board.playerId + (targetKind === 'swamp' ? 150 : 0);
    army[to] = send - targetArmy;
    isolated[to] = 0;
    if (targetKind === 'crown' && defender > 0) {
      let crowns = 0;
      for (let at = 0; at < board.size; at += 1) if (board.owner(at) === defender && kindOf(board.grid[at]) === 'crown') crowns += 1;
      decap = crowns === 1;
      if (decap) {
        for (let at = 0; at < board.size; at += 1) {
          if (board.owner(at) !== defender || at === to) continue;
          if (['city', 'crown'].includes(kindOf(board.grid[at]))) grid[at] = defender;
          // teardownEmpire halves only a newly isolated cell.  A cell that was
          // already isolated has already paid that cost and merely continues
          // its grace/decay timeline.
          if (!isolated[at]) {
            army[at] = army[at] === 1 ? 1 : Math.floor(army[at] / 2);
          }
          isolated[at] = 1;
          if (army[at] <= 0) {
            grid[at] = kindOf(board.grid[at]) === 'swamp' ? 204 : 200;
            isolated[at] = 0;
          }
        }
      }
    }
  } else {
    // The server consumes the entire pushed stack on a failed attack and
    // removes the same amount from the defender (never below zero).
    army[to] = Math.max(0, army[to] - send);
  }
  const after = makeBoard({ ...board, grid, army, isolated, fog: board.fog }, board.playerId);
  return { ok: true, from, to, send, mode, captured, decap, grid, army, isolated, after };
}

function previewBuild(board, action) {
  if (!action || !Number.isInteger(action.x) || !Number.isInteger(action.y)) return invalid('coordinates');
  if (action.x < 0 || action.x >= board.n || action.y < 0 || action.y >= board.m) return invalid('bounds');
  const at = board.idx(action.x, action.y);
  if (!board.own(at) || board.isolated[at] || board.army[at] < 50) return invalid('site');
  const op = action.op || 'b';
  const expected = op === 'c' ? 'city' : 'plain';
  if (!['b', 'c'].includes(op) || board.kind(at) !== expected) return invalid('building');
  const grid = board.grid.slice();
  const army = board.army.slice();
  grid[at] = board.playerId + (op === 'c' ? 100 : 50);
  army[at] -= 50;
  return { ok: true, index: at, op, grid, army, isolated: board.isolated.slice(), after: makeBoard({ ...board, grid, army }, board.playerId) };
}

function preview(board, action) {
  return action?.kind === 'build' ? previewBuild(board, action) : previewAttack(board, action);
}

function connectedAfter(board, result, owner = board.playerId) {
  if (!result?.ok) return new Set();
  return connectedSet(result.after, owner);
}

function actionCoordinates(board, from, to, mode = 0) {
  const a = board.xy(from);
  const b = board.xy(to);
  return { kind: 'attack', x: a.x, y: a.y, dx: b.x, dy: b.y, mode, half: mode === 1 };
}

module.exports = { computePush, preview, previewAttack, previewBuild, connectedAfter, actionCoordinates };
