'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeadline } = require('../bot/deadline.cjs');
const { makeBoard } = require('../bot/board.cjs');
const { preview } = require('../bot/rules.cjs');
const { createController, legalFallback } = require('../bot/controller.cjs');

function frame(grid, army, n = 3, m = 5, turn = 60) {
  return {
    n,
    m,
    grid,
    army,
    isolated: Array(n * m).fill(0),
    fog: Array(n * m).fill(0),
    turn,
    leaderboard: [
      { id: 1, team: 1 },
      { id: 2, team: 2 },
    ],
  };
}

function fixture() {
  return frame(
    [101, 1, 1, 2, 102, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
    [30, 12, 8, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
}

function boardOf(raw, playerId = 1) {
  return makeBoard(raw, playerId);
}

test('createDeadline expires a zero budget immediately', () => {
  const deadline = createDeadline({ budgetMs: 0, now: () => 1000 });
  assert.equal(deadline.expired(), true);
  assert.equal(deadline.remaining(), 0);
  assert.equal(deadline.stats().budgetMs, 0);
});

test('createDeadline honours the margin and amortizes checks', () => {
  let clock = 0;
  const deadline = createDeadline({ budgetMs: 80, marginMs: 8, checkInterval: 4, now: () => clock });
  assert.equal(deadline.deadlineAt, 72);
  // The first check always probes, the next ones are amortized.
  assert.equal(deadline.check(), false);
  assert.equal(deadline.check(), false);
  assert.equal(deadline.check(), false);
  assert.deepEqual(deadline.counters(), { checks: 3, probes: 1, expired: false });
  clock = 71;
  assert.equal(deadline.expired(), false);
  clock = 72;
  assert.equal(deadline.expired(), true);
});

test('budget of zero forces a preview-valid legal fallback', () => {
  const raw = fixture();
  const controller = createController(1, { decisionBudgetMs: 0, now: () => 0 });
  const action = controller.choose(raw);
  assert.ok(action, 'a zero budget still emits an action');
  assert.ok(['attack', 'build'].includes(action.kind));
  assert.equal(preview(boardOf(raw), action).ok, true);
  const stats = controller.stats();
  assert.equal(stats.budgetExceeded, 1);
  assert.equal(stats.fallbacks, 1);
  assert.equal(stats.rejected, 0);
  assert.equal(typeof stats.lastDecisionMs, 'number');
  assert.ok(stats.maxDecisionMs >= stats.lastDecisionMs);
});

test('a large budget reproduces the unconstrained decision', () => {
  const baseline = createController(1);
  const budgeted = createController(1, { decisionBudgetMs: 5000 });
  const expected = baseline.choose(fixture());
  const actual = budgeted.choose(fixture());
  assert.deepEqual(actual, expected);
  assert.equal(budgeted.stats().fallbacks, 0);
  assert.equal(budgeted.stats().budgetExceeded, 0);
});

test('a clock that jumps past the budget neither throws nor emits an illegal action', () => {
  const raw = fixture();
  let clock = 0;
  const jumping = () => {
    const value = clock;
    clock += 500;
    return value;
  };
  const controller = createController(1, { decisionBudgetMs: 80, now: jumping });
  let action;
  assert.doesNotThrow(() => {
    action = controller.choose(raw);
  });
  if (action) assert.equal(preview(boardOf(raw), action).ok, true);
  const stats = controller.stats();
  assert.equal(stats.budgetExceeded, 1);
});

test('legalFallback prefers a lethal crown strike', () => {
  const raw = frame(
    [101, 102, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
    [20, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  const board = boardOf(raw);
  const action = legalFallback(board, { playerId: 1, maze: false });
  assert.ok(action);
  assert.equal(action.kind, 'attack');
  assert.equal(action.mode, 2);
  const result = preview(board, action);
  assert.equal(result.ok, true);
  assert.equal(result.decap, true);
});

test('legalFallback never returns an illegal action on a blocked board', () => {
  const raw = frame(
    [101, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  const board = boardOf(raw);
  const action = legalFallback(board, { playerId: 1, maze: false });
  assert.equal(action, null);
});
