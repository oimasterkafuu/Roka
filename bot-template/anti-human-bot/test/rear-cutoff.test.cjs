'use strict';
// 身后下刀（2026-09-29 用户追加方针）回归测试：敌方单纯插入我方腹地（非跳板链）
// 时，优先从敌块「身后」（朝向其老家/主力的连通方向）下刀截断，让插入段孤死，
// 而不是迎头硬拼——
//   1. 入侵截断：两处都切得断时，切断点选在更靠敌老家一侧的脖子
//      （cutoffBehindBonus 加权压过 danger 的靠我家加分）；
//   2. policy 层：短促插入在推进（column 判迎头撞）但截断模块有后方切断点时，
//      迎头撞让位截断（该截还是要截，且从身后截）；
//   3. 无后方切断点时（插入段兵力太少、切了也冻不住 cutoffMinIsolate），
//      迎头撞分支保留、照常触发。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCutoff } = require('../bot/cutoff.cjs');
const { chooseAction, getDecisionDiagnostics } = require('../bot/policy.cjs');

// ── 场景一：插入段 (4,6)(5,6)(6,6) 经走廊 (7,6)(8,6)(9,6) 连回敌方主力（x≥10）。
// 两个脖子都贴着我方打击堆（(7,5)=50、(8,5)=50）都切得断：(7,6) 离我家近
// （danger 加分多 12），(8,6) 更靠敌老家一侧（身后刀，+cutoffBehindBonus）。
// (7,7)(7,8) 挖成中立：否则 (7,6) 满足 embedded 会进入入侵种子集合，而种子
// 格作脖子时 cutsOff 从种子队列穿过它泄漏（既有口径），近端脖子不会成为候选。
function insertionBoard() {
  const n = 12, m = 16, at = (x, y) => x * m + y;
  const grid = Array(n * m).fill(0), army = Array(n * m).fill(0);
  for (let x = 0; x <= 7; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 2; }
  grid[at(5, 2)] = 101; army[at(5, 2)] = 500;                     // 我方皇冠（离走廊近，danger 拉开差距）
  grid[at(7, 7)] = 0; army[at(7, 7)] = 0;                          // 挖空：让 (7,6) 不进入侵种子
  grid[at(7, 8)] = 0; army[at(7, 8)] = 0;
  for (let x = 10; x <= 11; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 2; army[at(x, y)] = 40; }
  grid[at(10, 14)] = 102; army[at(10, 14)] = 80;                   // 敌方皇冠
  for (const x of [4, 5, 6]) { grid[at(x, 6)] = 2; army[at(x, 6)] = 6; } // 插入段 18 兵
  grid[at(7, 6)] = 2; army[at(7, 6)] = 1;                          // 走廊近端脖子（离我家近）
  grid[at(8, 6)] = 2; army[at(8, 6)] = 1;                          // 走廊远端脖子（敌块身后）
  grid[at(9, 6)] = 2; army[at(9, 6)] = 1;                          // 走廊接敌方主力
  grid[at(7, 5)] = 1; army[at(7, 5)] = 50;                         // 贴着近端脖子的打击堆
  grid[at(8, 5)] = 1; army[at(8, 5)] = 50;                         // 贴着远端脖子的打击堆
  grid[at(8, 4)] = 1; army[at(8, 4)] = 2;                          // 远端打击堆的连通路径
  return { n, m, turn: 500, playerId: 1, grid, army, isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('插入型敌块：两处都切得断时选身后一侧的脖子（敌块与敌老家之间）', () => {
  const s = insertionBoard();
  const result = chooseCutoff(s);
  assert.ok(result, '插入段有脖子可截');
  assert.equal(result.move.dx, 8);
  assert.equal(result.move.dy, 6, '切断点选在更靠敌老家一侧的 (8,6)，让整段插入孤死');
  assert.match(result.move.reason, /截断入侵/);
  // 对照：关掉身后加权后，danger（离我家近）会让近端脖子 (7,6) 胜出——
  // 证明是 cutoffBehindBonus 把刀口压到敌块身后。
  const near = chooseCutoff(insertionBoard(), { cutoffBehindBonus: 0 });
  assert.ok(near);
  assert.equal(near.move.dx, 7);
  assert.equal(near.move.dy, 6, '无身后加权时退化为离我家最近的脖子（旧行为）');
});

// ── 场景二/三：9×9 短促插入（column 判短型 → 迎头撞），policy 层的让位与保留。
// 我方 x≤4（皇冠 (0,0)），敌方 x≥5（敌皇冠 (8,6)）。敌沿 y=6 插入：
// tick 61 插到 (4,6)(3,6)，tick 62 再进一格 (2,6)（深入块 3 格 < columnMinDepth，
// 判短促自耗型）。raidArmy 控制插入段兵力：60/40 时截断模块有后方切断点
// （脖子 (4,6)，冻住 100 兵）；3/3 时冻住量 < cutoffMinIsolate，无后方切断点。
function insertionColumnBoard({ penetrate = 2, turn = 61, raidArmy = [40, 60] } = {}) {
  const n = 9, m = 9, size = n * m, grid = Array(size).fill(0), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  for (let x = 0; x <= 4; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 10; }
  grid[at(0, 0)] = 101; army[at(0, 0)] = 30;
  for (let x = 5; x < n; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 2; army[at(x, y)] = 10; }
  grid[at(8, 6)] = 102; army[at(8, 6)] = 30;
  const snake = [[4, 30], [3, raidArmy[0]], [2, raidArmy[1]]];
  for (let k = 0; k < penetrate; k++) {
    const [x, a] = snake[k];
    grid[at(x, 6)] = 2; army[at(x, 6)] = a;
  }
  grid[at(3, 5)] = 1; army[at(3, 5)] = 200; // 我方大堆（集兵截断的兵源）
  return { n, m, turn, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'rear' };
}

test('policy：有后方切断点时迎头撞让位截断（从敌块身后下刀）', () => {
  const s = insertionColumnBoard({ penetrate: 2, turn: 61 });
  chooseAction(s); // 首次观测：column 记录头部距离
  const s2 = insertionColumnBoard({ penetrate: 3, turn: 62 });
  Object.assign(s, { grid: s2.grid, army: s2.army, turn: 62 });
  s.grid[2 * s.m + 5] = 1; s.army[2 * s.m + 5] = 200; // 贴着头部的主力，迎头撞本可行
  const a = chooseAction(s);
  const diag = getDecisionDiagnostics(s);
  assert.ok(a);
  assert.equal(diag?.branch, 'cutoff', `迎头撞必须让位后方截断，实际 ${diag?.branch}：${JSON.stringify(a.reason)}`);
  assert.match(a.reason, /截断/);
  assert.doesNotMatch(a.reason, /迎头撞/);
});

test('policy：无后方切断点时迎头撞分支保留（短促自耗型照常撞头部）', () => {
  const s = insertionColumnBoard({ penetrate: 2, turn: 61, raidArmy: [3, 3] });
  chooseAction(s); // 首次观测
  const s2 = insertionColumnBoard({ penetrate: 3, turn: 62, raidArmy: [3, 3] });
  Object.assign(s, { grid: s2.grid, army: s2.army, turn: 62 });
  s.grid[2 * s.m + 5] = 1; s.army[2 * s.m + 5] = 200;
  assert.equal(chooseCutoff(s), null, '插入段太小（冻住 6 兵 < cutoffMinIsolate），截断模块无方案');
  const a = chooseAction(s);
  const diag = getDecisionDiagnostics(s);
  assert.ok(a);
  assert.equal(diag?.branch, 'column-strike', `无后方切断点时应走迎头撞，实际 ${diag?.branch}：${JSON.stringify(a.reason)}`);
  assert.match(a.reason, /迎头撞敌短跳板/);
  assert.equal(a.dx, 2); assert.equal(a.dy, 6, '迎头撞头部格');
});
