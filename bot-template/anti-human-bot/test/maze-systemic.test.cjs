'use strict';
// issue #70 maze 系统性弱点修复（2026-09-30，证据 /root/antihuman-review.md）回归测试：
//   1. defense：mazeLike 时反应窗按走廊连通距离放宽（mazeDefenseHorizon/mazeRallyWindow），
//      敌大堆在 12 跳外的走廊尽头贴境也能触发应对（场 1：125–191 兵堆停 16 tick 零应对）；
//   2. cutoff：敌堆进入割点走廊 mazeNeckWarnRange 跳内即预警驻防（场 1 割点 (1,5) 被
//      一刀切断、约 150 兵集群断链蒸发），且割点受威胁时主动夺取备用连通格
//      （场 1 的中立沼泽 (5,7) 全程无人打通）；
//   3. frontline：咽喉留守保护从 neutral 拓展推广到 enemy/city 推进（场 2 前哨皇冠
//      (7,7) 被自己的攻击从 83 抽干到 22），mazeLike 时放宽 lateAnchorRadius/lateSkinMin
//      解除中后期扩张冻结（场 2 t110 起土地恒定 26–34）；
//   4. campaign：mazeLike 时走廊出现 1 格脖子即无条件优先落锚（含大堆脚下），
//      修复长补给线零锚点（场 2 北伐 t99–113 被一锅端）；
//   5. building：mazeLike 时 clusterValue 惩罚皇冠贴邻（场 2 四冠成排贴前线连锁全丢）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseDefense } = require('../bot/defense.cjs');
const { chooseNeckGuard } = require('../bot/cutoff.cjs');
const { createFrontline } = require('../bot/frontline.cjs');
const { chooseCampaign } = require('../bot/campaign.cjs');
const { clusterValue } = require('../bot/building.cjs');

// ── 1. defense 反应窗 ────────────────────────────────────────────────────
// 13×14 全山，只有 x=6 一条 14 格直走廊：皇冠 (6,0)，前哨 (6,12) 30 兵，
// 敌 200 兵堆 (6,13) 贴前哨——距皇冠 13 跳，超出旧 HORIZON=12；战斗推演里
// 敌堆打穿前哨后 13 tick 才到皇冠，超出旧 rallyWindow，旧实现全程零应对。
// 走廊中段 (6,6) 有 100 兵可预置增援。
function corridorBoard(flat = false) {
  const n = 13, m = 14, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(6, 0)] = 101; army[at(6, 0)] = 50;
  for (let y = 1; y <= 11; y++) { grid[at(6, y)] = 1; army[at(6, y)] = 1; }
  grid[at(6, 6)] = 1; army[at(6, 6)] = 100;
  grid[at(6, 12)] = 1; army[at(6, 12)] = 30;
  grid[at(6, 13)] = 2; army[at(6, 13)] = 200;
  if (flat) for (let i = 0; i < size; i++) if (grid[i] === 201) grid[i] = 0;
  return { n, m, turn: 500, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('maze 反应窗：13 跳走廊尽头的贴境敌堆触发应对', () => {
  const result = chooseDefense(corridorBoard());
  assert.ok(result, 'mazeLike 时走廊连通距离超 12 跳也不能装作看不见');
});

test('maze 反应窗：非迷宫对照维持 12 跳窗口（远处敌堆不反应）', () => {
  assert.equal(chooseDefense(corridorBoard(true)), null);
});

// ── 2. cutoff 割点预警与备用连通格 ──────────────────────────────────────
// 3×7 全山，x=1 走廊：皇冠 (1,0)，脖子 (1,2) 5 兵，后方 (1,1) 30 兵，
// 将断锚段 (1,3) 40 兵，敌 60 兵堆 (1,4) 距脖子 2 跳（本 tick 打不到脖子）。
function warnBoard(flat = false) {
  const n = 3, m = 7, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(1, 0)] = 101; army[at(1, 0)] = 50;
  grid[at(1, 1)] = 1; army[at(1, 1)] = 30;
  grid[at(1, 2)] = 1; army[at(1, 2)] = 5;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 40;
  grid[at(1, 4)] = 2; army[at(1, 4)] = 60;
  if (flat) for (let i = 0; i < size; i++) if (grid[i] === 201) grid[i] = 0;
  return { n, m, turn: 500, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('maze 割点预警：敌堆进入割点走廊 N 跳内提前驻防', () => {
  const result = chooseNeckGuard(warnBoard());
  assert.ok(result, '敌堆逼近割点走廊就该预置防线，不等本 tick 可切断');
  assert.match(result.move.reason, /预警/);
});

test('maze 割点预警：非迷宫对照维持当拍触发', () => {
  assert.equal(chooseNeckGuard(warnBoard(true)), null);
});

// 3×5：皇冠 (0,1)—(1,1)—脖子 (1,2)—将断锚段 (2,2)，中立格 (2,1) 同时贴两侧，
// 敌 30 兵 (1,3) 贴脖子（本 tick 就能切断）。夺下 (2,1) 即修好备用桥。
function bridgeBoard() {
  const n = 3, m = 5, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(0, 1)] = 101; army[at(0, 1)] = 50;
  grid[at(1, 1)] = 1; army[at(1, 1)] = 5;
  grid[at(1, 2)] = 1; army[at(1, 2)] = 10;
  grid[at(2, 2)] = 1; army[at(2, 2)] = 60;
  grid[at(2, 1)] = 0; army[at(2, 1)] = 3;
  grid[at(1, 3)] = 2; army[at(1, 3)] = 30;
  return { n, m, turn: 500, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('割点受威胁时主动夺取备用连通格', () => {
  const result = chooseNeckGuard(bridgeBoard());
  assert.ok(result, '必须识别割点威胁');
  assert.equal(result.move.dx, 2);
  assert.equal(result.move.dy, 1);
  assert.match(result.move.reason, /备用连通/);
});

// ── 3. frontline 咽喉留守推广 + 后期扩张解冻 ────────────────────────────
// 4×3：皇冠 (0,1)，关卡源点 S=(1,1) 150 兵，身后 (2,1) 500 兵（移除 S 即断锚），
// 敌格目标 (1,0) 60 兵，敌 150 兵堆 (3,1) 距 S 2 跳（不贴脸但在预警圈内）。
function pushChokeBoard(flat = false) {
  const n = 4, m = 3, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(0, 1)] = 101; army[at(0, 1)] = 40;
  grid[at(1, 1)] = 1; army[at(1, 1)] = 150;
  grid[at(2, 1)] = 1; army[at(2, 1)] = 500;
  grid[at(1, 0)] = 2; army[at(1, 0)] = 60;
  grid[at(3, 1)] = 2; army[at(3, 1)] = 150;
  if (flat) for (let i = 0; i < size; i++) if (grid[i] === 201) grid[i] = 0;
  return { n, m, turn: 40, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const pushMove = { x: 1, y: 1, dx: 1, dy: 0, mode: 0 };

test('maze 咽喉留守推广：逼近敌堆压过出兵量时，关卡不为敌格推进抽干', () => {
  const result = createFrontline(pushChokeBoard()).assess(pushMove);
  assert.equal(result, null, '敌堆 2 跳即达且压得过留守——这一 tick 留守，不推进');
});

test('maze 咽喉留守推广：非迷宫对照照常推进', () => {
  assert.ok(createFrontline(pushChokeBoard(true)).assess(pushMove));
});

// 4×3 迷宫：皇冠 (0,1) — (1,1) — (2,1) — 源点 (3,1) 8 兵，中立目标 (3,0) 2 兵。
// 源点距建筑 3 跳：旧 lateAnchorRadius=2 罩不住（扩张冻结），maze 放宽到 4 放行。
function lateMazeBoard(flat = false) {
  const n = 4, m = 3, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(0, 1)] = 101; army[at(0, 1)] = 40;
  grid[at(1, 1)] = 1; army[at(1, 1)] = 5;
  grid[at(2, 1)] = 1; army[at(2, 1)] = 5;
  grid[at(3, 1)] = 1; army[at(3, 1)] = 8;
  grid[at(3, 0)] = 0; army[at(3, 0)] = 2;
  if (flat) for (let i = 0; i < size; i++) if (grid[i] === 201) grid[i] = 0;
  return { n, m, turn: 600, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const lateMazeMove = { x: 3, y: 1, dx: 3, dy: 0, mode: 0 };

test('maze 后期扩张解冻：放宽锚点半径后薄皮中立扩张放行', () => {
  assert.ok(createFrontline(lateMazeBoard()).assess(lateMazeMove));
});

test('maze 后期扩张解冻：非迷宫对照维持原门槛（仍被闸住）', () => {
  assert.equal(createFrontline(lateMazeBoard(true)).assess(lateMazeMove), null);
});

// ── 4. campaign 锚点链 ──────────────────────────────────────────────────
// 3×10 全山，x=1 走廊：皇冠 (1,0)，大堆 rally (1,5) 200 兵（anchorDist 5），
// 敌皇冠 (1,9)。走廊有 1 格脖子（移除 (1,4) 即冻住大堆）。
function anchorBoard(flat = false) {
  const n = 3, m = 10, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(1, 0)] = 101; army[at(1, 0)] = 100;
  for (let y = 1; y <= 4; y++) { grid[at(1, y)] = 1; army[at(1, y)] = 1; }
  grid[at(1, 5)] = 1; army[at(1, 5)] = 200;
  grid[at(1, 6)] = 2; army[at(1, 6)] = 1;
  grid[at(1, 7)] = 2; army[at(1, 7)] = 1;
  grid[at(1, 8)] = 2; army[at(1, 8)] = 1;
  grid[at(1, 9)] = 102; army[at(1, 9)] = 30;
  if (flat) for (let i = 0; i < size; i++) if (grid[i] === 201) grid[i] = 0;
  return { n, m, turn: 51, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('maze 锚点链：走廊 1 格脖子即无条件优先落锚（含大堆脚下）', () => {
  const result = chooseCampaign(anchorBoard(), {}, { targetOwner: 2 });
  assert.ok(result, '军力占优的深入推进必须给出动作');
  assert.equal(result.kind, 'build', 'maze 深入走廊零锚点是致命形态，先落锚再推进');
  assert.equal(result.x, 1);
  assert.equal(result.y, 5, '锚点直接落在大堆脚下');
});

test('maze 锚点链：非迷宫对照不强行在大堆脚下建站', () => {
  const result = chooseCampaign(anchorBoard(true), {}, { targetOwner: 2 });
  assert.ok(result);
  assert.notEqual(result.kind, 'build');
});

// ── 5. building 皇冠布局 ────────────────────────────────────────────────
test('maze 皇冠布局：clusterValue 由奖励贴邻改为惩罚贴邻', () => {
  const n = 5, m = 5, size = n * m, grid = Array(size).fill(1), army = Array(size).fill(10);
  const at = (x, y) => x * m + y;
  grid[at(2, 1)] = 101;
  grid[at(2, 4)] = 101;
  const state = { n, m, grid, army, playerId: 1 };
  const i = at(2, 2); // 距两座皇冠 1 跳/2 跳
  assert.ok(clusterValue(state, i) > 0, '非迷宫维持贴邻奖励');
  assert.ok(clusterValue(state, i, true) < 0, 'mazeLike 惩罚贴邻、奖励分散守咽喉');
});
