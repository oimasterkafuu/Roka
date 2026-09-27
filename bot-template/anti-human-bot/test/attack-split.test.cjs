'use strict';
// 进攻兵力分配精细化（2026-09-27）回归测试：
//   深入敌境能半兵就半兵 / 半兵不够则全兵 / 对方完全无威胁时深入也全兵 /
//   常规推进维持全兵优先（第二轮方针不变）。斩首逻辑不在此处改动。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrontline } = require('../bot/frontline.cjs');

// 5x7 棋盘，只有指定格不是山。9=(1,2) 15=(2,1) 16=(2,2) 17=(2,3) 23=(3,2)
function board() {
  return { n: 5, m: 7, turn: 600, playerId: 1, grid: Array(35).fill(201), army: Array(35).fill(0),
    isolated: Array(35).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const put = (s, i, g, a) => { s.grid[i] = g; s.army[i] = a; return s; };
const move = { x: 2, y: 2, dx: 2, dy: 3, mode: 0 }; // 16 -> 17

// 深入敌境布局：源点 16 只经窄走廊（15）连着本土，侧翼 9、23 全是敌格。
function salient(targetArmy, flankArmy, sourceArmy = 200) {
  const s = board();
  put(s, 16, 1, sourceArmy);       // 源点（突出部端点）
  put(s, 15, 1, 50);               // 背后窄走廊
  put(s, 17, 2, targetArmy);       // 目标敌格
  put(s, 9, 2, flankArmy);         // 侧翼敌格
  put(s, 23, 2, flankArmy);        // 侧翼敌格
  return s;
}

test('深入敌境：半兵够拿下目标格就只派一半，留一半守原地', () => {
  // 半兵（70）足够推掉守军 20 → mode 1 深入半兵，不全兵压上
  const result = createFrontline(salient(20, 30)).assess(move);
  assert.ok(result, '深入突出部且有侧翼敌兵时必须能打');
  assert.equal(result.mode, 1, '半兵确实攻得进去 → 只派一半');
  assert.match(result.reason, /深入半兵/);
});

test('深入敌境：半兵推不动就全兵，不许硬推半兵', () => {
  // 半兵（70）打不穿守军 80 → 落到全兵
  const result = createFrontline(salient(80, 30)).assess(move);
  assert.ok(result, '全兵能推掉就必须打');
  assert.equal(result.mode, 2, '半兵不够 → 全兵');
});

test('对方完全无威胁：深入攻击也没必要半兵，全兵即可', () => {
  // 侧翼敌格各 1 兵（无可动兵力），可见敌军总量 22 不及源头 200
  const result = createFrontline(salient(20, 1)).assess(move);
  assert.ok(result);
  assert.equal(result.mode, 2, '没有要防的东西 → 深入也全兵');
});

test('常规推进（非深入）：维持第二轮全兵优先，不分小勺', () => {
  // 贴界推进：源点背后是我方连片领土（15、9、23 皆我方），目标敌格守 20
  const s = board();
  put(s, 16, 1, 200); put(s, 15, 1, 50); put(s, 9, 1, 30); put(s, 23, 1, 30);
  put(s, 17, 2, 20);
  const result = createFrontline(s).assess(move);
  assert.ok(result);
  assert.equal(result.mode, 2, '常规推进照旧全兵（mode 2 整格压上）');
});
