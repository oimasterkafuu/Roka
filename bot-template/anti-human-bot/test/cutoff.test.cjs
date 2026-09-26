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

test('普通边境接触不是入侵，不触发截断', () => {
  const s = raid();
  for (const y of [3, 4, 5]) { s.grid[at(3, y)] = 1; s.army[at(3, y)] = 1; }
  for (let y = 1; y <= 7; y++) { s.grid[at(2, y)] = 2; s.army[at(2, y)] = 40; }
  for (let y = 1; y <= 7; y++) { s.grid[at(3, y)] = 2; s.army[at(3, y)] = 30; }
  s.army[at(4, 3)] = 500; s.army[at(4, 5)] = 500;
  assert.equal(chooseCutoff(s), null);
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
