'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs');
const { preview } = require('../bot/rules.cjs');
const { threatMap } = require('../bot/threat.cjs');
const { createInvestmentRaider } = require('../training/opponents/investment-raider.cjs');
const { corridorFrame, metadata } = require('../training/fixtures/raider-corridor.cjs');

test('investment raider uses the frame player id and returns accepted opening actions', () => {
  const frame = corridorFrame({ turn: 100 });
  const raider = createInvestmentRaider(2);
  const action = raider(frame);
  assert.ok(action);
  assert.equal(project(frame, 2).playerId, 2);
  assert.equal(preview(project(frame, 2), action).ok, true);
  assert.equal(raider.stats().phase, 'invest');
});

test('raider switches to a crown route after investment threshold', () => {
  const frame = corridorFrame({ turn: 300, rearArmy: 72 });
  const board = project(frame, 2);
  const raider = createInvestmentRaider(2);
  const action = raider(frame);
  const result = action && preview(board, action);
  assert.ok(result?.ok);
  assert.equal(raider.stats().phase, 'raid');
  assert.equal(metadata(frame, 2).targetCrown, 0);
});

test('ETA does not call a distant large stack imminent', () => {
  const frame = { ...corridorFrame({ turn: 300 }), grid_type: [101, 1, 1, 1, 1, 1, 1, 2, 2, 102], army_cnt: [8, 12, 12, 12, 12, 12, 12, 80, 60, 5] };
  const threat = threatMap(project(frame, 1));
  assert.equal(threat.imminent, false);
  assert.ok(threat.threats[0].eta > 3);
});
