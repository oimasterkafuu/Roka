'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFFA, acceptFFAAction } = require('../bot/ffa.cjs');
function board(extra = {}) {
  return { n: 3, m: 3, playerId: 1, turn: 5,
    grid: [102, 2, 103, 1, 101, 3, 104, 4, 1], army: [5, 2, 5, 20, 30, 2, 5, 2, 20],
    isolated: Array(9).fill(0), fog: Array(9).fill(0), teams: new Map(), ...extra };
}
const move = (s, t, m = 3) => ({ kind: 'attack', x: Math.floor(s / m), y: s % m, dx: Math.floor(t / m), dy: t % m, mode: 0 });
test('四人同时敌对只选一个主动目标，不篡改棋盘和队伍', () => {
  const s = board(), before = structuredClone(s), a = analyzeFFA(s);
  assert.equal(a.allowedOwners.size, 1); assert.ok([2, 3, 4].includes(a.targetOwner));
  assert.deepEqual(s, before); assert.equal(a.defensiveOwners.size, 0);
});
test('真实owner与皇冠编码支持49号', () => {
  const s = board({ playerId: 49 }); s.grid[4] = 149; s.grid[3] = s.grid[8] = 49;
  const a = analyzeFFA(s); assert.ok(a.targetOwner); assert.equal(a.allowedOwners.has(49), false);
});
test('同队敌人合并成一个目标阵营', () => {
  const s = board({ teams: new Map([[2, 7], [3, 7]]) });
  const a = analyzeFFA(s);
  if (a.targetOwner === 4) assert.deepEqual([...a.allowedOwners], [4]);
  else { assert.ok(a.allowedOwners.has(2)); assert.ok(a.allowedOwners.has(3)); }
});
test('纯队友允许支援且不是威胁', () => {
  const s = board({ teams: new Map([[1, 9], [3, 9]]) }); s.army[5] = 200;
  const a = analyzeFFA(s); assert.equal(a.defensiveOwners.has(3), false);
  assert.ok(acceptFFAAction(s, move(4, 5), a));
});
test('两个阵营不施加主动限制和紧急覆盖', () => {
  const s = board({ teams: new Map([[2, 7], [3, 7], [4, 7]]) }); s.army[5] = 100;
  const a = analyzeFFA(s); assert.equal(a.targetOwner, null); assert.equal(a.emergencyMove, null);
  for (const t of [1, 5, 7]) assert.ok(acceptFFAAction(s, move(4, t), a));
});
test('目标锁定60tick内不因兵力评分微变切换', () => {
  const s = board(), first = analyzeFFA(s).targetOwner;
  s.turn = 35; s.army[0] = 15; s.army[2] = 20; s.army[6] = 10;
  assert.equal(analyzeFFA(s).targetOwner, first);
});
test('leaderboard dead排除残留领地，目标消失切换', () => {
  const s = board(), first = analyzeFFA(s).targetOwner;
  s.turn++; s.leaderboard = [1, 2, 3, 4].map(id => ({ id, dead: id === first ? 1 : 0 }));
  const a = analyzeFFA(s); assert.notEqual(a.targetOwner, first); assert.equal(a.allowedOwners.has(first), false);
});
test('无排行榜时目标失去全部领地会切换', () => {
  const s = board(), first = analyzeFFA(s).targetOwner;
  s.grid = s.grid.map(v => v % 50 === first ? 0 : v); s.turn++;
  assert.notEqual(analyzeFFA(s).targetOwner, first);
});
test('真实夺地建立侵略记忆并允许第三方防御', () => {
  const s = board(), initial = analyzeFFA(s), p = [2, 3, 4].find(p => p !== initial.targetOwner);
  s.grid[3] = p; s.army[3] = 1; s.turn++;
  const a = analyzeFFA(s); assert.ok(a.defensiveOwners.has(p));
  assert.ok(acceptFFAAction(s, move(4, 3), a));
  s.turn++; assert.ok(analyzeFFA(s).defensiveOwners.has(p));
});
test('侵略记忆过期，不永久将所有人当威胁', () => {
  const s = board(); analyzeFFA(s); s.grid[3] = 3; s.army[3] = 1; s.turn++;
  assert.ok(analyzeFFA(s).defensiveOwners.has(3)); s.turn += 41;
  assert.equal(analyzeFFA(s).defensiveOwners.has(3), false);
});
test('强皇冠入侵可打破锁定', () => {
  const s = board(), first = analyzeFFA(s).targetOwner, p = first === 3 ? 4 : 3;
  const i = p === 3 ? 5 : 7; s.army[i] = 100; s.turn++;
  const a = analyzeFFA(s); assert.equal(a.targetOwner, p); assert.ok(a.defensiveOwners.has(p));
});
test('路过弱兵和同攻击兵力不登记威胁', () => {
  const s = board(); s.army[5] = 32; // next tick皇冠31，敌可出31。
  const a = analyzeFFA(s); assert.equal(a.defensiveOwners.has(3), false); assert.equal(a.emergencyMove, null);
});
test('孤立敌军不能作为主动进攻威胁', () => {
  const s = board(); s.army[5] = 200; s.isolated[5] = 1;
  assert.equal(analyzeFFA(s).defensiveOwners.has(3), false);
});
function defense(extra = {}) {
  return board({ n: 2, m: 4, grid: [201, 3, 201, 102, 1, 101, 201, 104],
    army: [0, 40, 0, 1, 30, 20, 0, 1], isolated: Array(8).fill(0), fog: Array(8).fill(0), ...extra });
}
test('有意义自有地回防汇兵，不硬送主城', () => {
  const s = defense(), a = analyzeFFA(s);
  assert.deepEqual(a.emergencyMove, { ...move(4, 5, 4), half: false, reason: 'FFA紧急自有地汇兵防守' });
  assert.ok(acceptFFAAction(s, a.emergencyMove, a));
});
test('无法守住返回null，不送同兵或弱兵进攻', () => {
  const s = defense(); s.army[4] = 5;
  assert.equal(analyzeFFA(s).emergencyMove, null);
});
test('孤立自有地不能调兵', () => {
  const s = defense(); s.isolated[4] = 1; assert.equal(analyzeFFA(s).emergencyMove, null);
});
test('mode0为其他方向精确留守，不按全冲算援兵', () => {
  const s = defense(); s.grid[0] = 4; s.army[0] = 25;
  assert.equal(analyzeFFA(s).emergencyMove, null);
});
test('不从另一受威胁皇冠放空兵力', () => {
  const s = defense(); s.grid[4] = 101; s.grid[0] = 4; s.army[0] = 25;
  assert.equal(analyzeFFA(s).emergencyMove, null);
});
test('可胜时清除近皇冠威胁', () => {
  const s = defense(); s.grid[0] = 1; s.army[0] = 60;
  const a = analyzeFFA(s); assert.ok(a.emergencyMove);
  assert.equal(a.emergencyMove.dx * s.m + a.emergencyMove.dy, 1);
});
test('墙隔开不可达敌兵不是近皇冠威胁', () => {
  const s = defense(); s.grid[1] = 201; s.army[1] = 0; s.army[3] = 1000;
  assert.equal(analyzeFFA(s).defensiveOwners.has(2), false);
});
test('回合回退重置夺地记忆和目标，实例记忆互相隔离', () => {
  const s = board(); analyzeFFA(s); s.turn = 10; s.grid[3] = 3; s.army[3] = 1;
  assert.ok(analyzeFFA(s).defensiveOwners.has(3));
  assert.equal(analyzeFFA(structuredClone(s)).defensiveOwners.has(3), false);
  s.turn = 0; assert.equal(analyzeFFA(s).defensiveOwners.has(3), false);
});
test('攻击过滤拒绝非目标，允许自有、中立与建造', () => {
  const s = board(), a = analyzeFFA(s);
  for (const [t, p] of [[1, 2], [5, 3], [7, 4]]) assert.equal(acceptFFAAction(s, move(4, t), a), p === a.targetOwner);
  assert.ok(acceptFFAAction(s, move(4, 3), a));
  s.grid[5] = 0; assert.ok(acceptFFAAction(s, move(4, 5), a));
  assert.ok(acceptFFAAction(s, { kind: 'build', x: 1, y: 1 }, a));
});
test('拒绝跨行、非邻接、非自有源和山地', () => {
  const s = board(), a = analyzeFFA(s);
  for (const action of [move(3, 2), move(4, 0), move(1, 4)]) assert.equal(acceptFFAAction(s, action, a), false);
  s.grid[5] = 201; assert.equal(acceptFFAAction(s, move(4, 5), a), false);
});
test('自然增长计入下一tick威胁能力', () => {
  const s = board({ turn: 25 }); s.grid[4] = 51; s.army[4] = 30; s.army[5] = 31;
  assert.ok(analyzeFFA(s).defensiveOwners.has(3));
  s.turn = 24; assert.equal(analyzeFFA(s).defensiveOwners.has(3), false);
});
test('非法输入与结束状态保守返回，支持typed arrays', () => {
  assert.equal(analyzeFFA(null).targetOwner, null); assert.equal(acceptFFAAction(null, move(1, 2)), false);
  assert.equal(analyzeFFA(board({ dead: true })).emergencyMove, null);
  const s = board(); s.grid = Int16Array.from(s.grid); s.army = Int32Array.from(s.army);
  assert.ok(analyzeFFA(s).targetOwner);
});
