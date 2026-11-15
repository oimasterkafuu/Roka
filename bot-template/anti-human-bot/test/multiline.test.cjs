'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BoardState } = require('../bot/state.cjs');
const { chooseActions } = require('../bot/multiline.cjs');
const { createArena } = require('../training/arena.cjs');
const move = (x, y, dx, dy) => ({ kind: 'attack', x, y, dx, dy, mode: 2 });
function state() {
  const s = new BoardState({ n: 3, m: 5, player_ids: ['me'], multi_line: true, next_seq: 17 }, 'me');
  s.apply({ turn: 60, is_diff: false, grid_type: [101, 1, 200, 200, 200, 1, 1, 200, 200, 200, 1, 51, 200, 200, 200],
    army_cnt: [20, 80, 0, 0, 0, 20, 20, 0, 0, 0, 51, 101, 0, 0, 0], lst_moves: [] });
  return s;
}
test('global seq mirror removes non-prefix receipts including discarded operations', () => {
  const s = state();
  s.enqueue(move(0, 0, 0, 1)); s.enqueue(move(0, 1, 0, 2)); s.enqueue({ kind: 'build', x: 2, y: 0 });
  assert.equal(s.nextSeq, 20);
  s.apply({ turn: 61, is_diff: true, grid_type: [], army_cnt: [], lst_moves: [19, 17] });
  assert.deepEqual(s.queue.map(op => op.seq), [18]);
  assert.deepEqual(s.removedOps.map(op => op.seq), [17, 19]);
  s.apply({ turn: 61, is_diff: true, grid_type: [], army_cnt: [], lst_moves: [17, 19] });
  assert.deepEqual(s.queue.map(op => op.seq), [18]);
});
test('rebind restores queue and monotonic next_seq without sharing init objects', () => {
  const ops = [{ kind: 'b', seq: 25, x: 0, y: 0 }];
  const s = new BoardState({ n: 1, m: 1, next_seq: 26, queue_ops: ops }, 'me');
  ops[0].x = 9;
  assert.equal(s.queue[0].x, 0); assert.equal(s.nextSeq, 26);
});
test('portfolio uses disjoint resources and exact build/upgrade thresholds', () => {
  const s = state();
  const actions = chooseActions(s, move(0, 1, 0, 2));
  assert.ok(actions.some(a => a.kind === 'build' && a.op === 'b' && a.x === 2));
  assert.ok(actions.some(a => a.kind === 'build' && a.op === 'c'));
  const used = new Set();
  for (const a of actions) {
    const cells = [a.x * s.m + a.y];
    if (a.kind === 'attack') cells.push(a.dx * s.m + a.dy);
    for (const i of cells) { assert.ok(!used.has(i)); used.add(i); }
  }
  s.army[10] = 50; s.army[11] = 100;
  assert.ok(!chooseActions(s, null).some(a => a.kind === 'build' && a.x === 2));
});
test('pending chain and cycle endpoints are reserved, never cleared or duplicated', () => {
  const s = state();
  s.enqueue(move(0, 0, 0, 1)); s.enqueue(move(0, 1, 0, 0));
  const before = JSON.stringify(s.queue);
  const actions = chooseActions(s, move(0, 1, 0, 2));
  assert.equal(JSON.stringify(s.queue), before);
  assert.ok(actions.every(a => a.x !== 0));
});
test('single-line returns exactly the original action', () => {
  const s = state(); s.multiLine = false;
  const a = move(0, 0, 0, 1);
  assert.deepEqual(chooseActions(s, a), [a]);
  assert.deepEqual(chooseActions(s, null), []);
});
function fixture(multiLine) {
  const a = createArena({ multiLine });
  const e = a.engine;
  e.n = 2; e.m = 4; e.turn = 60;
  e.owner = [[1, 1, 1, 2], [1, 1, 1, 0]];
  e.gridType = [[-2, 0, 0, -2], [0, -1, 0, 0]];
  e.armyCnt = [[100, 20, 20, 100], [51, 101, 20, 0]];
  e.isolated = [[false, false, false, false], [false, false, false, false]];
  e.isolatedAge = [[0, 0, 0, 0], [0, 0, 0, 0]];
  e.st = [[false, false, false, false], [false, false, false, false]];
  for (let p = 0; p < 2; p++) e.emitInitMap(`arena-${p}`, { n: 2, m: 4, player_ids: ['arena-0', 'arena-1'], multi_line: multiLine });
  e.sendMap(false);
  return a;
}
test('v3 executes independent attack/build/upgrade in one tick; single-line serializes', () => {
  for (const multi of [true, false]) {
    const a = fixture(multi);
    a.tick([[move(1, 2, 1, 3), { kind: 'build', op: 'b', x: 1, y: 0 }, { kind: 'build', op: 'c', x: 1, y: 1 }], null]);
    assert.equal(a.engine.owner[1][3], 1);
    assert.equal(a.engine.gridType[1][0], multi ? -1 : 0);
    assert.equal(a.engine.gridType[1][1], multi ? -2 : -1);
    assert.equal(a.states[0].queue.length, multi ? 0 : 2);
    assert.equal(a.stats[0].attacks, 1);
    assert.equal(a.stats[0].builds, multi ? 1 : 0);
    assert.equal(a.stats[0].upgrades, multi ? 1 : 0);
    assert.equal(a.stats[0].rejected, 0);
  }
});
test('v3 chain waits for predecessor and same-source build waits for move', () => {
  const a = fixture(true);
  a.tick([[move(0, 0, 0, 1), move(0, 1, 0, 2), { kind: 'build', x: 0, y: 1, op: 'b' }], null]);
  assert.deepEqual(a.states[0].queue.map(op => op.seq), [2, 3]);
  a.tick(); assert.deepEqual(a.states[0].queue.map(op => op.seq), [3]);
  a.tick(); assert.equal(a.states[0].queue.length, 0);
});
test('v3 breaks a queued cycle and acknowledges invalid commands without claiming success', () => {
  const a = fixture(true);
  a.tick([[move(0, 0, 0, 1), move(0, 1, 0, 0), { kind: 'build', x: 1, y: 3, op: 'c' }], null]);
  assert.deepEqual(a.states[0].queue.map(op => op.seq), [2]);
  assert.deepEqual(a.states[0].lastMove.seqs, [1, 3]);
  a.tick(); assert.equal(a.states[0].queue.length, 0);
});
test('available crown capture precedes ordinary work and independent construction continues', () => {
  const s = state(); s.grid[2] = 102; s.army[2] = 2;
  const actions = chooseActions(s, { kind: 'build', x: 2, y: 0, op: 'b' });
  assert.equal(actions[0].reason, '直接推冠');
  assert.ok(actions.some(a => a.kind === 'build'));
});
test('all-in cannot spend the separate defense reserve', () => {
  const s = state(); s.grid[2] = 2; s.army[2] = 60;
  const unsafe = move(0, 1, 1, 1);
  const actions = chooseActions(s, unsafe);
  assert.ok(!actions.some(a => a.mode === 2 && a.x === 0 && a.y === 1));
});
test('client emits parallel roots once per turn and does not resend unacknowledged roots', () => {
  const { attachBot } = require('../bot/client.cjs');
  const handlers = new Map(), sent = [];
  const socket = { connected: true, on: (e, f) => handlers.set(e, f), off: e => handlers.delete(e), emit: (e, p) => sent.push([e, p]) };
  const bot = attachBot(socket, { log() {}, setInterval: () => 1, clearInterval() {} });
  handlers.get('set_id')('me');
  handlers.get('init_map')({ n: 3, m: 5, player_ids: ['me'], multi_line: true, next_seq: 30 });
  const s = state();
  const frame = { turn: 60, is_diff: false, grid_type: s.grid, army_cnt: s.army, lst_moves: [] };
  handlers.get('update')(frame);
  const ops = () => sent.filter(([e]) => e === 'attack' || e === 'build');
  const first = ops().length; assert.ok(first >= 2);
  handlers.get('update')(frame); assert.equal(ops().length, first);
  const roots = new Set(ops().map(([, p]) => `${p.x}:${p.y}`));
  handlers.get('update')({ ...frame, turn: 61 });
  for (const [, p] of ops().slice(first)) assert.ok(!roots.has(`${p.x}:${p.y}`));
  bot.close();
});
