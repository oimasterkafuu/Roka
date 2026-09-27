'use strict';
// 跳板推进常态化（2026-09-28 用户硬方针）回归测试：
//   深入大堆「走一步 → 身后腾出格补一座指挥所」成为默认节奏（不再要求切断风险）/
//   连续 tick 内 move → 补锚 → move 交替出现 / 常态化期间不用浓缩突击 mode2 /
//   腾出格钱不够 51 原地等凑钱（有上限，等不到放弃这一格继续走）/
//   家门口短距离推进（皇冠距离 <leapfrogMinDepth）不误触发 / policy 层补锚照常落地。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCampaign } = require('../bot/campaign.cjs');
const { chooseAction } = require('../bot/policy.cjs');

// 10×7 深入推进棋盘：我方第 0 行 + 皇冠 (0,3)，走廊 (1,3)/(2,3)/(3,3)，大堆 rally
// (4,3)=3000——crownDist[rally]=4 达到 leapfrogMinDepth（深入）。全图中立（无贴敌，
// 无切断风险：risky/imminent 均不成立），敌皇冠 (9,3)。走廊两侧中立格 30 兵，让
// mode0 智能留兵在腾出格留下 ~59 兵（够补锚的 51）。
function deepBoard({ fromArmy = 60, stackArmy = 3000, crownX = 9, lastMove = null, turn = 61 } = {}) {
  const n = 10, m = 7, size = n * m, grid = Array(size).fill(0), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  for (let x = 0; x < n; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 0; army[at(x, y)] = 2; }
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 15;
  grid[at(2, 3)] = 1; army[at(2, 3)] = 15;
  grid[at(3, 3)] = 1; army[at(3, 3)] = fromArmy;
  grid[at(4, 3)] = 1; army[at(4, 3)] = stackArmy;
  // 走廊两侧加厚中立格：mode0 推进时智能留兵按侧翼压力留足补锚资金。
  for (const x of [1, 2, 3, 4, 5, 6, 7, 8]) { army[at(x, 2)] = 30; army[at(x, 4)] = 30; }
  grid[at(crownX, 3)] = 102; army[at(crownX, 3)] = 5;
  return { n, m, turn, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'leapfrog',
    lastMove };
}

test('跳板常态化：无切断风险的深入推进，大堆照常前压（mode0，不用 mode2 全冲）', () => {
  const s = deepBoard();
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.notEqual(a.kind, 'build');
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.mode, 0, '常态化跳板期间走智能分兵，身后留下余兵补锚；不 mode2 全冲');
});

test('跳板常态化：大堆上一步腾出格立即补锚，不需要切断风险', () => {
  const s = deepBoard({ lastMove: { op: 'm', x: 3, y: 3, dx: 4, dy: 3, turn: 61 } });
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3, '锚落在大堆刚腾出的格上');
  assert.equal(a.reason.phase, 'backfill-anchor');
  assert.equal(a.reason.leapfrog, true, '常态化路径（非切断风险路径）');
});

test('跳板常态化节奏：连续 tick 内 move → 腾出格补锚 → move 交替出现', () => {
  // tick 61：大堆 (4,3)→(5,3) 前进一步。
  const s = deepBoard();
  const step1 = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(step1);
  assert.notEqual(step1.kind, 'build');
  assert.equal(step1.reason.phase, 'advance');
  assert.equal(step1.x, 4); assert.equal(step1.y, 3);
  assert.equal(step1.dx, 5); assert.equal(step1.dy, 3);
  // 模拟服务端执行：mode0 智能留兵在 (4,3) 留下侧翼预留 ~59 兵，大堆走进 (5,3)。
  s.army[5 * s.m + 3] = 2900; s.grid[5 * s.m + 3] = 1;
  s.army[4 * s.m + 3] = 59;
  s.lastMove = { op: 'm', x: 4, y: 3, dx: 5, dy: 3, turn: 62 };
  s.turn = 62;
  // tick 62：不移动，在腾出格 (4,3) 补指挥所。
  const step2 = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(step2);
  assert.equal(step2.kind, 'build');
  assert.equal(step2.x, 4); assert.equal(step2.y, 3);
  assert.equal(step2.reason.phase, 'backfill-anchor');
  // 模拟服务端建成：指挥所落地，扣 50 兵。
  s.grid[4 * s.m + 3] = 51; s.army[4 * s.m + 3] = 9;
  s.lastMove = { op: 'b', x: 4, y: 3, turn: 63 };
  s.turn = 63;
  // tick 63：大堆继续走下一步——「走一步搭一个」交替成立。
  const step3 = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(step3);
  assert.notEqual(step3.kind, 'build');
  assert.equal(step3.reason.phase, 'advance');
  assert.equal(step3.x, 5); assert.equal(step3.y, 3);
});

test('跳板常态化：腾出格钱不够 51 原地等凑钱，凑够立即补锚', () => {
  const s = deepBoard({ fromArmy: 20, lastMove: { op: 'm', x: 3, y: 3, dx: 4, dy: 3, turn: 61 } });
  const opts = { targetOwner: 2 };
  assert.equal(chooseCampaign(s, {}, opts), null, '第 1 tick：登记等待，原地凑钱不空走');
  s.army[3 * s.m + 3] = 55; // 凑够 51
  s.turn = 62;
  const a = chooseCampaign(s, {}, opts);
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.x, 3); assert.equal(a.y, 3, '凑够钱立即补锚，大堆随后再走');
  assert.equal(a.reason.phase, 'backfill-anchor');
});

test('跳板常态化：等凑钱超过 leapfrogWaitTicks 放弃这一格，恢复正常推进', () => {
  const s = deepBoard({ fromArmy: 20, lastMove: { op: 'm', x: 3, y: 3, dx: 4, dy: 3, turn: 61 } });
  const opts = { targetOwner: 2 };
  assert.equal(chooseCampaign(s, {}, opts), null, '第 1 tick 原地等');
  s.turn = 62;
  assert.equal(chooseCampaign(s, {}, opts), null, '第 2 tick 仍在等');
  s.turn = 63;
  const a = chooseCampaign(s, {}, opts);
  assert.ok(a, '等满仍不够，放弃这一格继续走（链距自然变宽）');
  assert.notEqual(a.kind, 'build');
});

test('家门口短距离推进不触发跳板常态化（皇冠距离不足 leapfrogMinDepth）', () => {
  // rally (2,3)：crownDist=2 < 4——同样腾出 60 兵的格也不补锚，钱花在刀刃上。
  const s = deepBoard({ lastMove: { op: 'm', x: 1, y: 3, dx: 2, dy: 3, turn: 61 } });
  s.grid[1 * s.m + 3] = 1; s.army[1 * s.m + 3] = 60;
  s.grid[2 * s.m + 3] = 1; s.army[2 * s.m + 3] = 3000;
  s.grid[3 * s.m + 3] = 0; s.army[3 * s.m + 3] = 2;
  s.grid[4 * s.m + 3] = 0; s.army[4 * s.m + 3] = 2;
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.notEqual(a.kind, 'build');
});

test('policy 调度：深入大堆推进后腾出格补锚在完整管线中照常落地', () => {
  const s = deepBoard({ lastMove: { op: 'm', x: 3, y: 3, dx: 4, dy: 3, turn: 61 } });
  const a = chooseAction(s);
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3);
});
