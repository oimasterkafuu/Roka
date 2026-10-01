'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs'); const { createController } = require('../bot/controller.cjs'); const { threatMap } = require('../bot/threat.cjs');
const { deepStackFrame } = require('../training/fixtures/raider-corridor.cjs');
function corridor() { return { n: 1, m: 8, grid_type: [101, 2, 1, 1, 1, 1, 1, 102], army_cnt: [4, 60, 50, 40, 35, 20, 15, 2], fog: Array(8).fill(0), turn: 300, leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }] }; }
test('long corridor raider makes defense outrank build and neutral coloring', () => {
  const frame = corridor(); const b = project(frame, 1); const c = createController(1); const action = c.choose(frame);
  assert.equal(threatMap(b).imminent, true); assert.ok(action); assert.notEqual(action.kind, 'build');
  if (action.kind === 'attack') assert.notEqual(b.kind(b.idx(action.dx, action.dy)), 'neutral');
});

test('deep visible stack warns across a five-step path before breach', () => {
  const frame = deepStackFrame(); const b = project(frame, 1); const threats = threatMap(b); const threat = threats.threatenedCrowns.find((t) => t.crown === 0);
  assert.ok(threat); assert.equal(threat.source, 5); assert.equal(threat.distance, 5); assert.deepEqual(threat.path, [5, 4, 3, 2, 1, 0]);
  assert.ok(threat.eta <= 6); assert.ok(threat.arrival >= b.army[0] * 0.5); assert.equal(threat.dangerous, true);
  const action = createController(1).choose(frame);
  assert.ok(action); assert.notEqual(action.kind, 'build');
});
