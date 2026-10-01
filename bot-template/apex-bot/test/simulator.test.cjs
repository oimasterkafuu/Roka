'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs'); const { simulateTick } = require('../bot/simulator.cjs');
function board(turn = 0) { return project({ n: 1, m: 3, grid_type: [101, 1, 102], army_cnt: [5, 10, 2], turn }, 1); }
test('simulator applies crown growth before action and mirrors attack result', () => {
  const b = board(0); const out = simulateTick(b, new Map([[1, { kind: 'attack', x: 0, y: 1, dx: 0, dy: 2, mode: 2 }]]));
  assert.equal(out.state.turn, 1); assert.equal(out.state.army[0], 6); assert.equal(out.results[0].result.captured, true); assert.equal(out.state.grid[2], 1);
});
test('simulator applies burst and city/plain timing', () => {
  const b = project({ n: 1, m: 2, grid_type: [101, 1], army_cnt: [1, 1], turn: 25 }, 1);
  const out = simulateTick(b); assert.equal(out.state.army[0], 2); assert.equal(out.state.army[1], 2);
});
test('simulator enforces deadline and reports timeout', () => {
  const out = simulateTick(board(), new Map(), { deadline: Date.now() - 1 }); assert.equal(out.timeout, true);
});
