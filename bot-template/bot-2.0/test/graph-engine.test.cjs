'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard, cutAnalysis, articulationCells, kindOf, ownerOf } = require('../bot/board.cjs');
const { computePush, previewAttack, previewBuild } = require('../bot/rules.cjs');

function board(grid, army, n = 3, m = 5) {
  return makeBoard({ n, m, grid, army, isolated: Array(n * m).fill(0), fog: Array(n * m).fill(0), leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }] }, 1);
}

test('decodes neutral offset forms and server snapshot forms', () => {
  assert.equal(kindOf(0), 'plain');
  assert.equal(kindOf(50), 'city');
  assert.equal(kindOf(100), 'crown');
  assert.equal(kindOf(150), 'swamp');
  assert.equal(kindOf(200), 'plain');
  assert.equal(kindOf(201), 'mountain');
  assert.equal(kindOf(204), 'swamp');
  assert.equal(ownerOf(1 + 150), 1);
  assert.equal(ownerOf(101), 1);
});

test('fog keeps public terrain passable while hiding ownership', () => {
  const b = makeBoard({
    n: 1,
    m: 4,
    grid: [101, 200, 201, 204],
    army: [4, 0, 0, 0],
    isolated: [0, 0, 0, 0],
    fog: [0, 1, 1, 1],
    leaderboard: [{ id: 1, team: 1 }],
  }, 1);
  assert.equal(b.owner(1), 0);
  assert.equal(b.kind(1), 'plain');
  assert.equal(b.passable(1), true);
  assert.equal(b.passable(2), false);
  assert.equal(b.passable(3), true);
});

test('virtual-anchor Tarjan does not mark a bridge between two anchors as harmful', () => {
  const b = board([101, 1, 101, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200], Array(15).fill(1));
  const cut = cutAnalysis(b, 1);
  assert.equal(cut.land[1], 0);
  assert.equal(cut.mass[1], 0);
  assert.equal(cut.separates(1, 0), false);
  assert.equal(articulationCells(b, 1).has(1), false);
});

test('cut analysis counts an anchorless branch and exposes separates', () => {
  // Crown--bridge--branch. Removing index 1 strands indices 2 and 3.
  const b = board([101, 1, 1, 1, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200], [5, 2, 7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const cut = cutAnalysis(b, 1);
  assert.equal(cut.land[1], 2);
  assert.equal(cut.mass[1], 10);
  assert.equal(cut.separates(1, 2), true);
  assert.equal(cut.separates(1, 3), true);
  assert.equal(cut.separates(1, 0), false);
});

test('preview failed attack consumes pushed stack on both sides', () => {
  const b = board([101, 2], [4, 5], 1, 2);
  const result = previewAttack(b, { kind: 'attack', x: 0, y: 0, dx: 0, dy: 1, mode: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.send, 3);
  assert.deepEqual(result.army, [1, 2]);
});

test('preview build is single-action and leaves connectivity/tick to caller', () => {
  const b = board([101, 1], [10, 50], 1, 2);
  const result = previewBuild(b, { kind: 'build', x: 0, y: 1, op: 'b' });
  assert.equal(result.ok, true);
  assert.equal(result.after.kind(1), 'city');
  assert.equal(result.after.army[1], 0);
});
