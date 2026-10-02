'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard, connectedSet, articulationCells } = require('../bot/board.cjs');
const { computePush, preview } = require('../bot/rules.cjs');
const { createController } = require('../bot/controller.cjs');
const { createOpponentStats } = require('../strategy.js');

function frame(grid, army, n = 3, m = 5, turn = 60) {
  return { n, m, grid, army, isolated: Array(n * m).fill(0), fog: Array(n * m).fill(0), turn, leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }] };
}

test('connectedSet follows anchors and does not cross enemy cells', () => {
  const board = makeBoard(frame([
    101, 1, 1, 2, 102,
    200, 200, 200, 200, 200,
    200, 200, 200, 200, 200,
  ], Array(15).fill(1)), 1);
  assert.deepEqual([...connectedSet(board, 1)].sort((a, b) => a - b), [0, 1, 2]);
});

test('computePush preserves the server smart split rule', () => {
  const board = makeBoard(frame([
    101, 1, 1, 200, 200,
    200, 200, 200, 200, 200,
    200, 200, 200, 200, 200,
  ], [10, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
  assert.equal(computePush(board, 1, 2, 0), 2);
  assert.equal(computePush(board, 1, 2, 2), 2);
});

test('preview can capture a crown and marks decapitation', () => {
  const board = makeBoard(frame([
    101, 1, 102, 200, 200,
    200, 200, 200, 200, 200,
    200, 200, 200, 200, 200,
  ], [10, 20, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
  const result = preview(board, { kind: 'attack', x: 0, y: 1, dx: 0, dy: 2, mode: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.captured, true);
  assert.equal(result.decap, true);
});

test('articulationCells ignores a bridge that only separates two anchors', () => {
  const board = makeBoard(frame([
    101, 1, 101, 200, 200,
    200, 200, 200, 200, 200,
    200, 200, 200, 200, 200,
  ], Array(15).fill(1)), 1);
  assert.equal(articulationCells(board, 1).has(1), false);
});

test('controller returns one legal action and keeps a target across turns', () => {
  const controller = createController(1);
  const first = controller.choose(frame([
    101, 1, 1, 2, 102,
    200, 200, 200, 200, 200,
    200, 200, 200, 200, 200,
  ], [30, 12, 8, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3, 5, 60));
  assert.ok(first);
  assert.ok(['attack', 'build'].includes(first.kind));
  const stats = controller.stats();
  assert.equal(stats.actions, 1);
  assert.equal(stats.rejected, 0);
});

test('tracks opponent loss streaks and opens a cooldown after repeated losses', () => {
  let now = 1_000;
  const stats = createOpponentStats(() => now);
  const defeated = [
    { id: 1, team: 1, uid: 'Apex', class_: 'dead', dead: 1 },
    { id: 2, team: 2, uid: 'human', class_: '', dead: 0 },
  ];
  stats.record(defeated, 1);
  stats.record(defeated, 1);
  stats.record(defeated, 1);
  const blocked = stats.blocked([{ uid: 'human' }]);
  assert.ok(blocked);
  assert.equal(blocked.losses, 3);
  assert.equal(blocked.consecutiveLosses, 3);
  now += 181_000;
  assert.equal(stats.blocked([{ uid: 'human' }]), null);
});

test('a win resets only that opponent\'s consecutive loss streak', () => {
  const stats = createOpponentStats(() => 1_000);
  const loss = [
    { id: 1, team: 1, uid: 'Apex', class_: 'dead', dead: 1 },
    { id: 2, team: 2, uid: 'human', class_: '', dead: 0 },
  ];
  const win = [
    { id: 1, team: 1, uid: 'Apex', class_: '', dead: 0 },
    { id: 2, team: 2, uid: 'human', class_: 'dead', dead: 1 },
  ];
  stats.record(loss, 1);
  stats.record(loss, 1);
  stats.record(win, 1);
  const snapshot = stats.snapshot().human;
  assert.equal(snapshot.losses, 2);
  assert.equal(snapshot.wins, 1);
  assert.equal(snapshot.consecutiveLosses, 0);
});
