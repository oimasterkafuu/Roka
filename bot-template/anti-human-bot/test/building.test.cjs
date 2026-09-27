'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseBuild, crownTarget, urgent } = require('../bot/building.cjs');

// 5x10：第 0-2 行是安全腹地，第 3 行是山墙，第 4 行是敌人。
function home({ mine = 1, foe = 2, foeCrowns = 1, turn = 400 } = {}) {
  const n = 5, m = 10, size = n * m;
  const grid = Array(size).fill(201), army = Array(size).fill(0);
  for (let x = 0; x < 3; x++) for (let y = 0; y < m; y++) grid[x * m + y] = mine;
  for (let y = 0; y < m; y++) grid[4 * m + y] = foe;
  grid[0] = mine + 100;
  for (let k = 0; k < foeCrowns; k++) grid[4 * m + k] = foe + 100;
  for (let x = 0; x < 3; x++) for (let y = 0; y < m; y++) army[x * m + y] = 3;
  army[0] = 40;
  return { n, m, turn, playerId: mine, grid, army, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const at = (x, y) => x * 10 + y;
const land = (state) => state.grid.filter((v) => v > 0 && v < 200 && v % 50 === state.playerId).length;

test('安全腹地集满建造资金（分档阈值 100）就建指挥所', () => {
  const s = home();
  s.army[at(1, 5)] = 99;
  assert.equal(chooseBuild(s, null, {}), null, '大后方阈值 100：99 兵继续集，不零敲碎打');
  s.army[at(1, 5)] = 100;
  const build = chooseBuild(s, null, {});
  assert.ok(build, '100 兵已集满，应开工');
  assert.equal(build.op, 'b');
  assert.deepEqual([build.x, build.y], [1, 5]);
});

test('资金不足（不满50兵）绝不建造', () => {
  const s = home();
  s.army[at(1, 5)] = 49;
  assert.equal(chooseBuild(s, null, {}), null);
});

test('已有未升级指挥所时不开第二个工地', () => {
  const s = home();
  s.grid[at(1, 5)] = s.playerId + 50;
  s.army[at(1, 5)] = 20;
  s.army[at(1, 6)] = 120;
  assert.equal(chooseBuild(s, null, {}), null);
});

test('升级现有指挥所优先于新建', () => {
  const s = home();
  s.grid[at(1, 5)] = s.playerId + 50;
  s.army[at(1, 5)] = 120;
  s.army[at(1, 6)] = 120;
  const build = chooseBuild(s, null, {});
  assert.ok(build);
  assert.equal(build.op, 'c');
  assert.deepEqual([build.x, build.y], [1, 5]);
});

test('建造竞赛落后时允许并行开第二个工地（阈值仍按位置分档）', () => {
  const s = home({ foeCrowns: 4 });
  s.army[at(1, 5)] = 110;             // 位置分档阈值 100 已集满
  s.grid[at(1, 6)] = s.playerId + 50; // 已有工地
  s.army[at(1, 6)] = 20;
  const build = chooseBuild(s, null, {});
  assert.ok(build, '落后时应继续追赶而不是停建');
  assert.equal(build.op, 'b');
});

test('建造竞赛落后时皇冠目标至少追到对手+1', () => {
  const s = home({ foeCrowns: 5 });
  const target = crownTarget(land(s), s.turn, { territoryPerCrown: 18 }, s);
  assert.ok(target >= 6, `目标应追到 6，实际 ${target}`);
});

test('普通防守动作会挡住建造，但经济落后时不再让行', () => {
  const defenseMove = { x: 0, y: 1, dx: 0, dy: 2, mode: 0, reason: '守主城' };
  const normal = home();
  normal.army[at(1, 5)] = 120;
  assert.ok(urgent(normal, defenseMove));
  assert.equal(chooseBuild(normal, defenseMove, {}), null);
  const behind = home({ foeCrowns: 4 });
  behind.army[at(1, 5)] = 120;
  assert.ok(chooseBuild(behind, defenseMove, {}), '落后时仍要继续建造');
});

test('贴着重兵的格子会让位给后方工地', () => {
  const s = home();
  s.grid[3 * 10 + 5] = s.playerId; // 打开山墙，制造贴敌格
  s.army[3 * 10 + 5] = 200;
  s.grid[4 * 10 + 5] = 2;          // 正对门口的敌堆
  s.army[4 * 10 + 5] = 200;
  s.army[at(1, 5)] = 160;          // 后方资金（墙开后敌距 3 格，分档阈值 150）
  const build = chooseBuild(s, null, {});
  assert.ok(build, '后方应有工地');
  assert.ok(build.x < 3, `应选后方而不是门口，实际 (${build.x},${build.y})`);
});

// ── 建造阈值分级（用户 2026-09-27 硬方针）：一次性集满再造，按位置分档 ──────

test('兵力51不再立即建造：一次性集满约100再开工', () => {
  const s = home();
  s.army[at(1, 5)] = 51;
  assert.equal(chooseBuild(s, null, {}), null, '51 只够开工一次，继续集到 100');
});

test('兵力52不等增援但也不开工：集满100即建，不多等一兵', () => {
  const s = home();
  s.army[at(1, 5)] = 52;
  assert.equal(chooseBuild(s, null, {}), null, '52 仍在大后方阈值 100 之下');
  s.army[at(1, 5)] = 100;
  s.army[at(1, 6)] = 30; // 附近有可调的增援，但不应该等它到位
  const build = chooseBuild(s, null, {});
  assert.ok(build, '集满 100 应立即开工（100 兵可连续建造两次）');
  assert.equal(build.op, 'b');
});

test('指挥所兵力恰好101立即升级主城', () => {
  const s = home();
  s.grid[at(1, 5)] = s.playerId + 50;
  s.army[at(1, 5)] = 101;
  const build = chooseBuild(s, null, {});
  assert.ok(build, '101 兵已满足升级门槛');
  assert.equal(build.op, 'c');
  assert.deepEqual([build.x, build.y], [1, 5]);
});

test('50兵不建：花完50至少留1兵（引擎硬门槛50，0兵建筑下tick白送）', () => {
  const s = home();
  s.army[at(1, 5)] = 50;
  assert.equal(chooseBuild(s, null, {}), null);
});

test('贴脸敌军能立即反超时不建（防守检查，不是经济余量）', () => {
  const s = home();
  s.grid[3 * 10 + 5] = s.playerId; // 打开山墙
  s.army[3 * 10 + 5] = 60;         // 门口 60 兵：建完只剩 10
  s.grid[4 * 10 + 5] = 2;
  s.army[4 * 10 + 5] = 50;         // 贴脸敌 50 兵能立刻夺回
  s.army[at(1, 5)] = 150;          // 后方格集满分档资金（墙开后敌距 3，阈值 150）
  const build = chooseBuild(s, null, {});
  assert.ok(build, '后方安全格应建');
  assert.ok(build.x < 3, `应选后方安全格，实际 (${build.x},${build.y})`);
});
