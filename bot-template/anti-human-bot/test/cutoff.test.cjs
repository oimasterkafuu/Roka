'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCutoff } = require('../bot/cutoff.cjs');
const { createContext } = require('../bot/threat.cjs');

// 7x9：我方腹地 + 敌方一条插入走廊，走廊与敌方主体之间只有 (4,4) 一格相连。
//   x=3 行： (3,3)(3,4)(3,5) 插入部队
//   (4,4)  ： 脖子（唯一连接）
//   x=5 行： (5,3)..(5,6) 敌方主体，x=6 行是敌方主城所在
const n = 7, m = 9, at = (x, y) => x * m + y;
function raid() {
  const grid = Array(n * m).fill(201), army = Array(n * m).fill(0);
  for (let x = 1; x <= 5; x++) for (let y = 1; y <= 7; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 1; }
  grid[at(1, 1)] = 101; army[at(1, 1)] = 50;
  for (const y of [3, 4, 5]) { grid[at(3, y)] = 2; army[at(3, y)] = 30; }
  grid[at(4, 4)] = 2; army[at(4, 4)] = 25;
  for (const y of [3, 4, 5, 6]) { grid[at(5, y)] = 2; army[at(5, y)] = 40; }
  for (let y = 1; y <= 7; y++) { grid[at(6, y)] = 2; army[at(6, y)] = 60; }
  grid[at(6, 1)] = 102; army[at(6, 1)] = 200;
  return { n, m, turn: 500, playerId: 1, grid, army, isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('插入部队有单格脖子时直接截断', () => {
  const s = raid(); s.army[at(4, 3)] = 60;          // 紧邻脖子已有足够兵力
  const result = chooseCutoff(s);
  assert.ok(result, '应识别出可截断');
  assert.equal(result.strike, true);
  assert.equal(result.move.dx * m + result.move.dy, at(4, 4));
  assert.ok(s.army[at(4, 4)] < 60);
  assert.match(result.move.reason, /截断入侵/);
});

test('邻格兵力不足时先集兵：从 2–4 格外的格子往瓶颈送兵', () => {
  const s = raid();
  s.army[at(4, 3)] = 10; s.army[at(4, 5)] = 6;
  s.army[at(4, 2)] = 100; s.army[at(4, 6)] = 100;   // 后方两格
  const result = chooseCutoff(s);
  assert.ok(result, '应给出集兵方案');
  assert.equal(result.strike, false);
  assert.match(result.move.reason, /截断集兵/);
  assert.equal(result.move.dy, 4 - 1);              // 朝瓶颈方向推进
});

test('集兵到位后下一次就能截断', () => {
  const s = raid();
  s.army[at(4, 3)] = 10; s.army[at(4, 2)] = 100;
  const ctx = createContext(s, {});
  const push = (from, to) => {
    let reserve = 0;
    for (const k of ctx.neighbors[from]) {
      if (k === to || s.grid[k] === 201 || s.grid[k] === 203 || s.grid[k] % 50 === 1) continue;
      reserve += s.army[k];
    }
    return Math.min(s.army[from] - 1, Math.max(0, s.army[from] - reserve - 1));
  };
  const gather = chooseCutoff(s);
  assert.equal(gather.strike, false);
  const from = gather.move.x * m + gather.move.y, to = gather.move.dx * m + gather.move.dy;
  const amount = push(from, to);
  s.army[from] -= amount; s.army[to] += amount; s.turn++;
  const strike = chooseCutoff(s);
  assert.ok(strike && strike.strike, '凑够兵力后必须动手');
  assert.equal(strike.move.dx * m + strike.move.dy, at(4, 4));
});

test('两格宽的走廊没有单格瓶颈时不硬凑', () => {
  const s = raid(); s.grid[at(4, 3)] = 2; s.army[at(4, 3)] = 25; s.army[at(4, 3)] = 25;
  assert.equal(chooseCutoff(s), null);
});

test('普通边境接触没有割点时不触发截断', () => {
  // 实心边境：敌方两行贴着两行我方，任意移除一两格都不会孤立任何段。
  const s = raid();
  for (let y = 1; y <= 7; y++) { s.grid[at(2, y)] = 2; s.army[at(2, y)] = 40; }
  for (let y = 1; y <= 7; y++) { s.grid[at(3, y)] = 2; s.army[at(3, y)] = 30; }
  for (let y = 3; y <= 6; y++) { s.grid[at(4, y)] = 2; s.army[at(4, y)] = 30; }
  s.army[at(1, 3)] = 500; s.army[at(1, 5)] = 500; // 我方兵力够，但对面没有脖子可掐
  assert.equal(chooseCutoff(s), null);
});

test('敌方散开的兵力有单格脖子时直接截断（不限于入侵）', () => {
  // raid() 上把 (3,3..5) 换成我方后，敌方 2、3 两行大军只靠 (4,4) 连回主体：
  // 占住 (4,4) 就能冻住它们——这是散兵截断，不是入侵截断。
  const s = raid();
  for (let y = 1; y <= 7; y++) { s.grid[at(2, y)] = 2; s.army[at(2, y)] = 40; }
  for (let y = 1; y <= 7; y++) { s.grid[at(3, y)] = 2; s.army[at(3, y)] = 30; }
  s.army[at(4, 3)] = 500; s.army[at(4, 5)] = 500;
  const result = chooseCutoff(s);
  assert.ok(result, '散开的敌方大军有脖子时必须识别');
  assert.equal(result.strike, true);
  assert.equal(result.move.dx * m + result.move.dy, at(4, 4));
  assert.match(result.move.reason, /截断散兵/);
  assert.ok(result.trapped >= 400, `应冻住两行敌军，实际 ${result.trapped}`);
});

test('敌方城市/主城不会被误判为入侵格', () => {
  const s = raid();
  s.army[at(4, 2)] = 200;                            // 提供可集兵来源
  const result = chooseCutoff(s);
  assert.ok(result);
  assert.notEqual(result.move.dx * m + result.move.dy, at(6, 1));
  assert.ok(result.trapped <= 200, '只能冻住插入部队，不能把敌方主体算进来');
});

test('不修改输入局面且同局面决策确定', () => {
  const s = raid(); s.army[at(4, 3)] = 60;
  const before = JSON.stringify(s);
  const first = chooseCutoff(s), second = chooseCutoff(s);
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(first?.move, second?.move);
});

// 6x8 两格宽脖子：(4,2)(4,3) 并排，单独占任何一格都切不断，两格都占才能孤立 (3,2)(3,3)。
function pairNeck() {
  const n2 = 6, m2 = 8, at2 = (x, y) => x * m2 + y;
  const grid = Array(n2 * m2).fill(201), army = Array(n2 * m2).fill(0);
  for (let x = 1; x <= 2; x++) for (let y = 1; y <= 6; y++) { grid[at2(x, y)] = 1; army[at2(x, y)] = 2; }
  grid[at2(1, 1)] = 101; army[at2(1, 1)] = 60;
  grid[at2(4, 1)] = 1; army[at2(4, 1)] = 150;   // 紧邻脖子的我方打击格
  grid[at2(4, 4)] = 1; army[at2(4, 4)] = 150;   // 脖子另一侧也贴我方格
  grid[at2(3, 1)] = 1; army[at2(3, 1)] = 2;
  for (const y of [2, 3]) { grid[at2(3, y)] = 2; army[at2(3, y)] = 40; } // 散开的大军
  for (const y of [2, 3]) { grid[at2(4, y)] = 2; army[at2(4, y)] = 10; } // 两格宽脖子
  for (let y = 1; y <= 6; y++) { grid[at2(5, y)] = 2; army[at2(5, y)] = 30; }
  grid[at2(5, 1)] = 102; army[at2(5, 1)] = 5;    // 敌方皇冠（锚点）
  return { n: n2, m: m2, turn: 500, playerId: 1, grid, army, isolated: Array(n2 * m2).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('两格宽脖子：单格切不断时识别两格组合，先打较弱一格', () => {
  const s = pairNeck();
  const at2 = (x, y) => x * 8 + y;
  const result = chooseCutoff(s);
  assert.ok(result, '两格组合截断必须被识别');
  assert.equal(result.strike, true);
  assert.match(result.move.reason, /两格脖子/);
  const target = result.move.dx * 8 + result.move.dy;
  assert.ok(target === at2(4, 2) || target === at2(4, 3), `应先打脖子之一，实际 ${target}`);
  assert.ok(result.trapped >= 80, `应冻住散开大军，实际 ${result.trapped}`);
});

test('被切断段含敌方皇冠时截断无效，不盲目出手', () => {
  // 敌方 2x2 块含皇冠：移除任何一两格，剩余部分仍连着自己的皇冠，孤立不成立。
  const n2 = 6, m2 = 8, at2 = (x, y) => x * m2 + y;
  const grid = Array(n2 * m2).fill(201), army = Array(n2 * m2).fill(0);
  for (let y = 1; y <= 6; y++) { grid[at2(1, y)] = 1; army[at2(1, y)] = 2; }
  grid[at2(1, 1)] = 101; army[at2(1, 1)] = 60;
  grid[at2(2, 2)] = 1; army[at2(2, 2)] = 200;   // 我方重兵贴着敌块， naive 实现会出手
  for (const [x, y] of [[3, 2], [3, 3], [4, 2], [4, 3]]) { grid[at2(x, y)] = 2; army[at2(x, y)] = 40; }
  grid[at2(4, 3)] = 102; army[at2(4, 3)] = 200; // 敌块内含皇冠
  const s = { n: n2, m: m2, turn: 500, playerId: 1, grid, army, isolated: Array(n2 * m2).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  assert.equal(chooseCutoff(s), null, '含皇冠的段永远连得回锚点，不存在有效截断');
});

test('占下瓶颈但守不住（锚侧反夺力过大）时不送兵', () => {
  // raid() 里敌方皇冠 (6,1) 紧邻 (6,2)：占 (6,2) 能冻住全部敌兵，
  // 但皇冠 200 兵下一 tick 就夺回，这种「截断」纯属送死。
  const s = raid();
  s.army[at(5, 2)] = 150; // 足以打下 (6,2)，但守不住
  const result = chooseCutoff(s);
  if (result) assert.notEqual(result.move.dx * m + result.move.dy, at(6, 2), '守不住的瓶颈不能打');
});

// 防守场景：敌方 60 兵 4 回合后可到我方皇冠（defense 有动作但不 urgent），
// 同时远处有一个非紧急的散兵截断（冻 30 < 紧急线 32，且离我锚点 11 格不触发入侵截断），
// 另有一个普通的边界推进可选。截断必须压过普通推进与调兵（旧策略会走 advance 分支）。
test('防守场景下非紧急截断优先于普通推进与调兵', () => {
  const { chooseAction, getDecisionDiagnostics } = require('../bot/policy.cjs');
  const n2 = 8, m2 = 12, at2 = (x, y) => x * m2 + y;
  const grid = Array(n2 * m2).fill(201), army = Array(n2 * m2).fill(0);
  for (let x = 1; x <= 4; x++) for (let y = 1; y <= 10; y++) { grid[at2(x, y)] = 1; army[at2(x, y)] = 1; }
  grid[at2(1, 1)] = 101; army[at2(1, 1)] = 40;          // 我方皇冠
  grid[at2(2, 2)] = 1; army[at2(2, 2)] = 30;            // 防守援军来源
  grid[at2(2, 10)] = 1; army[at2(2, 10)] = 15;          // 贴着远处割点的打击格
  grid[at2(3, 5)] = 1; army[at2(3, 5)] = 20;            // 普通进攻源（旧策略会选它）
  grid[at2(4, 5)] = 2; army[at2(4, 5)] = 3;             // 普通进攻目标（连着敌方主体）
  grid[at2(5, 5)] = 2; army[at2(5, 5)] = 3;
  grid[at2(6, 5)] = 2; army[at2(6, 5)] = 3;
  grid[at2(5, 1)] = 2; army[at2(5, 1)] = 60;            // 防守威胁：4 回合到皇冠
  grid[at2(1, 10)] = 2; army[at2(1, 10)] = 2;           // 敌方踪迹格
  grid[at2(1, 11)] = 2; army[at2(1, 11)] = 22;          // 冻住段
  grid[at2(2, 11)] = 2; army[at2(2, 11)] = 3;           // 割点之一（离我锚点 11 格）
  for (let x = 3; x <= 7; x++) { grid[at2(x, 11)] = 2; army[at2(x, 11)] = 3; }
  for (let y = 1; y <= 10; y++) { grid[at2(7, y)] = 2; army[at2(7, y)] = 3; }
  grid[at2(6, 1)] = 2; army[at2(6, 1)] = 3;             // 敌方底部回廊（保证威胁堆连通）
  grid[at2(7, 11)] = 102; army[at2(7, 11)] = 30;        // 敌方皇冠
  const s = { n: n2, m: m2, turn: 500, playerId: 1, grid, army, isolated: Array(n2 * m2).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const action = chooseAction(s, {});
  const diag = getDecisionDiagnostics(s);
  assert.ok(action, '必须有动作');
  assert.equal(diag?.branch, 'cutoff', `防守场景应走截断分支，实际 ${diag?.branch}：${JSON.stringify(action)}`);
  assert.match(JSON.stringify(action.reason), /截断/);
});

// ── 脖子纪律：我方割点驻守/回缩 ──────────────────────────────────────────
// 8x9：我方北方集团（第 1–2 行）只靠脖子 (3,4) 连回南方腹地与皇冠 (5,1)，
// 敌方 300 兵堆贴在 (3,5)，本 tick 就能打下脖子。
function thinNeck() {
  const n2 = 8, m2 = 9, at2 = (x, y) => x * m2 + y;
  const grid = Array(n2 * m2).fill(201), army = Array(n2 * m2).fill(0);
  for (let y = 1; y <= 7; y++) { grid[at2(1, y)] = 1; army[at2(1, y)] = 3; }
  grid[at2(1, 4)] = 1; army[at2(1, 4)] = 120;  // 北方大堆（将被冻住的主力）
  grid[at2(2, 4)] = 1; army[at2(2, 4)] = 2;
  grid[at2(3, 4)] = 1; army[at2(3, 4)] = 4;    // 细脖子
  for (let x = 4; x <= 6; x++) for (let y = 1; y <= 4; y++) { grid[at2(x, y)] = 1; army[at2(x, y)] = 5; }
  grid[at2(5, 1)] = 101; army[at2(5, 1)] = 40; // 我方皇冠
  grid[at2(3, 5)] = 2; army[at2(3, 5)] = 300;  // 贴着脖子的敌方大堆
  grid[at2(3, 6)] = 2; army[at2(3, 6)] = 30;
  grid[at2(3, 7)] = 102; army[at2(3, 7)] = 30; // 敌方皇冠
  return { n: n2, m: m2, turn: 500, playerId: 1, grid, army, isolated: Array(n2 * m2).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('细脖子贴着敌方大堆时紧急补兵/回缩', () => {
  const { chooseNeckGuard } = require('../bot/cutoff.cjs');
  const result = chooseNeckGuard(thinNeck());
  assert.ok(result, '必须识别即将被打穿的割点');
  assert.equal(result.urgent, true);
  assert.ok(result.stranded >= 120, `应算出被冻兵力，实际 ${result.stranded}`);
  // 最优解是把北方大堆 (1,4) 往脖子方向回缩
  assert.match(result.move.reason, /脖子/);
});

test('脖子守军足够时不触发驻守', () => {
  const { chooseNeckGuard } = require('../bot/cutoff.cjs');
  const s = thinNeck();
  s.army[3 * 9 + 4] = 400; // 脖子比敌堆还厚
  assert.equal(chooseNeckGuard(s), null);
});

test('割点受威胁但断开损失很小时不触发驻守', () => {
  const { chooseNeckGuard } = require('../bot/cutoff.cjs');
  const s = thinNeck();
  for (let y = 1; y <= 7; y++) s.army[1 * 9 + y] = 1; // 北方只剩零星兵力
  s.army[1 * 9 + 4] = 1;
  s.army[2 * 9 + 4] = 0; // 合计 7 兵 < 8 的冻结阈值
  assert.equal(chooseNeckGuard(s), null);
});

test('敌堆大到守不住也追不上时放弃死守（不每 tick 白送兵）', () => {
  const { chooseNeckGuard } = require('../bot/cutoff.cjs');
  const s = thinNeck();
  s.army[3 * 9 + 5] = 2000; // 敌堆 2000：脖子 4 + 增援 119×3 也追不上
  assert.equal(chooseNeckGuard(s), null, '必死之局应把 tick 让给别的分支，而不是往割点里填兵');
});
