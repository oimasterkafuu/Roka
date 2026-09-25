'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseInterception } = require('../bot/interception.cjs');
function board(extra = {}) {
  return { n: 2, m: 4, playerId: 1, turn: 5,
    grid: [52, 2, 2, 201, 201, 1, 101, 201],
    army: [1, 1, 40, 0, 0, 20, 50, 0],
    isolated: Array(8).fill(0), fog: Array(8).fill(0), teams: new Map(), ...extra };
}
const rescue = { x: 1, y: 1, dx: 1, dy: 2, mode: 0, reason: '紧急救援主城' };
test('守军能撑住当前tick时切断入侵', () => {
  const result = chooseInterception(board());
  assert.deepEqual(result, { x: 1, y: 1, dx: 0, dy: 1, half: false, mode: 0,
    reason: '断供防守：切断敌连接薄点，预计削减20兵' });
  assert.equal('kind' in result, false);
});
test('同队队友城市是锚点，不能误算断供', () => {
  const s = board(); s.grid[3] = 53; s.army[3] = 1;
  s.teams = new Map([[2, 9], [3, 9]]);
  assert.equal(chooseInterception(s, rescue), null);
});
test('不同队城市不提供供给', () => {
  const s = board(); s.grid[3] = 53; s.army[3] = 1;
  s.teams = new Map([[2, 9], [3, 8]]);
  assert.ok(chooseInterception(s));
});
test('另一路四连通通向锚点时拒绝', () => {
  const s = board({ n: 3, grid: [2, 2, 2, 201, 52, 2, 2, 201, 201, 1, 101, 201],
    army: [1, 1, 1, 0, 1, 1, 40, 0, 0, 20, 5, 0], isolated: Array(12).fill(0), fog: Array(12).fill(0) });
  assert.equal(chooseInterception(s), null);
});
test('多个敌主城全部是锚点', () => {
  const s = board(); s.grid[0] = 102; s.grid[3] = 102; s.army[3] = 1;
  assert.equal(chooseInterception(s, rescue), null);
});
test('已孤立部队不重复获得减半收益', () => {
  const s = board(); s.isolated[2] = 1;
  assert.equal(chooseInterception(s), null);
});
test('孤立的我军不能出兵', () => {
  const s = board(); s.isolated[5] = 1;
  assert.equal(chooseInterception(s), null);
});
test('严格大于才可占领，同兵进攻拒绝', () => {
  const s = board(); s.army[5] = 2;
  assert.equal(chooseInterception(s), null);
});
test('mode0为其他方向留兵，不能以全冲兵力计算', () => {
  const s = board(); s.grid[4] = 3; s.army[4] = 25;
  assert.equal(chooseInterception(s), null);
});
test('另一个未断供敌军仍可拿皇冠，不能覆盖救援', () => {
  const s = board(); s.grid[7] = 53; s.army[7] = 80;
  assert.equal(chooseInterception(s, rescue), null);
});
test('奇数减半向下取整，1兵保持1，目标兵不计入减半', () => {
  const s = board(); s.grid[3] = 2; s.army[3] = 1; s.army[2] = 41;
  assert.match(chooseInterception(s).reason, /削减21兵/);
});
test('全部只有1兵，不虚构入侵或折半收益', () => {
  const s = board(); s.army[2] = 1;
  assert.equal(chooseInterception(s), null);
});
test('下一tick爆发增长导致同兵不能占领', () => {
  const s = board({ turn: 25 }); s.grid[5] = 151; s.army[5] = 3;
  assert.equal(chooseInterception(s), null);
  s.turn = 24;
  assert.ok(chooseInterception(s));
});
test('城市在第50tick增长，皇冠每tick增长', () => {
  const s = board(); s.grid[1] = 52; s.army[5] = 3;
  assert.ok(chooseInterception(s));
  s.turn = 49;
  s.grid[5] = 151;
  assert.equal(chooseInterception(s), null);
  s.turn = 5; s.grid[1] = 102;
  assert.equal(chooseInterception(s), null);
});
test('攻下的建筑被摧毁，不能继续给敌供给', () => {
  const s = board(); s.grid[0] = 201; s.grid[1] = 52;
  assert.ok(chooseInterception(s));
});
test('组件或边界有未知fog时保守拒绝', () => {
  for (const code of [202, 203]) {
    const s = board(); s.grid[3] = code;
    assert.equal(chooseInterception(s), null);
  }
  const s = board(); s.fog[0] = 1;
  assert.equal(chooseInterception(s), null);
});
test('不覆盖斩首，也不覆盖尚无主城危机的救援', () => {
  assert.equal(chooseInterception(board(), { ...rescue, reason: '斩首' }), null);
  const s = board(); s.army[6] = 100;
  assert.equal(chooseInterception(s, rescue), null);
});
test('安全时比较正面动作收益，不以少量断供替代有效正攻', () => {
  const s = board(); s.army[6] = 100;
  const attack = { x: 1, y: 2, dx: 0, dy: 2, mode: 0, reason: '正面进攻' };
  assert.equal(chooseInterception(s, attack), null);
  assert.ok(chooseInterception(s));
});
test('预算耗尽不返回部分搜索结果', () => {
  for (const interceptionBudget of [0, 1, 15]) {
    assert.equal(chooseInterception(board(), null, { interceptionBudget }), null);
  }
});
test('输入不修改，支持typed arrays', () => {
  const s = board(); s.grid = Int16Array.from(s.grid); s.army = Int32Array.from(s.army);
  const before = structuredClone(s), original = structuredClone(rescue);
  assert.ok(chooseInterception(s));
  assert.deepEqual(s, before); assert.deepEqual(rescue, original);
});
test('非法、结束状态不动作，不跨行攻击或攻击己方队友', () => {
  assert.equal(chooseInterception(null), null);
  assert.equal(chooseInterception(board({ ended: true })), null);
  assert.equal(chooseInterception(board({ dead: true })), null);
  assert.equal(chooseInterception(board({ n: 0 })), null);
  assert.equal(chooseInterception(board({ teams: new Map([[1, 8], [2, 8]]) })), null);
});

test('连通重算在所有移动后，不假设本tick敌入侵已减半或不能动',()=>{const s=board();s.army[6]=5;assert.equal(chooseInterception(s,rescue),null);});
