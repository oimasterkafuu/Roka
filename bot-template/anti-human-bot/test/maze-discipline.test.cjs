'use strict';
// maze 拓展纪律 + 阶段化扩张-要塞方针（2026-09-27 用户硬方针/定稿）回归测试：
//   迷宫里拓展（打中立格）只派必要兵力（半兵优先，大部队留下镇关卡）；
//   源点是「移除后冻住 ≥cutoffMinIsolate 兵力」的关卡且贴脸有敌时不为拓展削弱它
//   （攻击对方土块不受此限——先打先守）；中后期无要塞撑腰的薄皮中立扩张被闸住
//   （够厚/有要塞撑腰/前期三种放行）；building 皇冠目标中后期按
//   lateTerritoryPerCrown 提速（E：净扩张速率 turn 60–75 坍缩、皇冠 75 起跳）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrontline } = require('../bot/frontline.cjs');
const { crownTarget } = require('../bot/building.cjs');
const { resolveParams } = require('../bot/params.cjs');

// 5×7 大部山体（占比 >0.3 判为迷宫）：皇冠 (0,3)，源点 (1,3) 400 兵，
// 中立拓展目标 (2,3) 30 兵。flat=true 时把山全换成空地作非迷宫对照。
function mazeBoard(flat = false) {
  const n = 5, m = 7, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(0, 3)] = 101; army[at(0, 3)] = 50;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 400;
  grid[at(2, 3)] = 0; army[at(2, 3)] = 30;
  if (flat) for (let i = 0; i < size; i++) if (grid[i] === 201) grid[i] = 0;
  return { n, m, turn: 40, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const expandMove = { x: 1, y: 3, dx: 2, dy: 3, mode: 0 };

test('maze 拓展纪律：迷宫里拓展只派必要兵力（半兵优先，主力留下镇关卡）', () => {
  const result = createFrontline(mazeBoard()).assess(expandMove);
  assert.ok(result);
  assert.equal(result.mode, 1, '迷宫走廊一旦被截断可能永久失联，拓展不抽空关卡');
});

test('非迷宫对照：同形空地棋盘维持全兵优先', () => {
  const result = createFrontline(mazeBoard(true)).assess(expandMove);
  assert.ok(result);
  assert.equal(result.mode, 2);
});

// 3×3 迷宫：皇冠 (0,1)，关卡源点 S=(1,1) 100 兵，关卡后方 (2,1) 500 兵
// （移除 S 即整段断锚），贴脸敌兵 (1,0) 20，中立拓展目标 (1,2) 5。
function chokeBoard() {
  const n = 3, m = 3, size = n * m, grid = Array(size).fill(201), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(0, 1)] = 101; army[at(0, 1)] = 40;
  grid[at(1, 1)] = 1; army[at(1, 1)] = 100;
  grid[at(2, 1)] = 1; army[at(2, 1)] = 500;
  grid[at(1, 0)] = 2; army[at(1, 0)] = 20;
  grid[at(1, 2)] = 0; army[at(1, 2)] = 5;
  return { n, m, turn: 40, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('maze 拓展纪律：源点关卡贴敌时不为拓展削弱咽喉（拓展前评估关卡安全性）', () => {
  const result = createFrontline(chokeBoard()).assess({ x: 1, y: 1, dx: 1, dy: 2, mode: 0 });
  assert.equal(result, null, '敌方一 tick 就能切断走廊时不拓——先打先守');
});

test('maze 拓展纪律：优先攻击对方土块不受关卡限制', () => {
  const result = createFrontline(chokeBoard()).assess({ x: 1, y: 1, dx: 1, dy: 0, mode: 0 });
  assert.ok(result, '贴脸敌兵照常打——先打先守的「先打」');
});

// 3×7 全空地：皇冠 (0,0)，远处源点 (1,3)，中立目标 (1,4) 8 兵。
// 源点不在任何己方建筑辐射圈内（fortressBacked=false）。
function lateBoard() {
  const n = 3, m = 7, size = n * m, grid = Array(size).fill(0), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  grid[at(0, 0)] = 101; army[at(0, 0)] = 40;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 15;
  grid[at(1, 4)] = 0; army[at(1, 4)] = 8;
  return { n, m, turn: 600, grid, army, playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const lateMove = { x: 1, y: 3, dx: 1, dy: 4, mode: 0 };

test('阶段化方针：中后期无要塞撑腰的薄皮中立扩张被闸住', () => {
  // 15 兵打 8 兵：占领后只留 6 兵（<lateSkinMin 10），这一 tick 不拓。
  assert.equal(createFrontline(lateBoard()).assess(lateMove), null);
});

test('阶段化方针：中后期自己够厚（占领后驻军 ≥lateSkinMin）照常扩张', () => {
  const s = lateBoard();
  s.army[1 * 7 + 3] = 25; // 占领后留 16 兵
  assert.ok(createFrontline(s).assess(lateMove));
});

test('阶段化方针：有要塞撑腰（源点在己方建筑辐射圈内）薄皮也放行', () => {
  const s = lateBoard();
  s.grid[1 * 7 + 2] = 51; s.army[1 * 7 + 2] = 40; // 源点隔壁落指挥所
  assert.ok(createFrontline(s).assess(lateMove));
});

test('阶段化方针：前期（turn <fortressPhaseTurn）薄皮扩张不挡——抢地盘积累', () => {
  const s = lateBoard();
  s.turn = 50;
  assert.ok(createFrontline(s).assess(lateMove));
});

test('阶段化方针：中后期皇冠目标按 lateTerritoryPerCrown 提速', () => {
  const n = 8, m = 8, size = n * m;
  const s = { n, m, turn: 400, grid: Array(size).fill(1), army: Array(size).fill(10),
    playerId: 1, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const p = resolveParams({});
  // land=64：前期基线 1+floor(64/18)=4；后期 min(floor(64/9),12)=7。
  assert.equal(crownTarget(64, 400, p, s), 7, '后期转向大量建要塞');
  assert.equal(crownTarget(64, 50, p, s), 4, '前期维持扩张期基线');
});
