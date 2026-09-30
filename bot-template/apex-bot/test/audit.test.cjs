'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs');
const { previewAttack } = require('../bot/rules.cjs');
const { candidates } = require('../bot/candidates.cjs');
const { rankBySearch } = require('../bot/search.cjs');
function b(grid, army, extra = {}) { return project({ n: 1, m: grid.length, grid_type: grid, army_cnt: army, ...extra }, 1); }
test('encoding distinguishes owned swamp, city, crown, neutral, mountain and unknown', () => {
  const board = b([151, 51, 101, 200, 201, 202], [10, 10, 10, 3, 3, 3]);
  assert.equal(board.owner(0), 1); assert.equal(board.kind(0), 'swamp');
  assert.equal(board.owner(1), 1); assert.equal(board.kind(1), 'city');
  assert.equal(board.owner(2), 1); assert.equal(board.kind(2), 'crown');
  assert.equal(board.owner(3), 0); assert.equal(board.kind(3), 'neutral');
  assert.equal(board.kind(4), 'mountain'); assert.equal(board.kind(5), 'unknown');
  assert.equal(previewAttack(board, { x: 0, y: 0, dx: 0, dy: 5, mode: 2 }).ok, false);
});
test('engine push formula accounts for non-target hostile neighbours', () => {
  const board = project({ n: 2, m: 2, grid_type: [101, 1, 2, 200], army_cnt: [20, 8, 4, 3] }, 1);
  assert.equal(previewAttack(board, { x: 0, y: 0, dx: 0, dy: 1, mode: 0 }).send, 16);
  assert.equal(previewAttack(board, { x: 0, y: 0, dx: 0, dy: 1, mode: 1 }).send, 8);
  assert.equal(previewAttack(board, { x: 0, y: 0, dx: 0, dy: 1, mode: 2 }).send, 19);
});
test('neutral and enemy capture preserve attacker remainder and destroy crown', () => {
  const neutral = b([101, 200], [10, 3]);
  const nr = previewAttack(neutral, { x: 0, y: 0, dx: 0, dy: 1, mode: 2 });
  assert.equal(nr.captured, true); assert.equal(nr.army[1], 6); assert.equal(nr.grid[1], 1);
  const crown = b([101, 102], [10, 3]);
  const cr = previewAttack(crown, { x: 0, y: 0, dx: 0, dy: 1, mode: 2 });
  assert.equal(cr.decap, true); assert.equal(cr.grid[1], 1); assert.equal(cr.army[1], 6);
});
test('search scores distinct post-action enemy replies rather than uniform penalty', () => {
  const board = b([101, 1, 102, 200], [20, 8, 9, 3]);
  const ranked = rankBySearch(board);
  assert.ok(ranked.length > 1);
  assert.ok(ranked.some((x) => x.reply && x.reply.action));
  assert.ok(new Set(ranked.map((x) => x.risk)).size > 1);
  assert.ok(candidates(board).every((a) => a.x === 0));
});
