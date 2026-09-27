'use strict';
// 浓缩突击（2026-09-27，学自 _E_ 的单堆全冲）回归测试：
//   campaign 决定性大堆 mode2 突击 / 未达规模仍稳推 / 高危脖子不突击（截断联动）/
//   大堆被打残自动止损（无跨回合状态）；frontline 决定性大堆深入豁免半兵 /
//   普通堆深入半兵方针不变；policy 层背水一战仍压过浓缩突击（防斩首约束）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCampaign } = require('../bot/campaign.cjs');
const { createFrontline } = require('../bot/frontline.cjs');
const { chooseAction } = require('../bot/policy.cjs');

// 与 campaign.test.cjs 同形的 7×7 棋盘：我方皇冠 (0,3)，第 1 行我方，其余敌营 2，敌皇冠 (6,3)。
function board() {
  const n = 7, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  for (let y = 0; y < m; y++) { grid[at(1, y)] = 1; army[at(1, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(6, 3)] = 102; army[at(6, 3)] = 5;
  return { n, m, turn: 60, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'mega' };
}

test('浓缩突击：决定性大堆全冲（mode2）压向皇冠', () => {
  const s = board();
  s.army[1 * 7 + 3] = 3000; // (1,3) 聚出大堆
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.mode, 2, '大堆全冲，沿途只留 1 兵');
  assert.equal(a.reason.assault, true);
  assert.match(a.reason.detail, /浓缩突击/);
  assert.equal(a.x, 1); assert.equal(a.y, 3);
  assert.equal(a.dx, 2); assert.equal(a.dy, 3);
});

test('未达决定性规模：维持逐格稳推（mode0），不冒充突击', () => {
  const s = board();
  s.army[1 * 7 + 3] = 150; // 够打下一格，但算不上大堆
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.mode, 0);
  assert.ok(!a.reason.assault);
});

test('截断联动：回锚唯一通道且 rally 贴脸有敌时降级稳推（_E_ 败局形态）', () => {
  // 3×10：我方两行走廊 + 大堆 (1,8)；敌皇冠 (1,9)；敌侧翼 (2,8)/(2,9) 贴着 rally；
  // (0,9) 是山——大堆全冲后 (1,8) 留 1 兵即被 (2,8) 顺手吃掉，大堆变孤军。
  // 不突击，但也不僵死：降级 mode0 稳推，智能留兵在 rally 留下压得住侧翼的守军。
  const s = { n: 3, m: 10, turn: 60, playerId: 1, gameId: 'neck',
    grid: Array(30).fill(201), army: Array(30).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const at = (x, y) => x * 10 + y;
  s.grid[at(0, 0)] = 101; s.army[at(0, 0)] = 5;
  for (let y = 0; y <= 8; y++) { s.grid[at(0, y)] = s.grid[at(0, y)] === 101 ? 101 : 1; s.army[at(0, y)] = s.army[at(0, y)] || 5; }
  for (let y = 0; y <= 8; y++) { s.grid[at(1, y)] = 1; s.army[at(1, y)] = 5; }
  s.army[at(1, 8)] = 3000;
  s.grid[at(1, 9)] = 102; s.army[at(1, 9)] = 30;
  s.grid[at(2, 8)] = 2; s.army[at(2, 8)] = 50;
  s.grid[at(2, 9)] = 2; s.army[at(2, 9)] = 40;
  const a = chooseCampaign(s, {}, { targetOwner: 2, boundaryAdvance: true });
  assert.ok(a, '高危脖子降级稳推而不是僵死');
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.mode, 0, '高危脖子不全冲');
  assert.ok(!a.reason.assault);
});

test('脖子安全时同局面正常突击', () => {
  const s = { n: 3, m: 10, turn: 60, playerId: 1, gameId: 'neck-ok',
    grid: Array(30).fill(201), army: Array(30).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const at = (x, y) => x * 10 + y;
  s.grid[at(0, 0)] = 101; s.army[at(0, 0)] = 5;
  for (let y = 0; y <= 8; y++) { if (s.grid[at(0, y)] !== 101) s.grid[at(0, y)] = 1; s.army[at(0, y)] = s.army[at(0, y)] || 5; }
  for (let y = 0; y <= 8; y++) { s.grid[at(1, y)] = 1; s.army[at(1, y)] = 5; }
  s.army[at(1, 8)] = 3000;
  s.grid[at(1, 9)] = 102; s.army[at(1, 9)] = 30;
  // 头部 (1,9) 另有回锚回路：(0,9) 是我方格而不是山 → 大堆后路不系于 rally 一格
  s.grid[at(0, 9)] = 1; s.army[at(0, 9)] = 5;
  const a = chooseCampaign(s, {}, { targetOwner: 2, boundaryAdvance: true });
  assert.ok(a);
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.mode, 2);
  assert.equal(a.reason.assault, true);
});

test('止损：大堆被打残后下一 tick 自动退出突击（无跨回合状态）', () => {
  const s = board();
  s.army[1 * 7 + 3] = 3000;
  const first = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(first?.reason?.assault, '先确认突击成立');
  s.army[1 * 7 + 3] = 50; s.turn++; // 大堆被打残
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(!a || !(a.reason.phase === 'advance' && a.reason.assault), '兵残不再死磕突击');
});

// ── frontline 深入豁免 ──────────────────────────────────────────────
function frontlineBoard() {
  return { n: 5, m: 7, turn: 600, playerId: 1, grid: Array(35).fill(201), army: Array(35).fill(0),
    isolated: Array(35).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const put = (s, i, g, a) => { s.grid[i] = g; s.army[i] = a; return s; };
// 深入敌境突出部：源点 16 只经窄走廊（15）连本土，侧翼 9、23 是敌格，目标 17。
function salient(targetArmy, flankArmy, sourceArmy) {
  const s = frontlineBoard();
  put(s, 16, 1, sourceArmy); put(s, 15, 1, 50);
  put(s, 17, 2, targetArmy); put(s, 9, 2, flankArmy); put(s, 23, 2, flankArmy);
  return s;
}
const deepMove = { x: 2, y: 2, dx: 2, dy: 3, mode: 0 }; // 16 -> 17

test('决定性大堆深入敌境仍全兵压上（浓缩突击豁免深入半兵）', () => {
  const result = createFrontline(salient(20, 30, 400)).assess(deepMove);
  assert.ok(result);
  assert.equal(result.mode, 2, '大堆每步只派一半会在抵达皇冠前自剥殆尽');
  assert.match(result.reason, /全冲/);
});

test('普通堆深入敌境维持半兵方针（attack-split 不变）', () => {
  const result = createFrontline(salient(20, 30, 200)).assess(deepMove);
  assert.ok(result);
  assert.equal(result.mode, 1, '200 兵不足以构成决定性大堆，半兵方针不变');
});

// ── policy 调度：防斩首约束优先 ──────────────────────────────────────
test('背水一战仍压过浓缩突击：皇冠告急时不聚堆进攻', () => {
  // _E_ 胜局形态：敌 300 兵堆贴脸皇冠（1 tick 抵达），增援补不齐缺口
  // （背水一战触发）；同时我方在另一路聚了 3000 兵大堆、敌皇冠可见、
  // 军力碾压（campaign 活跃，正在向主攻方向汇兵）——家里告急时聚堆
  // 必须让位于背水一战（防斩首约束，调度顺序回归）。
  const s = { n: 1, m: 9, playerId: 1, turn: 200,
    grid: [101, 2, 1, 1, 1, 1, 1, 2, 102],
    army: [40, 300, 50, 2, 2, 3000, 2, 5, 100],
    isolated: Array(9).fill(0), fog: Array(9).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const a = chooseAction(s);
  assert.ok(a, '不允许空动作');
  assert.equal(a.kind, 'attack');
  assert.match(String(a.reason), /背水一战/);
});
