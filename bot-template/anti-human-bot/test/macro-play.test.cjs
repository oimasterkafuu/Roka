'use strict';
// 第二轮宏观方针（2026-09-27）回归测试：
//   斩首全兵推 / 多路合力连续攻击 + 目标锁定 / 进攻全兵优先 /
//   运输小勺过滤 / 工地与集结点滞回 / 僵持放弃 / 防守提前汇兵不越护栏。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrontline } = require('../bot/frontline.cjs');
const { chooseLogistics } = require('../bot/logistics.cjs');
const { chooseDefense } = require('../bot/defense.cjs');

function board(n = 5, m = 7, turn = 600) {
  return { n, m, turn, playerId: 1, grid: Array(n * m).fill(201), army: Array(n * m).fill(0),
    isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const put = (s, i, g, a) => { s.grid[i] = g; s.army[i] = a; return s; };

// ── 斩首：贴脸皇冠必攻，不看旁边敌大堆 ─────────────────────────────────
test('贴脸皇冠必攻：旁边敌大堆不参与斩首决策（t417 回归）', () => {
  const s = board();
  // 16=(2,2) 我方 32 兵，17=(2,3) 敌皇冠守 8，18=(2,4) 敌大堆 484
  put(s, 16, 1, 32); put(s, 17, 102, 8); put(s, 18, 2, 484);
  const move = { x: 2, y: 2, dx: 2, dy: 3, mode: 1 };
  const result = createFrontline(s).assess(move);
  assert.ok(result, '旧版被 reinforce≈363 的「守军」吓退，新版必须直接推');
  assert.equal(result.mode, 2, '斩首全兵推');
  assert.match(result.reason, /斩首/);
  // 整合期（被反推）也不拦斩首
  assert.ok(createFrontline(s, { consolidate: true }).assess(move));
});

test('自家建筑当源点推皇冠仍按留守规则（防守逻辑保留）', () => {
  const s = board();
  // 16 是我方皇冠 101，旁边贴着 500 敌兵 → 留守不足时不能抽空去推另一个皇冠
  put(s, 16, 101, 100); put(s, 17, 102, 30); put(s, 15, 2, 500);
  const move = { x: 2, y: 2, dx: 2, dy: 3, mode: 1 };
  assert.equal(createFrontline(s).assess(move), null, '自家建筑不能被斩首抽空');
  // 敌压移走后照常全兵推（建筑源点也优先最大出兵）
  const s2 = board();
  put(s2, 16, 101, 100); put(s2, 17, 102, 30);
  const ok = createFrontline(s2).assess(move);
  assert.ok(ok);
  assert.match(ok.reason, /斩首/);
});

// ── 多路合力：1100 + 1100 对 2000，两击连续推掉 ────────────────────────
test('多路合力推皇冠：单格不够、合力够就打第一击并锁定连续攻击', () => {
  const s = board();
  // 皇冠 17=(2,3) 守 200；16=(2,2) 与 10=(1,3) 各 120——单格推不下，合力 238 > 201
  put(s, 17, 102, 200); put(s, 16, 1, 120); put(s, 10, 1, 120);
  const first = createFrontline(s).choose();
  assert.ok(first, '合力足够必须立即开打');
  assert.equal(first.dx * 7 + first.dy, 17);
  assert.equal(first.mode, 2, '第一击全兵（打残，不留着过年）');
  assert.match(first.reason, /合力斩首/);
  // 模拟第一击落地：出兵格空了，皇冠守军被打残
  const from = first.x * 7 + first.y;
  const push = s.army[from] - 1;
  s.army[from] = 1;
  s.army[17] -= push;
  s.turn += 1;
  // 锁定期间：另一格继续打同一皇冠（此刻单格已能收割），不被别的事情抢走 tick
  const second = createFrontline(s).choose();
  assert.ok(second, '锁定期间必须连续攻击');
  assert.equal(second.dx * 7 + second.dy, 17, '第二击收割同一皇冠');
  assert.equal(second.x * 7 + second.y === from, false, '第二击来自另一格');
  // 皇冠被推掉后锁定解除，不再对旧目标出手
  s.grid[17] = 1; s.army[17] = 1; s.turn += 1;
  assert.equal(createFrontline(s).choose(), null);
});

test('合力也不够时不送兵：不拿小股去撞皇冠', () => {
  const s = board();
  put(s, 17, 102, 500); put(s, 16, 1, 100); put(s, 10, 1, 100); // 合力 198 < 501
  assert.equal(createFrontline(s).choose(), null);
});

// ── 进攻全兵优先：兵够不分小勺 ─────────────────────────────────────────
test('进攻一律全兵优先：1100 对 1000 一推拿下，不分 500/250 小勺', () => {
  const s = board();
  put(s, 16, 1, 1100); put(s, 17, 2, 1000);
  const move = { x: 2, y: 2, dx: 2, dy: 3, mode: 1 };
  const result = createFrontline(s).assess(move);
  assert.ok(result);
  assert.equal(result.mode, 2, '能全兵推掉就必须全兵（mode 2 整格压上）');
});

// ── 运输小勺过滤：低于 minTransport 且填不满缺口的运输不执行 ────────────
test('前线补给不蚂蚁搬家：小勺运输被过滤', () => {
  // 1×8 走廊：皇冠 1600 兵在前，门口敌堆 3000；后方只有 5 兵小股
  const s = { n: 1, m: 8, playerId: 1, turn: 101, grid: [101, 1, 1, 1, 1, 1, 1, 2],
    army: [1600, 5, 5, 5, 5, 5, 1, 3000], isolated: Array(8).fill(0),
    fog: Array(8).fill(false), teams: new Map([[1, 1], [2, 2]]) };
  const big = chooseLogistics(s, null, null, { militaryOnly: true });
  assert.ok(big, '大股运输照常执行');
  assert.ok(big.reason.amount >= 8, `运输量必须 ≥ minTransport，实际 ${big.reason.amount}`);
  // 把大军撤掉，只剩 5 兵小股 → 本 tick 不做 5 兵蚂蚁运输
  s.army[0] = 1; s.turn += 1;
  assert.equal(chooseLogistics(s, null, null, { militaryOnly: true }), null,
    '只有 <8 兵的小股可运时不发起运输');
});

// ── 集结点僵持放弃：缺口长期不收敛就停止喂兵 ───────────────────────────
test('持续喂兵但缺口不收敛 → 放弃该集结点（禁止无目的僵持堆兵）', () => {
  const s = { n: 1, m: 8, playerId: 1, turn: 101, grid: [101, 1, 1, 1, 1, 1, 1, 2],
    army: [1600, 1, 1, 1, 1, 1, 1, 3000], isolated: Array(8).fill(0),
    fog: Array(8).fill(false), teams: new Map([[1, 1], [2, 2]]) };
  const supply = () => chooseLogistics(s, null, null, { militaryOnly: true });
  assert.ok(supply(), '起初正常补给');
  // 棋盘冻结（不实际执行运输）：缺口永远不变，相当于「一直在喂却永远集不齐」
  let abandoned = -1;
  for (let t = 0; t < 40 && abandoned < 0; t++) { s.turn += 1; if (!supply()) abandoned = s.turn; }
  assert.ok(abandoned > 0, 'rallyStallTicks 内无进展必须放弃集结点');
  // 放弃后冷静期内不再选它
  s.turn += 1;
  assert.equal(supply(), null, '冷静期内不再向同一集结点喂兵');
});

// ── 工地滞回：微小扰动不换工地，明显更好才换 ────────────────────────────
test('经济工地滞回：候选评分微超不换，明显更好（≥1.5×）才换', () => {
  const s = { n: 1, m: 10, playerId: 1, turn: 101, grid: [101, 1, 1, 1, 1, 1, 1, 1, 1, 2],
    army: [200, 1, 30, 29, 1, 1, 1, 1, 1, 300], isolated: Array(10).fill(0),
    fog: Array(10).fill(false), teams: new Map([[1, 1], [2, 2]]) };
  const fund = () => chooseLogistics(s, null, null, { economyOnly: true });
  assert.equal(fund()?.reason?.target, 2, '初始工地是兵力最多的安全格');
  s.army[3] = 31; s.turn++; // 邻格微超（31 > 30，但 < 30×1.5）
  assert.equal(fund()?.reason?.target, 2, '微小扰动不换工地——每 tick 换目标就是来回倒兵');
  s.army[3] = 50; s.turn++; // 明显更好（50 > 30×1.5）
  assert.equal(fund()?.reason?.target, 3, '明显更好的挑战者才允许换');
});

// ── 防守提前汇兵不越护栏：只有贴脸/截击才算 imminent ────────────────────
const at7 = (x, y) => x * 7 + y;
function lane({ foeDistance = 3, rearPile = 500, crown = 20, front = 5 } = {}) {
  const s = board();
  put(s, at7(2, 0), 101, crown); put(s, at7(1, 0), 1, 5);
  put(s, at7(1, 1), 1, rearPile); put(s, at7(2, 1), 1, 5);
  put(s, at7(1, 2), 1, 5); put(s, at7(2, 2), 1, front);
  put(s, at7(1, 3), 1, 5); put(s, at7(2, 3), 1, front);
  put(s, at7(2, foeDistance), 2, 200);
  put(s, at7(2, foeDistance + 1), 2, 50);
  put(s, at7(2, 6), 102, 100);
  return s;
}

test('提前汇兵（威胁 2+ tick）不标记 imminent，不再绕过移动护栏', () => {
  const d = chooseDefense(lane({ foeDistance: 3 }));
  assert.ok(d);
  assert.equal(d.urgent, true, '仍然 urgent 抢占调度优先级');
  assert.ok(!d.imminent, '但不再是 emergency——与经济运输互相倒兵的绕圈根因');
});

test('贴脸救城（1 tick）仍然 imminent，保持紧急放行', () => {
  const s = lane({ foeDistance: 2 });
  // 敌军贴到皇冠隔壁
  put(s, at7(2, 1), 2, 200); s.army[at7(2, 2)] = 5; s.grid[at7(2, 2)] = 1;
  const d = chooseDefense(s);
  assert.ok(d);
  assert.ok(d.imminent, '1 tick 贴脸威胁必须紧急');
});
