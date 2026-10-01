'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs'); const { connectivityReport, articulationPoints } = require('../bot/connectivity.cjs');
function board() { return project({ n: 1, m: 5, grid_type: [101, 1, 1, 1, 1], army_cnt: [5, 5, 5, 5, 5] }, 1); }
test('connectivity follows team anchors and detects corridor articulation', () => {
  const b = board(); const report = connectivityReport(b); assert.equal(report.connected.size, 5); assert.ok(articulationPoints(b).has(1)); assert.ok(articulationPoints(b).has(2));
});
test('unknown fog is not treated as connected territory', () => {
  const b = project({ n: 1, m: 3, grid_type: [101, 202, 1], army_cnt: [5, 0, 5], fog: [0, 1, 0] }, 1);
  assert.equal(connectivityReport(b).connected.has(2), false);
});
