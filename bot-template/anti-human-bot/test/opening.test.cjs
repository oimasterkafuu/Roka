'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseOpening: choose } = require('../bot/opening.cjs');
function state(grid, army, extra = {}) {
  return { n: 1, m: grid.length, playerId: 1, turn: 26, grid, army,
    fog: grid.map(() => false), isolated: grid.map(() => false),
    teams: new Map([[1, 1], [2, 2], [3, 1]]), ...extra };
}
for (const turn of [0, 25, 26, 49, 50, 76]) test(`tick ${turn} 边界`, () => {
  const a = choose(state([1, 200], [3, 0], { turn }));
  if (turn >= 50) assert.equal(a, null);
  else {
    assert.equal(a.reason, turn < 26 ? '开局播种' : '爆发拓地');
    assert.equal(a.kind, undefined); assert.equal(a.mode, 0); assert.equal(a.half, false);
  }
});
test('下一tick先增长，只有一兵的普通格也能在26执行播种', () => {
  assert.ok(choose(state([1, 200], [1, 0], { turn: 25 })));
  assert.equal(choose(state([1, 200], [1, 0], { turn: 24 })), null);
});
test('50tick普通格双增长，城市仅周期增长，沼泽不增长', () => {
  assert.ok(choose(state([1, 200], [1, 0], { turn: 49 })));
  assert.ok(choose(state([51, 200], [1, 0], { turn: 49 })));
  assert.equal(choose(state([151, 200], [1, 0], { turn: 49 })), null);
  assert.equal(choose(state([51, 200], [1, 0])), null);
});
test('城市和沼泽不是爆发拓地目标，不输出建造', () => {
  for (const target of [50, 150, 204]) assert.equal(choose(state([1, target], [40, 0])), null);
  const a = choose(state([1, 200], [100, 0]), { kind: 'build', x: 0, y: 0, op: 'b' });
  assert.equal(a.op, undefined); assert.equal(a.kind, undefined);
});
test('49下令吃不到50增长，48下令能回收50双增长', () => {
  assert.equal(choose(state([1, 200], [20, 1], { turn: 49 })), null);
  assert.ok(choose(state([1, 200], [20, 1], { turn: 48 })));
});
test('高驻军不回本，便宜普通地优先', () => {
  assert.equal(choose(state([1, 200], [100, 40])), null);
  const a = choose(state([200, 1, 200], [5, 30, 0]));
  assert.equal(a.dy, 2);
});
test('敌普通格下一tick增长纳入胜负，不把平手当占领', () => {
  assert.equal(choose(state([1, 2], [3, 2])), null);
  assert.ok(choose(state([1, 2], [4, 2])));
});
test('精确mode0：中立驻军留兵、空地负一抵消、雾留2', () => {
  assert.equal(choose(state([200, 1, 200], [9, 10, 2])), null);
  const a = choose(state([200, 1, 200, 201, 200, 201], [3, 4, 2, 0, 0, 0], { n: 2, m: 3 }));
  assert.ok(a);
  assert.equal(choose(state([202, 1, 200], [0, 3, 1])), null);
});
test('主城不能放空给直接扑杀者，空中立负留兵不能掩盖威胁', () => {
  const s = state([201, 200, 201, 2, 101, 200, 201, 200, 201],
    [0, 0, 0, 6, 10, 0, 0, 0, 0], { n: 3, m: 3 });
  const a = choose(s);
  // 可以直接消灭威胁，但不能背向敌军拓空地。
  assert.ok(!a || (a.dx === 1 && a.dy === 0));
});
test('不送新领地给下一tick反击', () => {
  assert.equal(choose(state([1, 200, 2], [3, 0, 20])), null);
});
test('守城清威胁让行，实际直接斩首让行，远程斩首标签不阻止扩张', () => {
  const s = state([1, 200], [20, 0]);
  for (const reason of ['守主城', '清除主城威胁', { code: 'emergency-defense' }])
    assert.equal(choose(s, { reason }), null);
  assert.ok(choose(s, { x: 0, y: 0, dx: 0, dy: 1, reason: '斩首路径' }));
  assert.equal(choose(state([200, 1, 102], [0, 30, 2]),
    { x: 0, y: 1, dx: 0, dy: 2, mode: 0, reason: '斩首' }), null);
});
test('所有源直接扩张优先于大兵团境内搬运', () => {
  const a = choose(state([1, 1, 1, 200, 201, 1, 200], [100, 1, 1, 0, 0, 3, 0]));
  assert.equal(a.reason, '爆发拓地'); assert.notEqual(a.y, 0);
});
test('2至4步境内运输仅在终点可回本时执行', () => {
  const a = choose(state([1, 1, 200], [20, 1, 2]));
  assert.equal(a.reason, '爆发调兵'); assert.equal(a.y, 0); assert.equal(a.dy, 1);
  assert.equal(choose(state([1, 1, 200], [20, 1, 2], { turn: 49 })), null);
  const b = choose(state([1, 1, 1, 1, 200], [30, 1, 1, 1, 10]));
  assert.equal(b.reason, '爆发调兵'); assert.equal(b.y, 0);
});
test('队友和孤立格不能作为出兵点、目标或运输跳板', () => {
  assert.equal(choose(state([1, 3, 200], [30, 1, 0])), null);
  assert.equal(choose(state([1, 1, 200], [30, 1, 2], { isolated: [false, true, false] })), null);
  assert.equal(choose(state([1, 200], [30, 0], { isolated: [true, false] })), null);
});
test('固定预算、非法输入、纯函数', () => {
  for (const s of [null, {}, state([1], [1], { dead: true }), state([1], [1], { ended: true })]) assert.equal(choose(s), null);
  const s = state([1, 200], [30, 0]);
  const before = structuredClone(s);
  for (const k of ['grid', 'army', 'fog', 'isolated']) Object.freeze(s[k]);
  Object.freeze(s);
  assert.equal(choose(s, null, { openingBudget: 0 }), null);
  assert.deepEqual(choose(s), choose(s)); assert.deepEqual(s, before);
});
