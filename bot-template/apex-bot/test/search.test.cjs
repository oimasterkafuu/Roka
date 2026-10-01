'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs'); const { rankBySearch } = require('../bot/search.cjs');
test('search evaluates post-action replies and can retain defensive action', () => {
  const b = project({ n: 1, m: 4, grid_type: [101, 1, 2, 102], army_cnt: [5, 70, 30, 3], turn: 300 }, 1);
  const rows = rankBySearch(b); assert.ok(rows.length > 0); assert.ok(rows.every((r) => r.result)); assert.ok(rows.some((r) => r.reply || r.risk === 0));
});
