'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseLogistics, getSupplyBatch } = require('../bot/logistics.cjs');

// 6x10：0-3 行己方腹地，第 4 行山墙，第 5 行敌人。用于经济与物流方向测试。
function field({ turn = 400, foeCrowns = 1 } = {}) {
  const n = 6, m = 10, size = n * m;
  const grid = Array(size).fill(201), army = Array(size).fill(0);
  for (let x = 0; x < 4; x++) for (let y = 0; y < m; y++) { grid[x * m + y] = 1; army[x * m + y] = 3; }
  for (let y = 0; y < m; y++) grid[5 * m + y] = 2;
  grid[0] = 101;
  for (let k = 0; k < foeCrowns; k++) grid[5 * m + k] = 102;
  army[0] = 30;
  return { n, m, turn, playerId: 1, grid, army, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const at = (x, y) => x * 10 + y;

test('没有前线目标时军用补给不虚构动作', () => {
  const s = field();
  assert.equal(chooseLogistics(s, null, null, { militaryOnly: true }), null);
});

test('经济专用通道把后方兵送到工地并标记 economy-fund', () => {
  const s = field();
  s.army[at(2, 5)] = 60;                 // 差一点就能开工的工地
  s.army[at(1, 1)] = 40;                 // 后方可用资金
  const a = chooseLogistics(s, null, null, { economyOnly: true });
  assert.ok(a, '落后或资金不足时应继续筹资');
  if (a.kind === 'build') assert.ok(['b', 'c'].includes(a.op));
  else {
    assert.equal(a.reason.code, 'economy-fund');
    assert.equal(a.reason.target, at(2, 5));
  }
});

test('经济工地不会被前线补给抽干', () => {
  const s = field();
  s.army[at(2, 5)] = 60;
  s.army[at(2, 6)] = 60;
  // 先立起经济工地，再用军用补给试探它会不会被抽走
  const economy = chooseLogistics(s, null, null, { economyOnly: true });
  assert.ok(economy);
  const military = chooseLogistics(s, null, null, { militaryOnly: true });
  if (military) assert.ok(!(military.y === 2 && (military.dy === 5 || military.dy === 6)));
});

test('经济落后时提高建造意愿：目标皇冠数向对手看齐', () => {
  const { crownTarget } = require('../bot/building.cjs');
  const s = field({ foeCrowns: 6 });
  const target = crownTarget(40, s.turn, { territoryPerCrown: 18 }, s);
  assert.ok(target >= 7, `目标应追到 7，实际 ${target}`);
});

test('普通物流有行动配额，不会每 tick 都搬一次', () => {
  const s = field();
  s.grid[4 * 10 + 5] = 1;      // 打通一个前哨
  s.army[4 * 10 + 5] = 5;
  s.army[at(3, 5)] = 200;
  const first = chooseLogistics(s, null, null, {});
  assert.ok(first);
  if (first.kind !== 'build') {
    const second = chooseLogistics(s, null, null, {});
    assert.equal(second, null, '同一 tick/间隔内不应重复搬运');
  }
});

test('回合回退会重置记忆，不同局面互不污染', () => {
  const a = field(), b = field();
  a.grid[4 * 10 + 5] = 1; a.army[4 * 10 + 5] = 5; a.army[at(3, 5)] = 200;
  b.grid[4 * 10 + 5] = 1; b.army[4 * 10 + 5] = 5; b.army[at(3, 5)] = 200;
  assert.deepEqual(chooseLogistics(a, null, null, {}), chooseLogistics(b, null, null, {}));
});

test('批次信息只在有真实运输时公开', () => {
  const s = field();
  assert.equal(getSupplyBatch(s), null);
});

test('不修改输入局面', () => {
  const s = field();
  const before = JSON.stringify(s);
  chooseLogistics(s, null, null, { economyOnly: true });
  chooseLogistics(s, null, null, { militaryOnly: true });
  chooseLogistics(s, null, null, {});
  assert.equal(JSON.stringify(s), before);
});
