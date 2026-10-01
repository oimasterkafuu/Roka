'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { actionCoordinates } = require('../bot/rules.cjs');
const { plan, recover, routeGuard, constructionThreat } = require('../bot/planner.cjs');

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

test('campaign gathers a token spearhead instead of marching it through a corridor', () => {
  const b = makeBoard({
    n: 3, m: 5,
    grid: [101, 1, 200, 2, 102, 201, 201, 201, 201, 201, 201, 201, 201, 201, 201],
    army: [20, 5, 0, 3, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    isolated: Array(15).fill(0), fog: Array(15).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const memory = {
    playerId: 1,
    home: 0,
    campaign: {
      crown: 4, at: 1, phase: 'gather', started: 0, lastPhase: 'gather',
      lastProgress: 0, deliveryBestDistance: Infinity, bestCrownDistance: 3,
    },
    delivery: null, blocked: null, threatDistance: {},
  };
  const decision = plan(b, memory);
  assert.equal(decision.branch, 'muster');
  assert.deepEqual(decision.action, actionCoordinates(b, 0, 1, 0));
});

test('stalled campaign recovery clears stale cursors and resumes a safe frontier', () => {
  const b = makeBoard({
    n: 3, m: 5,
    grid: [101, 1, 0, 201, 102, 201, 201, 201, 201, 201, 201, 201, 201, 201, 201],
    army: [40, 20, 20, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    isolated: Array(15).fill(0), fog: Array(15).fill(0), turn: 160,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const memory = {
    playerId: 1,
    home: 0,
    campaign: { crown: 4, at: 1, phase: 'gather', started: 0 },
    delivery: { root: 1, at: 1 },
    blocked: { crown: 4, until: 999 },
    buildPlan: { cells: [1], index: 0 },
  };
  const decision = recover(b, memory, [0, 1, 2]);
  assert.ok(decision?.action);
  assert.equal(memory.campaign, null);
  assert.equal(memory.delivery, null);
  assert.deepEqual(memory.buildPlan, { cells: [1], index: 0 });
});

function investmentBoard(enemyArmy) {
  return makeBoard({
    n: 5, m: 5,
    grid: [101, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 102],
    army: [50, 10, 10, 10, 10, 0, 0, 0, 0, enemyArmy, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30],
    isolated: Array(25).fill(0), fog: Array(25).fill(0), turn: 80,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

test('construction reserves a nearby garrison before spending fifty units', () => {
  const b = investmentBoard(80);
  assert.equal(constructionThreat(b, [0, 1, 2, 3, 4], [9, 24]), true);
  const memory = { playerId: 1, home: 0, threatDistance: {} };
  const decision = plan(b, memory);
  assert.equal(decision.branch, 'defend');
  assert.notEqual(decision.action?.kind, 'build');
});

test('construction resumes after the saved enemy stack is no longer a threat', () => {
  const b = investmentBoard(20);
  assert.equal(constructionThreat(b, [0, 1, 2, 3, 4], [9, 24]), false);
});

test('a cleared construction threat lets the existing cluster plan build again', () => {
  const b = makeBoard({
    n: 5, m: 5,
    grid: [101, ...Array(24).fill(1)],
    army: [60, 120, ...Array(23).fill(5)],
    isolated: Array(25).fill(0), fog: Array(25).fill(0), turn: 80,
    leaderboard: [{ id: 1, team: 1 }],
  }, 1);
  const memory = { playerId: 1, home: 0, threatDistance: {} };
  const decision = plan(b, memory);
  assert.equal(decision.branch, 'cluster-foundation');
  assert.equal(decision.action.kind, 'build');
});
