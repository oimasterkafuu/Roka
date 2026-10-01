'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { actionCoordinates } = require('../bot/rules.cjs');
const { routeGuard } = require('../bot/planner.cjs');

function corridor(sourceArmy, enemyArmy) {
  return makeBoard({
    n: 3, m: 3,
    grid: [101, 1, 201, 2, 1, 2, 201, 201, 201],
    army: [5, 30, 0, enemyArmy, sourceArmy, 10, 0, 0, 0],
    isolated: Array(9).fill(0), fog: Array(9).fill(0),
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

test('campaign refuses a safe head move when an older bridge can strand it', () => {
  const b = corridor(100, 80);
  const action = actionCoordinates(b, 4, 5, 2);
  assert.deepEqual(routeGuard(b, action), { blocked: true, anchor: -1, cut: 4 });
});

test('campaign can anchor a threatened bridge before committing the column', () => {
  const b = corridor(200, 110);
  const action = actionCoordinates(b, 4, 5, 2);
  assert.deepEqual(routeGuard(b, action), { blocked: true, anchor: 4, cut: 4 });
});

test('campaign keeps moving when the supply bridge can withstand the counterattack', () => {
  const b = corridor(100, 2);
  const action = actionCoordinates(b, 4, 5, 2);
  assert.deepEqual(routeGuard(b, action), { blocked: false, anchor: -1, cut: -1 });
});
