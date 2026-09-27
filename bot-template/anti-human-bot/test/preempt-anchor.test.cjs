'use strict';
// 同 tick 预锚 + 腾出格补锚 + 深入决心（2026-09-27 第二轮，用户硬方针）回归测试：
//   大堆深入 + 敌方 1 tick 可切断走廊 → 本 tick 输出 build（原地起锚）而非 move /
//   预锚不受 anchorChainGap / anchorBuildEvery 节奏限制 / 无 1-tick 切断可能不触发 /
//   小堆不触发 / 余兵压不住贴脸敌兵不建 / 钱不够 51 原地等凑兵（有上限）/
//   大堆移动后腾出格立即补锚 / policy 层预锚压过脖子纪律，让位拆建筑推进与背水一战 /
//   深入决心：窗口内锁定同一皇冠方向，评分甩开才换，窗口过期自动解锁。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCampaign } = require('../bot/campaign.cjs');
const { chooseAction } = require('../bot/policy.cjs');

// 8×7：我方第 0 行 + 皇冠 (0,3)，走廊 (1,3)=15/(2,3)=5（弱脖子），大堆 rally
// (3,3)=3000，敌堆 (2,2)=20 贴着弱脖子（下一 tick 19>5 即可打下，移除 (2,3)
// 会冻住大堆 3000）——1-tick 切断风险成立。敌皇冠 (7,3)。turn 61 非节奏 tick。
function preemptBoard({ stackArmy = 3000, neckArmy = 5, threatArmy = 20, sideEnemy = 0, city = false } = {}) {
  const n = 8, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 15;
  grid[at(2, 3)] = 1; army[at(2, 3)] = neckArmy;
  grid[at(3, 3)] = 1; army[at(3, 3)] = stackArmy;
  grid[at(2, 2)] = 2; army[at(2, 2)] = threatArmy;
  if (sideEnemy) { grid[at(3, 2)] = 2; army[at(3, 2)] = sideEnemy; }
  if (city) { grid[at(4, 3)] = 52; army[at(4, 3)] = 5; }
  grid[at(7, 3)] = 102; army[at(7, 3)] = 5;
  return { n, m, turn: 61, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'preempt' };
}

test('同 tick 预锚：走廊可被 1 tick 切断时大堆原地起锚，本 tick 不移动', () => {
  const a = chooseCampaign(preemptBoard(), {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3, '指挥所直接落在大堆脚下');
  assert.equal(a.reason.phase, 'preempt-anchor');
  assert.equal(a.reason.imminent, true);
});

test('预锚不受 anchorChainGap 限制：走廊短于间距但切断迫在眉睫时仍起锚', () => {
  // 7×7：皇冠 (0,3)，脖子 (1,3)=5 贴敌堆 (1,2)=20，rally (2,3)=3000。
  // anchorDist[rally]=2 < anchorChainGap=3——旧锚点链整块不触发，预锚仍落。
  const n = 7, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 5;
  grid[at(2, 3)] = 1; army[at(2, 3)] = 3000;
  grid[at(1, 2)] = 2; army[at(1, 2)] = 20;
  grid[at(6, 3)] = 102; army[at(6, 3)] = 5;
  const s = { n, m, turn: 61, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'preempt-gap' };
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.x, 2); assert.equal(a.y, 3);
  assert.equal(a.reason.phase, 'preempt-anchor');
});

test('只有广义风险（敌方下一 tick 打不下脖子）时不预锚，按原逻辑推进', () => {
  // 同上棋盘但敌堆只有 6 兵：6-1=5 打不下 5 兵脖子——risky 成立、imminent 不成立。
  const n = 7, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 5;
  grid[at(2, 3)] = 1; army[at(2, 3)] = 3000;
  grid[at(1, 2)] = 2; army[at(1, 2)] = 6;
  grid[at(6, 3)] = 102; army[at(6, 3)] = 5;
  const s = { n, m, turn: 61, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'preempt-risky' };
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.notEqual(a.kind, 'build');
  assert.equal(a.reason.phase, 'advance');
});

test('小堆不预锚：切断风险相同但兵力低于 preemptAnchorMinArmy 时照常推进', () => {
  const a = chooseCampaign(preemptBoard({ stackArmy: 100 }), {}, { targetOwner: 2 });
  assert.ok(a);
  assert.notEqual(a.kind, 'build');
});

test('建成后余兵压不住贴脸敌兵时不预锚（落地即被拆，白送 50）', () => {
  // 大堆 130 兵但贴脸敌堆 100：130-50=80 压不住 99，预锚放弃。
  // ratio 压低只为绕开全局军力门槛（本用例考的是贴脸安全条件，不是军力比）。
  const a = chooseCampaign(preemptBoard({ stackArmy: 130, sideEnemy: 100 }), {}, { targetOwner: 2, ratio: 0.1 });
  assert.ok(a);
  assert.notEqual(a.kind, 'build');
});

test('钱不够 51 时原地等凑兵，超过 preemptAnchorWaitTicks 放弃预锚改正常推进', () => {
  const s = preemptBoard({ stackArmy: 45 });
  for (let y = 0; y < s.m; y++) if (s.grid[y] === 1) s.army[y] = 20; // 第 0 行加厚，过全局军力门槛
  const opts = { targetOwner: 2 };
  const params = { preemptAnchorMinArmy: 40 }; // 44 >= 40 触发预锚，但 45 < 51 起不起
  assert.equal(chooseCampaign(s, params, opts), null, '第 1 tick 原地等钱');
  s.turn = 62;
  assert.equal(chooseCampaign(s, params, opts), null, '第 2 tick 仍在等');
  s.turn = 63;
  const a = chooseCampaign(s, params, opts);
  assert.ok(a, '等满 2 tick 仍不够，放弃预锚恢复正常推进');
  assert.notEqual(a.kind, 'build');
});

test('腾出格补锚：大堆上一步走进 rally 后，立即在腾出的格上补指挥所', () => {
  // 8×7：皇冠 (0,3)，走廊 (1,3)=15/(2,3)=15/(3,3)=60（刚腾出），rally (4,3)=3000。
  // 走廊贴敌（risky），lastMove 回执 (3,3)→(4,3) 证明大堆刚从 (3,3) 走进 rally。
  const n = 8, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 15;
  grid[at(2, 3)] = 1; army[at(2, 3)] = 15;
  grid[at(3, 3)] = 1; army[at(3, 3)] = 60;
  grid[at(4, 3)] = 1; army[at(4, 3)] = 3000;
  grid[at(7, 3)] = 102; army[at(7, 3)] = 5;
  const s = { n, m, turn: 61, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'backfill',
    lastMove: { op: 'm', x: 3, y: 3, dx: 4, dy: 3, turn: 61 } };
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3, '锚点落在大堆刚腾出的格上');
  assert.equal(a.reason.phase, 'backfill-anchor');
});

test('policy 调度：预锚压过脖子纪律的增援/回缩，输出建造而非移动', () => {
  const a = chooseAction(preemptBoard());
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3);
});

test('policy 调度：本 tick 能拆敌方指挥所的推进优先于预锚（斩首例外）', () => {
  const a = chooseAction(preemptBoard({ city: true }));
  assert.ok(a);
  assert.equal(a.kind, 'attack');
  assert.equal(a.dx, 4); assert.equal(a.dy, 3, '拆建筑的推进不被预锚顶掉');
});

test('policy 调度：背水一战/皇冠告急优先于预锚', () => {
  // 5×7 山地：家里完全复刻 defense 单测的背水 lane 棋盘——皇冠 (2,0)=20、
  // 后方 60 兵堆 (1,1)，敌堆 (2,3)=200 三 tick 破城且补不齐缺口（lastStand）。
  // 另一路深入大堆 (0,5)=500 经走廊 (0,3)/(0,4) 连回家，脖子 (1,3)=5 贴脸同一
  // 敌堆（1-tick 切断成立）——但它离皇冠防线 6+ 跳，帮不上忙。
  // 预锚条件与背水同时成立时，动作必须是防守类移动而非原地建站。
  const n = 5, m = 7, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  const put = (x, y, g, a) => { grid[at(x, y)] = g; army[at(x, y)] = a; };
  put(2, 0, 101, 20); put(1, 0, 1, 5); put(1, 1, 1, 60); put(2, 1, 1, 5);
  put(1, 2, 1, 5); put(2, 2, 1, 5); put(1, 3, 1, 5);
  put(0, 3, 1, 5); put(0, 4, 1, 5); put(0, 5, 1, 500);
  put(0, 6, 0, 0); put(1, 6, 0, 0);
  put(2, 3, 2, 200); put(2, 4, 2, 50); put(2, 6, 102, 100);
  const s = { n, m, turn: 600, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]),
    isolated: Array(size).fill(0), gameId: 'preempt-vs-laststand' };
  const preempt = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(preempt);
  assert.equal(preempt.kind, 'build');
  assert.equal(preempt.reason.phase, 'preempt-anchor', '无家里告急时该棋盘确实触发预锚');
  const a = chooseAction(s);
  assert.ok(a);
  assert.notEqual(a.kind, 'build', '皇冠告急时不得停工建站');
  assert.match(a.reason, /防守|背水/, '动作应为皇冠防守/背水一战');
});

// 深入决心：两个敌皇冠 (7,1)/(7,5)，大堆 A (3,1)=3000 朝 (7,1)，大堆 B (3,5) 稍小。
function resolveBoard(bArmy = 2900) {
  const n = 8, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  for (const y of [1, 5]) { grid[at(1, y)] = 1; army[at(1, y)] = 15; grid[at(2, y)] = 1; army[at(2, y)] = 15; }
  grid[at(3, 1)] = 1; army[at(3, 1)] = 3000;
  grid[at(3, 5)] = 1; army[at(3, 5)] = bArmy;
  grid[at(7, 1)] = 102; army[at(7, 1)] = 5;
  grid[at(7, 5)] = 102; army[at(7, 5)] = 5;
  return { n, m, turn: 61, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'resolve' };
}

test('深入决心：另一方向评分略优（差距 ≤campaignResolveMargin）时不换目标', () => {
  const s = resolveBoard();
  const first = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(first);
  assert.equal(first.reason.target, 7 * 7 + 1, '首次出击锁定较近的皇冠 (7,1)');
  s.turn = 62;
  s.army[3 * 7 + 5] = 3100; // 另一方向变得略优，但差距在决心窗口容忍内
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.reason.target, 7 * 7 + 1, '决心窗口内不因微小评分波动换方向');
  assert.equal(a.x, 3); assert.equal(a.y, 1);
});

test('深入决心：另一方向评分甩开 margin 才换目标', () => {
  const s = resolveBoard();
  assert.ok(chooseCampaign(s, {}, { targetOwner: 2 }));
  s.turn = 62;
  s.army[3 * 7 + 5] = 100000; // 甩开 campaignResolveMargin，解锁换向
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.reason.target, 7 * 7 + 5);
});

test('深入决心：窗口过期后自动解锁，重新按评分选方向', () => {
  const s = resolveBoard();
  assert.ok(chooseCampaign(s, {}, { targetOwner: 2 })); // 锁定 until=61+8=69
  s.turn = 70; // 过窗口
  s.army[3 * 7 + 5] = 3100;
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.reason.target, 7 * 7 + 5, '窗口过期后按当下最优方向推进');
});
