'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMovementGuard } = require('../bot/movement-guard.cjs');
const state = () => ({ n: 2, m: 3, playerId: 1, grid: [1, 1, 1, 1, 1, 1], turn: 10 });
const move = (from, to, extra = {}) => ({ kind: 'attack', x: Math.floor(from / 3), y: from % 3,
  dx: Math.floor(to / 3), dy: to % 3, ...extra });
function receipt(s, from, to, turn = s.turn) {
  s.turn = turn;
  s.lastMove = { ...move(from, to), op: 'm', turn };
}

test('确认执行后阻止反向运输并暴露 from:to 边', () => {
  const s = state(); receipt(s, 0, 1);
  const g = createMovementGuard(s);
  assert.equal(g.accept(move(1, 0)), false);
  assert.deepEqual([...g.blockedEdges], ['1:0']);
});
test('连续交替模块动作共享每局记忆', () => {
  const s = state();
  for (let i = 0; i < 5; i++) {
    const planner = createMovementGuard(s);
    assert.equal(planner.accept(move(0, 1)), true);
    planner.finish(move(0, 1));
    receipt(s, 0, 1, 10 + i);
    const logistics = createMovementGuard(s);
    assert.equal(logistics.accept(move(1, 0)), false);
    assert.equal(logistics.accept(move(1, 2)), true);
  }
});
test('finish 仅提交 pending，不把无回执提交当执行', () => {
  const s = state(), g = createMovementGuard(s);
  g.finish(move(0, 1)); s.turn++;
  assert.equal(createMovementGuard(s).accept(move(1, 0)), true);
  assert.equal(g.blockedEdges.size, 0);
});
test('未知及未执行回执不当成功', () => {
  for (const op of [undefined, 'b', 'failed', null]) {
    const s = state(), g = createMovementGuard(s);
    g.finish(move(0, 1)); s.turn++;
    s.lastMove = { ...move(0, 1), op, turn: s.turn };
    assert.equal(g.accept(move(1, 0)), true);
  }
});
test('提交与实际回执不同时以实际执行为准', () => {
  const s = state(), g = createMovementGuard(s);
  g.finish(move(0, 1)); receipt(s, 1, 2, 11);
  assert.equal(g.accept(move(1, 0)), true);
  assert.equal(g.accept(move(2, 1)), false);
});
test('4tick 边界仍阻挡，第5tick 过期', () => {
  const s = state(); receipt(s, 0, 1);
  const g = createMovementGuard(s);
  s.turn = 14; assert.equal(g.accept(move(1, 0)), false);
  s.turn = 15; assert.equal(g.accept(move(1, 0)), true);
  assert.equal(g.blockedEdges.size, 0);
});
test('重复帧不重复登记、不刷新过期时间', () => {
  const s = state(); receipt(s, 0, 1);
  const g = createMovementGuard(s);
  for (let i = 0; i < 20; i++) createMovementGuard(s).finish(move(1, 2));
  s.lastMove = { ...move(1, 2), op: 'm', turn: 10 };
  assert.equal(g.accept(move(2, 1)), true);
  s.turn = 15; assert.equal(g.accept(move(1, 0)), true);
});
test('紧急救城/逃生允许反向但执行后仍记录', () => {
  const s = state(); receipt(s, 0, 1);
  const g = createMovementGuard(s);
  assert.equal(g.accept(move(1, 0, { reason: 'emergency-defense' })), false);
  assert.equal(g.accept(move(1, 0), { emergency: true }), true);
  g.finish(move(1, 0)); receipt(s, 1, 0, 11);
  assert.equal(g.accept(move(0, 1)), false);
});
test('A-B-C-A 连续路径闭环被阻止，不同方向继续前进允许', () => {
  const s = state(); receipt(s, 0, 1);
  const g = createMovementGuard(s);
  receipt(s, 1, 2, 11);
  assert.equal(g.accept(move(2, 0)), false);
  assert.equal(g.accept(move(2, 5)), true);
});
test('近六步连续路径能检测四边环，非连续路径不拼接', () => {
  const s = state(), g = createMovementGuard(s);
  for (const [a, b, t] of [[0, 1, 10], [1, 4, 11], [4, 3, 12]]) {
    receipt(s, a, b, t); void g.blockedEdges;
  }
  assert.equal(g.accept(move(3, 0)), false);
  receipt(s, 2, 5, 13); void g.blockedEdges;
  assert.equal(g.accept(move(3, 0)), true);
});
test('所有权变化使旧运输证据失效，包括之后夺回', () => {
  const s = state(); receipt(s, 0, 1);
  const g = createMovementGuard(s);
  s.grid[0] = 2; s.turn++;
  assert.equal(g.blockedEdges.size, 0);
  s.grid[0] = 1;
  assert.equal(g.accept(move(1, 0)), true);
});
test('不阻碍夺回失地及进攻敌方或中立格', () => {
  for (const code of [2, 102, 200]) {
    const s = state(); receipt(s, 0, 1);
    const g = createMovementGuard(s);
    s.grid[0] = code;
    assert.equal(g.accept(move(1, 0)), true);
  }
});
test('独立局之间不共享记忆', () => {
  const a = state(), b = state(); receipt(a, 0, 1);
  assert.equal(createMovementGuard(a).accept(move(1, 0)), false);
  assert.equal(createMovementGuard(b).accept(move(1, 0)), true);
});
test('turn 回退清空旧记忆并接收新局回执', () => {
  const s = state(); receipt(s, 0, 1);
  const g = createMovementGuard(s);
  s.turn = 0; s.lastMove = null;
  assert.equal(g.accept(move(1, 0)), true);
  receipt(s, 1, 2, 1);
  assert.equal(g.accept(move(2, 1)), false);
});
test('非法坐标、缺失turn、未来回执不登记', () => {
  for (const extra of [{ x: -1 }, { dy: 3 }, { y: 0.5 }, { turn: undefined }, { turn: 11 }]) {
    const s = state(); receipt(s, 0, 1); Object.assign(s.lastMove, extra);
    assert.equal(createMovementGuard(s).blockedEdges.size, 0);
  }
});
test('自有建筑也属于运输，队友及雾格不作为证据', () => {
  const s = state(); s.grid[0] = 101; s.grid[1] = 51; receipt(s, 0, 1);
  assert.equal(createMovementGuard(s).accept(move(1, 0)), false);
  const b = state(); b.grid[0] = 3; receipt(b, 0, 1);
  assert.equal(createMovementGuard(b).blockedEdges.size, 0);
  const c = state(); c.fog = [true]; receipt(c, 0, 1);
  assert.equal(createMovementGuard(c).blockedEdges.size, 0);
});
test('守卫不修改 state，建筑及空动作处理稳定', () => {
  const s = state(); receipt(s, 0, 1);
  Object.freeze(s.grid); Object.freeze(s.lastMove); Object.freeze(s);
  const before = JSON.stringify(s), g = createMovementGuard(s);
  assert.equal(g.accept({ kind: 'build', x: 0, y: 0 }), true);
  assert.equal(g.accept(null), false);
  g.finish(move(1, 2)); void g.blockedEdges;
  assert.equal(JSON.stringify(s), before);
});
