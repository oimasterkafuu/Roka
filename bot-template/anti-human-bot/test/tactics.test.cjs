'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseTactic } = require('../bot/tactics.cjs');
function board(grid, army, m = grid.length, extra = {}) {
  return { n: grid.length / m, m, grid, army, playerId: 1, turn: 5,
    isolated: grid.map(() => 0), fog: grid.map(() => 0), teams: new Map(), ...extra };
}
const move = (y, dy, reason = '拓地') => ({ x: 0, y, dx: 0, dy, half: false, mode: 0, reason });
test('无效或结束状态不出兵', () => {
  assert.equal(chooseTactic(null), null);
  assert.equal(chooseTactic(board([1, 0], [10, 0], 2, { ended: true })), null);
});
test('输出为标准 attack move，不带 kind', () => {
  const result = chooseTactic(board([1, 0], [10, 0]));
  assert.deepEqual(Object.keys(result).sort(), ['dx', 'dy', 'half', 'mode', 'reason', 'x', 'y']);
  assert.equal(result.mode, 0);
  assert.equal(typeof result.reason, 'string');
});
test('反击陷阱：敌后方大军可夺回目标', () => {
  assert.equal(chooseTactic(board([1, 2, 2], [12, 1, 30])), null);
});
test('守方增援：敌军 mode0 可在我军到达前保住目标', () => {
  assert.equal(chooseTactic(board([1, 2, 2], [15, 3, 18])), null);
  assert.ok(chooseTactic(board([1, 2, 2], [50, 3, 4])));
});
test('普通地26..50增长，50同时周期增长，之后不重复爆发', () => {
  // 沼泽进攻源不增长；目标第26 tick增长导致无法攻克。
  assert.ok(chooseTactic(board([151, 2], [3, 1], 2, { turn: 24 })));
  assert.equal(chooseTactic(board([151, 2], [3, 1], 2, { turn: 25 })), null);
  assert.equal(chooseTactic(board([151, 2], [4, 1], 2, { turn: 49 })), null);
  assert.ok(chooseTactic(board([151, 2], [3, 1], 2, { turn: 75 })));
  assert.equal(chooseTactic(board([151, 2], [3, 1], 2, { turn: 99 })), null);
});
test('主城每tick增长，指挥所不吃爆发增长', () => {
  assert.equal(chooseTactic(board([151, 102], [3, 1])), null);
  assert.ok(chooseTactic(board([151, 52], [3, 1], 2, { turn: 25 })));
});
test('孤立军不能出兵或反击', () => {
  assert.equal(chooseTactic(board([1, 0], [10, 0], 2, { isolated: [1, 0] })), null);
  assert.ok(chooseTactic(board([1, 2, 2], [12, 1, 30], 3, { isolated: [0, 0, 1] })));
});
test('四邻不跨行，队友不作为攻击目标', () => {
  assert.equal(chooseTactic(board([201, 1, 0, 201], [0, 10, 0, 0], 2)), null);
  assert.equal(chooseTactic(board([1, 2], [10, 1], 2, { teams: new Map([[1, 3], [2, 3]]) })), null);
});
test('真实智能分兵保留侧翼兵力，不改用全冲', () => {
  assert.equal(chooseTactic(board([2, 1, 2], [20, 15, 1])), null);
});
test('守城、斩首紧急动作规范化保留', () => {
  for (const reason of ['守主城', '斩首', '清除主城威胁', '紧急救援']) {
    const original = { ...move(0, 1, reason), kind: 'attack' };
    assert.deepEqual(chooseTactic(board([1, 2, 2], [12, 1, 30]), original), move(0, 1, reason));
  }
});
test('预算耗尽保留原动作或返回null，不部分采样替换', () => {
  const s = board([1, 0], [10, 0]);
  assert.deepEqual(chooseTactic(s, move(0, 1), { tacticBudget: 0 }), move(0, 1));
  assert.equal(chooseTactic(s, null, { tacticBudget: 1 }), null);
  assert.equal(chooseTactic(board(Array(10000).fill(1), Array(10000).fill(10)), null, { tacticBudget: 30 }), null);
});
test('收益不足保持原move', () => {
  const s = board([0, 1, 0], [0, 20, 0]);
  assert.deepEqual(chooseTactic(s, move(1, 2)), move(1, 2));
});
test('敌锚点瓶颈：切断含大量兵力的分量优于普通拓地', () => {
  const s = board([201, 201, 102, 0, 1, 2, 201, 201, 2, 201, 201, 2],
    [0, 0, 1, 0, 80, 1, 0, 0, 1, 0, 0, 60], 3);
  const original = { x: 1, y: 1, dx: 1, dy: 0, mode: 0, half: false, reason: '拓地' };
  const result = chooseTactic(s, original);
  assert.equal(result.dx, 1);
  assert.equal(result.dy, 2);
});
test('不修改state、params、原move，重复调用确定性', () => {
  const s = board([1, 2, 2], [50, 3, 4]), p = Object.freeze({ tacticBudget: 12000 });
  const original = Object.freeze(move(0, 1));
  const before = structuredClone(s);
  Object.freeze(s.grid); Object.freeze(s.army); Object.freeze(s.isolated); Object.freeze(s.fog); Object.freeze(s);
  assert.deepEqual(chooseTactic(s, original, p), chooseTactic(s, original, p));
  assert.deepEqual(s, before);
});
