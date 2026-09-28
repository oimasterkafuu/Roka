'use strict';
// 截断失灵根因修复 + 涂色/建造天平矫正（2026-09-29 用户硬方针）回归测试：
//   1. 敌纵队深入有脖子必截——确证根因：旧调度里非紧急截断只在
//      urgent||defenseScenario||!canAdvance 时执行，而只要有涂色可扩 canAdvance 恒真，
//      截断方案（cutoff 不看反扑、frontline 打不动的脖子）被无限期搁置、涂色每 tick 抢先；
//   2. 三格宽脖子（敌宽锋面纵队）有截断候选（旧：单格/两格组合之外返回 null）；
//   3. 产能点落后时建造压过涂色（竞赛追赶做实）；
//   4. 不落后时可负担的建造同样压过纯涂色；
//   5. 薄土涂色降权：薄占领（arrive < paintThinArrive）扣分、负分候选直接跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCutoff } = require('../bot/cutoff.cjs');
const { chooseAction, getDecisionDiagnostics } = require('../bot/policy.cjs');
const { createFrontline } = require('../bot/frontline.cjs');

// ── 场景一（确证根因复现）：敌纵队沿 y=6 深入我腹地，脖子 (8,6) 只有 10 兵，
//    但下方贴着敌大堆 (9,6)=200——frontline 把反扑折算进守军（≈72）打不动它，
//    cutoff 按「不看反扑」方针能出兵 49 直接掐断。我方皇冠 500 兵无缺口（defense
//    无动作）、腹地有中立口袋可涂色（canAdvance 恒真）。旧策略：无限期涂色不截。
function deepRaid() {
  const n = 12, m = 16, at = (x, y) => x * m + y;
  const grid = Array(n * m).fill(0), army = Array(n * m).fill(0);
  for (let x = 0; x <= 7; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 2; }
  grid[at(2, 2)] = 101; army[at(2, 2)] = 500;                    // 我方皇冠（重兵，defense 无缺口）
  for (let x = 9; x <= 11; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 2; army[at(x, y)] = 40; }
  grid[at(10, 14)] = 102; army[at(10, 14)] = 80;                 // 敌方皇冠
  grid[at(9, 6)] = 2; army[at(9, 6)] = 200;                      // 脖子下方敌大堆（反扑折算来源）
  for (const x of [4, 5, 6, 7]) { grid[at(x, 6)] = 2; army[at(x, 6)] = 6; } // 深入段 24 兵
  grid[at(8, 6)] = 2; army[at(8, 6)] = 10;                       // 脖子（离我锚点 10 格，非 urgent）
  grid[at(8, 5)] = 1; army[at(8, 5)] = 50;                       // 我方贴着脖子的打击堆
  grid[at(8, 4)] = 1; army[at(8, 4)] = 2;                        // 打击堆的另一条连通路径
  grid[at(3, 8)] = 0; army[at(3, 8)] = 0;                        // 腹地中立口袋
  grid[at(2, 8)] = 1; army[at(2, 8)] = 30;                       // 口袋旁的涂色源
  return { n, m, turn: 500, playerId: 1, grid, army, isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('敌纵队深入有脖子必截：非紧急截断压过纯涂色（根因回归）', () => {
  const s = deepRaid();
  const cutoff = chooseCutoff(s);
  assert.ok(cutoff, '截断模块能给出方案（不看反扑口径）');
  assert.equal(cutoff.urgent, false, '该场景不是 urgent，也不是 defenseScenario——旧调度因此搁置');
  const action = chooseAction(s);
  const diag = getDecisionDiagnostics(s);
  assert.ok(action);
  assert.equal(diag?.branch, 'cutoff', `必须走截断分支，旧策略走 advance 涂色；实际 ${diag?.branch}`);
  assert.equal(action.dx, 8); assert.equal(action.dy, 6, '必须打在脖子上');
  assert.match(action.reason, /截断/);
});

// ── 场景二：三格宽脖子（敌宽锋面纵队），旧实现单格/两格组合之外直接返回 null。
function wideRaid() {
  const n = 12, m = 16, at = (x, y) => x * m + y;
  const grid = Array(n * m).fill(0), army = Array(n * m).fill(0);
  for (let x = 0; x <= 7; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 2; }
  grid[at(2, 2)] = 101; army[at(2, 2)] = 500;
  for (let x = 9; x <= 11; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 2; army[at(x, y)] = 40; }
  grid[at(10, 14)] = 102; army[at(10, 14)] = 80;
  for (const x of [4, 5, 6, 7, 8]) for (const y of [6, 7, 8]) { grid[at(x, y)] = 2; army[at(x, y)] = 8; }
  grid[at(8, 5)] = 1; army[at(8, 5)] = 2;
  grid[at(8, 9)] = 1; army[at(8, 9)] = 100;                      // 贴着三格脖子一端的打击堆
  return { n, m, turn: 500, playerId: 1, grid, army, isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('三格宽脖子：识别夹心三格组合，优先直接占下的一端', () => {
  const s = wideRaid();
  const result = chooseCutoff(s);
  assert.ok(result, '三格宽脖子必须有截断候选（旧实现返回 null）');
  assert.match(result.move.reason, /三格脖子/);
  assert.equal(result.strike, true, '脖子一端贴着我方大堆，应直接打而不是集兵');
  assert.equal(result.move.dx, 8); assert.equal(result.move.dy, 8, '打贴着我方大堆的一端');
  assert.ok(result.trapped >= 96, `应冻住整段宽纵队，实际 ${result.trapped}`);
});

test('三格宽脖子：policy 层同样落地截断', () => {
  const s = wideRaid();
  const action = chooseAction(s);
  const diag = getDecisionDiagnostics(s);
  assert.ok(action);
  assert.equal(diag?.branch, 'cutoff', `应走截断分支，实际 ${diag?.branch}`);
  assert.match(JSON.stringify(action.reason), /截断/);
});

// ── 场景三/四：涂色与建造的资源分配天平。
// 我方腹地有「够分档阈值的可建格」和「中立口袋涂色源」；敌方产能领先与否决定分支名。
function economyBoard({ enemyCrowns = 3 } = {}) {
  const n = 8, m = 12, at = (x, y) => x * m + y;
  const grid = Array(n * m).fill(0), army = Array(n * m).fill(0);
  for (let x = 0; x <= 5; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 2; }
  grid[at(1, 1)] = 101; army[at(1, 1)] = 500;                    // 我方皇冠（无防守缺口）
  grid[at(3, 3)] = 1; army[at(3, 3)] = 160;                      // 够建造触发线（前线档 150）的工地
  grid[at(3, 8)] = 0; army[at(3, 8)] = 0;                        // 腹地中立口袋
  grid[at(2, 8)] = 1; army[at(2, 8)] = 30;                       // 涂色源（advance 是纯涂色）
  for (let y = 0; y < m; y++) { grid[at(7, y)] = 2; army[at(7, y)] = 30; }
  const crownYs = enemyCrowns >= 3 ? [1, 5, 9] : [5];
  for (const y of crownYs) { grid[at(7, y)] = 102; army[at(7, y)] = 30; } // 敌方产能点
  return { n, m, turn: 500, playerId: 1, grid, army, isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('产能点落后时建造压过涂色（竞赛追赶做实）', () => {
  const s = economyBoard({ enemyCrowns: 3 });
  const action = chooseAction(s);
  const diag = getDecisionDiagnostics(s);
  assert.ok(action);
  assert.equal(action.kind, 'build', `敌 3 皇冠对我 1 皇冠时必须建造而非涂色，实际 ${diag?.branch}：${JSON.stringify(action)}`);
  assert.equal(diag?.branch, 'economy-emergency-build');
});

test('产能不落后时可负担的建造同样压过纯涂色', () => {
  const s = economyBoard({ enemyCrowns: 1 });
  const action = chooseAction(s);
  const diag = getDecisionDiagnostics(s);
  assert.ok(action);
  assert.equal(action.kind, 'build', `建造必须压过纯涂色，实际 ${diag?.branch}：${JSON.stringify(action)}`);
  assert.equal(diag?.branch, 'build-over-paint');
});

// ── 场景五：薄土涂色降权（turn 55， fortressPhase 未起，隔离评分路径）。
function paintBoard() {
  const n = 8, m = 12, at = (x, y) => x * m + y;
  const grid = Array(n * m).fill(0), army = Array(n * m).fill(0);
  for (let x = 0; x <= 5; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 2; }
  grid[at(1, 1)] = 101; army[at(1, 1)] = 500;
  grid[at(3, 8)] = 0; army[at(3, 8)] = 0;                        // 厚涂色目标
  grid[at(2, 8)] = 1; army[at(2, 8)] = 30;                       // 厚涂色源（arrive ≈29）
  grid[at(5, 6)] = 0; army[at(5, 6)] = 0;                        // 薄涂色目标
  grid[at(5, 5)] = 1; army[at(5, 5)] = 4;                        // 薄涂色源（arrive = 3 < paintThinArrive）
  grid[at(4, 6)] = 0; army[at(4, 6)] = 0;                        // 薄涂色目标周围无支援（隔离评分路径）
  grid[at(5, 7)] = 0; army[at(5, 7)] = 0;
  grid[at(7, 11)] = 102; army[at(7, 11)] = 30;                   // 远处敌皇冠（方向评分基准）
  return { n, m, turn: 55, playerId: 1, grid, army, isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('薄土涂色降权：厚涂色优先，薄涂色负分直接跳过', () => {
  const s = paintBoard();
  const front = createFrontline(s, {});
  const move = front.choose();
  assert.ok(move, '有厚涂色可选时必须有动作');
  assert.equal(move.dx * s.m + move.dy, 3 * s.m + 8, '必须选厚涂色而不是 1-2 兵薄涂色');
  // 厚涂色源拿走后只剩薄涂色：期望收益为负，choose() 宁可选 null 也不撒薄土。
  const s2 = paintBoard();
  s2.army[2 * s2.m + 8] = 1;
  const front2 = createFrontline(s2, {});
  assert.equal(front2.choose(), null, '1-2 兵守不住的边缘涂色不执行（槽位让给建造/集结/截断）');
});
