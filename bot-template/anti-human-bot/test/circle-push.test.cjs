'use strict';
// 画圈推进 + 锚点链（2026-09-27，学自 _E_ 锋面量化）回归测试：
//   campaign 窄突出部侧向扫一格涂宽锋面 / 锋面已是宽块时正常前压 /
//   锚点链节奏 tick 落指挥所 / 非节奏 tick 不建（大堆脚下受节奏限制）/
//   走廊有截断风险时锚点抢节奏（非 rally 候选）/ 终段（距皇冠 ≤2）不建 /
//   policy 层锚点建造压过普通推进（背水/截断/脖子仍优先）。
// E 的量化：推进窗口内指挥所建造间隔中位 4 tick、建造点距大堆/路径中位 2 格。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCampaign } = require('../bot/campaign.cjs');
const { chooseAction } = require('../bot/policy.cjs');

// 7×7：我方第 0 行 + 皇冠 (0,3)，走廊 (1,3)，大堆 rally (2,3)；敌营 2，敌皇冠 (6,3)。
// 山 (3,2)(4,2)(5,2)(3,3)(4,3)(5,3) 把路径挤到第 4 列：path[0]=(2,4)，
// rally 的唯一己方邻格是身后走廊 (1,3)——窄突出部，触发画圈侧扫。
function sweepBoard() {
  const n = 7, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 15;
  grid[at(2, 3)] = 1; army[at(2, 3)] = 3000;
  for (const [x, y] of [[3, 2], [4, 2], [5, 2], [3, 3], [4, 3], [5, 3]]) { grid[at(x, y)] = 201; army[at(x, y)] = 0; }
  grid[at(6, 3)] = 102; army[at(6, 3)] = 5;
  return { n, m, turn: 60, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'circle' };
}

test('画圈推进：窄突出部大堆先侧向扫一格，锋面涂成连通宽块', () => {
  const a = chooseCampaign(sweepBoard(), {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.mode, 2, '画圈仍是大堆全冲的一部分');
  assert.match(a.reason.detail, /画圈推进/);
  assert.equal(a.x, 2); assert.equal(a.y, 3);
  assert.equal(a.dx, 2); assert.equal(a.dy, 2, '侧扫到与锋面平齐的侧翼格，不是直奔 path[0]');
});

test('锋面已是宽块（rally 另有己方邻格）时不侧扫，正常沿路径前压', () => {
  const s = sweepBoard();
  s.grid[2 * 7 + 2] = 1; s.army[2 * 7 + 2] = 15; // (2,2) 变我方格：锋面已经两格宽
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.dx, 2); assert.equal(a.dy, 4, '沿路径压向皇冠');
  assert.match(a.reason.detail, /浓缩突击/);
});

// 7×7 直走廊：我方第 0 行 + 皇冠 (0,3)，走廊 (1,3)=15/(2,3)=15/(3,3)=3000，
// 敌皇冠 (crownX,3)。anchorDist[rally]=3 达到 anchorChainGap，走廊上只有 rally
// 攒够了 51 兵——节奏 tick 在大堆脚下落指挥所。
function corridorBoard(crownX = 6) {
  const n = 7, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 15;
  grid[at(2, 3)] = 1; army[at(2, 3)] = 15;
  grid[at(3, 3)] = 1; army[at(3, 3)] = 3000;
  grid[at(crownX, 3)] = 102; army[at(crownX, 3)] = 5;
  return { n, m, turn: 60, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'anchor' };
}

test('锚点链：节奏 tick（turn%4==0）在推进走廊落指挥所保连通', () => {
  const a = chooseCampaign(corridorBoard(6), {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3, 'E 近半数建造直接落在大堆脚下');
  assert.equal(a.reason.phase, 'anchor');
});

test('锚点链：非节奏 tick 不建（大堆脚下建造受节奏限制，推进不被拖死）', () => {
  const s = corridorBoard(6);
  s.turn = 61; // 61%4!=0；走廊唯一够兵的候选就是 rally，risky 也不抢节奏
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.notEqual(a.kind, 'build');
  assert.equal(a.reason.phase, 'advance');
});

test('锚点链：终段（rally 距皇冠 ≤2）不落锚点，直接压皇冠', () => {
  const a = chooseCampaign(corridorBoard(5), {}, { targetOwner: 2 });
  assert.ok(a);
  assert.notEqual(a.kind, 'build');
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.dx, 4); assert.equal(a.dy, 3);
});

test('锚点链：走廊有截断风险时，非 rally 候选抢先落锚（不受节奏限制）', () => {
  // 8×7：我方第 0 行 + 皇冠 (0,3)，走廊 (1,3)=15/(2,3)=15/(3,3)=60，
  // rally (4,3) 是我方沼泽（不能建站），大堆 3000。移除 (3,3) 会让沼泽大堆
  // 整段断锚（cutoff 共享判定）且走廊贴敌——risky，(3,3) 不是 rally，抢节奏落锚。
  const n = 8, m = 7, size = n * m, grid = Array(size).fill(2), army = Array(size).fill(2);
  const at = (x, y) => x * m + y;
  for (let y = 0; y < m; y++) { grid[at(0, y)] = 1; army[at(0, y)] = 15; }
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  grid[at(1, 3)] = 1; army[at(1, 3)] = 15;
  grid[at(2, 3)] = 1; army[at(2, 3)] = 15;
  grid[at(3, 3)] = 1; army[at(3, 3)] = 60;
  grid[at(4, 3)] = 151; army[at(4, 3)] = 3000; // 我方沼泽：大堆脚下不能建站
  grid[at(7, 3)] = 102; army[at(7, 3)] = 5;
  const s = { n, m, turn: 61, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'anchor-risk' };
  const a = chooseCampaign(s, {}, { targetOwner: 2 });
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3, '截断风险下锚点落在走廊上够兵的非 rally 格');
  assert.equal(a.reason.phase, 'anchor');
  assert.equal(a.reason.risky, true);
});

test('policy 调度：锚点建造压过普通推进，背水/截断/脖子纪律不抢先', () => {
  const a = chooseAction(corridorBoard(6)); // turn 60 节奏 tick
  assert.ok(a);
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.x, 3); assert.equal(a.y, 3);
});
