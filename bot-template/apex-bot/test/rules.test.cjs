'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { project } = require('../bot/board.cjs'); const { previewAttack, previewBuild } = require('../bot/rules.cjs');
function board(grid, army) { return project({ n: 1, m: grid.length, grid_type: grid, army_cnt: army }, 1); }
test('preview supports mode 0/1/2 and rejects empty attacks', () => { const b = board([101, 1, 200], [10, 8, 0]); assert.equal(previewAttack(b, { x: 0, y: 0, dx: 0, dy: 1, mode: 0 }).ok, true); assert.equal(previewAttack(b, { x: 0, y: 1, dx: 0, dy: 2, mode: 2 }).send, 7); assert.equal(previewAttack(b, { x: 0, y: 0, dx: 0, dy: 1, mode: 1 }).send, 4); assert.equal(previewAttack(b, { x: 0, y: 0, dx: 0, dy: 1, mode: 0 }).ok, true); assert.equal(previewAttack(b, { x: 0, y: 0, dx: 0, dy: 2, mode: 2 }).ok, false); });
test('preview detects decapitation and preserves building destruction', () => { const b = board([101, 102], [10, 3]); const r = previewAttack(b, { x: 0, y: 0, dx: 0, dy: 1, mode: 2 }); assert.equal(r.decap, true); assert.equal(r.grid[1], 1); });
test('build costs 50 and requires connected anchor', () => { const b = board([101, 1, 201, 1], [50, 60, 0, 60]); assert.equal(previewBuild(b, { x: 0, y: 1, op: 'b' }).ok, true); assert.equal(previewBuild(b, { x: 0, y: 3, op: 'b' }).reason, 'cutoff'); });
test('build upgrade requires city and rejects swamp', () => { const b = board([101, 51, 204], [50, 50, 50]); assert.equal(previewBuild(b, { x: 0, y: 1, op: 'c' }).ok, true); assert.equal(previewBuild(b, { x: 0, y: 2, op: 'b' }).ok, false); });
