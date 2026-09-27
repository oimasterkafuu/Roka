'use strict';
// 用户 2026-09-27 硬方针的针对性测试：
//   一、推进方向纪律（不大范围涂色，方向权重向敌方皇冠/核心强倾斜）；
//   二、前线迁都（稳定前线格更积极地建造，位置判断不按出生点）；
//   三、建造阈值分级（大后方 100 / 前线 ~150 / 中间过渡 / 绝境回落 100）；
//   四、集兵树形化（一次性集满再造、最远子树先动逐级汇聚、深后方批量拉出）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrontline } = require('../bot/frontline.cjs');
const { architecture } = require('../bot/architecture.cjs');
const { chooseBuild } = require('../bot/building.cjs');
const { chooseLogistics } = require('../bot/logistics.cjs');

// 5x10：第 0-2 行己方腹地，第 3 行山墙，第 4 行敌人（与 building.test.cjs 同款）。
function home({ turn = 400 } = {}) {
  const n = 5, m = 10, size = n * m;
  const grid = Array(size).fill(201), army = Array(size).fill(0);
  for (let x = 0; x < 3; x++) for (let y = 0; y < m; y++) { grid[x * m + y] = 1; army[x * m + y] = 3; }
  for (let y = 0; y < m; y++) grid[4 * m + y] = 2;
  grid[0] = 101;
  army[0] = 40;
  return { n, m, turn, playerId: 1, grid, army, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const at = (x, y) => x * 10 + y;

// ── 一、推进方向纪律 ─────────────────────────────────────────────────────

// 3x7：己方皇冠 (1,0)、大堆 (1,1)；敌方皇冠 (1,6)。大堆面前有三个中立格：
// (1,2) 朝敌核心方向（守军 5，军事上略差），(0,1)/(2,1) 与进攻主线无关的侧翼。
function directionBoard() {
  const n = 3, m = 7, size = n * m;
  const grid = Array(size).fill(0), army = Array(size).fill(0);
  grid[1 * m + 0] = 101; army[1 * m + 0] = 20;
  grid[1 * m + 1] = 1; army[1 * m + 1] = 200;
  grid[1 * m + 6] = 102; army[1 * m + 6] = 30;
  army[1 * m + 2] = 5;
  return { n, m, turn: 100, playerId: 1, grid, army, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('方向纪律：朝敌核心方向推进优先于侧翼涂色', () => {
  const s = directionBoard();
  const move = createFrontline(s, {}).choose();
  assert.ok(move);
  assert.equal(move.dx, 1, `应朝敌皇冠方向推进，实际打 (${move.dx},${move.dy})`);
  assert.equal(move.dy, 2);
});

test('方向纪律：关掉方向权重后侧翼格凭微小的军事优势胜出（对照组）', () => {
  const s = directionBoard();
  const move = createFrontline(s, { pushDirectionWeight: 0, flankPaintPenalty: 0 }).choose();
  assert.ok(move);
  assert.equal(move.dy, 1, `无方向权重时侧翼格（军事略优）应胜出，实际打 (${move.dx},${move.dy})`);
  assert.notEqual(move.dx, 1);
});

test('方向纪律：中间地带侧翼涂色比贴近敌核心的侧翼降权更狠', () => {
  // 同一源点、同样与主线无关的两个侧翼中立格：距敌核心近的降权少、远的降权多。
  const { createContext } = require('../bot/threat.cjs');
  const s = directionBoard();
  const ctx = createContext(s, {});
  assert.ok(ctx.crownDistance[1 * 7 + 2] < ctx.crownDistance[0 * 7 + 1],
    '朝核心方向的格应比侧翼格离敌皇冠更近');
});

// ── 三、建造阈值分级（architecture 曲线 + chooseBuild 触发线）──────────────

test('阈值分档：山墙封闭的大后方阈值 100', () => {
  const s = home();
  assert.equal(architecture(s, {}).buildFund(at(1, 5)), 100);
});

test('阈值分档：中间地带按敌距连续过渡（100 与 150 之间）', () => {
  const n = 1, m = 20, size = n * m;
  const grid = Array(size).fill(1), army = Array(size).fill(3);
  grid[19] = 2;
  const s = { n, m, turn: 400, playerId: 1, grid, army, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const arch = architecture(s, {});
  assert.equal(arch.buildFund(0), 100, '敌距 19 ≥ buildRearDist：大后方');
  assert.equal(arch.buildFund(14), 150, '敌距 5 ≤ buildFrontDist：前线');
  const mid = arch.buildFund(9);
  assert.ok(mid > 100 && mid < 150, `敌距 10 应落在中间档，实际 ${mid}`);
});

test('阈值分档：位置判断不按出生点——出生点旁的格子被打穿后按前线评估', () => {
  const s = home();
  s.grid[3 * 10 + 5] = 1; s.army[3 * 10 + 5] = 10;   // 打开山墙
  s.army[4 * 10 + 5] = 5;                             // 弱敌两跳外
  const arch = architecture(s, {});
  assert.equal(arch.buildFund(at(2, 5)), 150, '敌距 2：出生点一侧也算前线，阈值 150');
  assert.equal(arch.frontStable(at(2, 5)), true, '威胁低且我方占优的前线格算「稳定」');
});

test('阈值分档：敌人打穿到腹地（绝境）回落大后方阈值 100', () => {
  const s = home();
  s.grid[3 * 10 + 5] = 1; s.army[3 * 10 + 5] = 10;
  s.army[4 * 10 + 5] = 600;                           // 两跳外压来 600 兵：没别的选择
  const arch = architecture(s, {});
  assert.equal(arch.buildFund(at(2, 5)), 100, '绝境按大后方阈值尽快建造');
  assert.equal(arch.frontStable(at(2, 5)), false, '威胁场极高的格子不算稳定');
});

test('阈值分档：前线位置 149 不建、150 才建', () => {
  const s = home();
  s.grid[3 * 10 + 5] = 1; s.army[3 * 10 + 5] = 10;
  s.army[4 * 10 + 5] = 5;
  s.army[at(2, 5)] = 149;
  assert.equal(chooseBuild(s, null, {}), null, '前线阈值 150：149 继续集');
  s.army[at(2, 5)] = 150;
  const build = chooseBuild(s, null, {});
  assert.ok(build, '集满 150 应开工');
  assert.equal(build.op, 'b');
  assert.deepEqual([build.x, build.y], [2, 5]);
});

test('阈值分档：绝境 120 就建；非绝境的重威胁位置 120 不建', () => {
  const desperate = home();
  desperate.grid[3 * 10 + 5] = 1; desperate.army[3 * 10 + 5] = 10;
  desperate.army[4 * 10 + 5] = 600;
  desperate.army[at(2, 5)] = 120;
  const build = chooseBuild(desperate, null, {});
  assert.ok(build, '绝境阈值回落 100，120 应开工');
  assert.deepEqual([build.x, build.y], [2, 5]);
  const pressed = home();
  pressed.grid[3 * 10 + 5] = 1; pressed.army[3 * 10 + 5] = 10;
  pressed.army[4 * 10 + 5] = 300;                     // 重威胁但未达绝境：阈值仍 150
  pressed.army[at(2, 5)] = 120;
  assert.equal(chooseBuild(pressed, null, {}), null, '重威胁前线 120 不够 150，继续集');
});

// ── 二、前线迁都（logistics 选址）+ 四、一次性集满再造 ─────────────────────

// 6x10：0-3 行己方腹地，第 4 行山墙，第 5 行敌人（与 logistics.test.cjs 同款）。
function field() {
  const n = 6, m = 10, size = n * m;
  const grid = Array(size).fill(201), army = Array(size).fill(0);
  for (let x = 0; x < 4; x++) for (let y = 0; y < m; y++) { grid[x * m + y] = 1; army[x * m + y] = 3; }
  for (let y = 0; y < m; y++) grid[5 * m + y] = 2;
  grid[0] = 101;
  army[0] = 30;
  return { n, m, turn: 400, playerId: 1, grid, army, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}

test('一次性集满再造：工地 99 兵继续筹资（目标 100），100 立即开工', () => {
  const s = field();
  s.army[at(2, 5)] = 99;
  s.army[at(1, 1)] = 40;
  const fund = chooseLogistics(s, null, null, { economyOnly: true });
  assert.ok(fund);
  assert.equal(fund.kind, 'attack', '99 兵不应开工，应继续筹资');
  assert.equal(fund.reason.code, 'economy-fund');
  assert.equal(fund.reason.target, at(2, 5));
  assert.equal(fund.reason.goal, 100, '大后方筹资目标 100（可连续建造两次）');
  s.army[at(2, 5)] = 100; s.turn++;
  const build = chooseLogistics(s, null, null, { economyOnly: true });
  assert.ok(build);
  assert.equal(build.kind, 'build', '集满 100 应立即开工');
});

test('前线迁都：稳定前线格压过大后方候选成为工地，筹资目标 150', () => {
  const s = field();
  s.grid[4 * 10 + 5] = 1; s.army[4 * 10 + 5] = 5;   // 山墙开一个前哨
  s.army[5 * 10 + 5] = 10;                           // 前哨对面只有弱敌：前线稳定
  const a = chooseLogistics(s, null, null, { economyOnly: true });
  assert.ok(a);
  assert.equal(a.reason.code, 'economy-fund');
  assert.equal(a.reason.target, at(3, 5), '稳定前线格应成为迁都工地');
  assert.equal(a.reason.goal, 150, '前线筹资目标 150（风险高留足余量）');
});

// ── 四、集兵树形化（汇聚顺序 + 深后方批量拉出）────────────────────────────

// 1x16 走廊：0-14 己方，15 敌人大堆。近源 (13) 小股、远源 (2)/(6) 大堆。
function corridor({ foeArmy = 2000 } = {}) {
  const n = 1, m = 16, size = n * m;
  const grid = Array(size).fill(1), army = Array(size).fill(3);
  grid[0] = 101; grid[15] = 2;
  army[0] = 60; army[2] = 500; army[6] = 200; army[13] = 30; army[14] = 1; army[15] = foeArmy;
  return { n, m, turn: 400, playerId: 1, grid, army, isolated: Array(size).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const supply = (s) => chooseLogistics(s, null, null, { militaryOnly: true });

test('树形集兵：大缺口时最远的子树先动，深后方大堆一次性批量拉出', () => {
  const s = corridor();
  const a = supply(s);
  assert.ok(a);
  assert.equal(a.reason.code, 'frontline-supply');
  assert.equal(a.y, 2, `应从最远的子树（d=12）先动，实际源点 y=${a.y}`);
  assert.equal(a.dy, 3);
  assert.ok(a.reason.amount >= 400, `深后方大堆应一次性批量拉出，实际出兵 ${a.reason.amount}`);
});

test('树形集兵：远端兵力逐级向目标汇聚（下一 tick 从更靠上的位置继续）', () => {
  const s = corridor();
  const first = supply(s);
  assert.equal(first.y, 2);
  // 模拟上一步移动落子：499 兵从 (2) 到 (3)
  s.army[2] = 1; s.army[3] += 499; s.turn++;
  const second = supply(s);
  assert.ok(second);
  assert.equal(second.y, 3, `汇聚应沿树逐级向上，实际源点 y=${second.y}`);
  assert.equal(second.dy, 4);
});

test('树形集兵：小缺口不兴师动众，近源直接收尾', () => {
  const s = corridor({ foeArmy: 40 });
  const a = supply(s);
  assert.ok(a);
  assert.equal(a.y, 13, `小缺口应由近源收尾，实际源点 y=${a.y}`);
  assert.equal(a.dy, 14);
});
