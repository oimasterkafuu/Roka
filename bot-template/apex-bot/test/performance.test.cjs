'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs'); const { rankBySearch } = require('../bot/search.cjs');
test('search records bounded latency and fallback fields', () => {
  const n = 8, grid = [101, 1, 1, 1, 1, 1, 2, 102], army = [10, 80, 70, 60, 50, 40, 30, 5];
  const b = project({ n: 1, m: n, grid_type: grid, army_cnt: army, turn: 300 }, 1);
  rankBySearch(b, { budgetMs: 1 }); assert.ok(Number.isFinite(b.searchStats.elapsedMs)); assert.equal(typeof b.searchStats.timeout, 'boolean'); assert.ok('p95' in b.searchStats); assert.ok(b.searchStats.p95 < 50);
});
