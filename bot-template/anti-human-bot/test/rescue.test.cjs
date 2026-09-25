'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseRescue } = require('../bot/rescue.cjs');
function board(grid, army, isolated, m = grid.length) {
  return { n: grid.length / m, m, grid, army, isolated, fog: grid.map(() => 0), playerId: 1, turn: 60 };
}
const large = () => board([1, 0, 1], [40, 2, 100], [0, 0, 1]);
test('一步占桥救大团，标准动作不带 kind', () => {
  const move = chooseRescue(large());
  assert.deepEqual({ ...move, reason: '' }, { x: 0, y: 0, dx: 0, dy: 1, half: false, mode: 0, reason: '' });
  assert.match(move.reason, /救援.*1步/);
});
test('弱团不值得动用兵源', () => {
  const s = large(); s.army[2] = 3;
  assert.equal(chooseRescue(s), null);
});
test('多步最短可胜路径，逐格留兵', () => {
  const s = board([1, 0, 0, 1], [30, 3, 4, 100], [0, 0, 0, 1]);
  assert.match(chooseRescue(s).reason, /2步/);
});
test('不能把未来增长当作当前可用兵力', () => {
  const s = board([1, 0, 0, 1], [4, 1, 2, 100], [0, 0, 0, 1]);
  assert.equal(chooseRescue(s), null);
});
test('敌城自然增长使第二步无法获胜', () => {
  const s = board([1, 0, 102, 1], [8, 1, 4, 100], [0, 0, 0, 1]);
  assert.equal(chooseRescue(s), null);
});
test('未知孤立年龄只使用当前兵，忽略虚构历史兵量', () => {
  const s = large(); s.army[2] = 3; s.originalArmy = [40, 2, 10000];
  assert.equal(chooseRescue(s), null);
  delete s.originalArmy; s.army[2] = 100;
  assert.ok(chooseRescue(s));
});
test('正常己格中继可以是第一步', () => {
  const s = board([1, 1, 0, 1], [50, 1, 10, 100], [0, 0, 0, 1]);
  assert.equal(chooseRescue(s).dy, 1);
  assert.match(chooseRescue(s).reason, /2步/);
});
test('孤立格不可作为出兵源', () => {
  const s = large(); s.isolated[0] = 1;
  assert.equal(chooseRescue(s), null);
});
test('挡路第三方不在 allowedOwners 则不可攻击', () => {
  const s = large(); s.grid[1] = 3;
  assert.equal(chooseRescue(s, { allowedOwners: new Set([2]) }), null);
  assert.ok(chooseRescue(s, { allowedOwners: new Set([3]) }));
  s.allowedOwners = new Set([2]);
  assert.equal(chooseRescue(s, { allowedOwners: new Set([3]) }), null);
});
test('mode0 智能留兵不能按全冲估算', () => {
  const s = board([2, 1, 0, 1], [25, 30, 5, 100], [0, 0, 0, 1]);
  assert.equal(chooseRescue(s), null);
  s.army[0] = 1;
  assert.equal(chooseRescue(s).mode, 0);
});
test('另一个方向已能攻击同敌，提高救援机会成本', () => {
  const s = board([201, 201, 201, 201, 1, 2, 1, 201, 201, 201, 2, 1],
    [0, 0, 0, 0, 30, 2, 30, 0, 0, 0, 1, 1],
    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], 4);
  assert.ok(chooseRescue(s));
  s.army[11] = 20;
  assert.equal(chooseRescue(s), null);
});
test('实时断路和 blockedEdges 立即撤销，不缓存长期路径', () => {
  const s = large(); assert.ok(chooseRescue(s));
  s.grid[1] = 201; assert.equal(chooseRescue(s), null);
  s.grid[1] = 0;
  assert.equal(chooseRescue(s, { blockedEdges: new Set(['0:1']) }), null);
  s.blockedEdges = new Set(['0:1']); assert.equal(chooseRescue(s), null);
});
test('迷雾和未知格不走', () => {
  const s = large(); s.fog[1] = 1; assert.equal(chooseRescue(s), null);
  s.fog[1] = 0; s.grid[1] = 202; assert.equal(chooseRescue(s), null);
});
test('高损失即使可胜也放弃', () => {
  const s = large(); s.army = [200, 100, 100];
  assert.equal(chooseRescue(s), null);
});
test('近敌反击可能夺回桥则放弃', () => {
  const s = board([1, 0, 1, 201, 2, 201], [30, 2, 100, 0, 40, 0], [0, 0, 1, 0, 0, 0], 3);
  assert.equal(chooseRescue(s), null);
});
test('主城无威胁也不抽空只留一兵', () => {
  const s = large(); s.grid[0] = 101;
  assert.equal(chooseRescue(s), null);
});
test('四邻孤立组件合计收益', () => {
  const s = board([1, 0, 1, 1], [30, 5, 15, 85], [0, 0, 1, 1]);
  assert.ok(chooseRescue(s));
});
test('对角孤立兵不能合并为被救组件', () => {
  const s = board([1, 0, 1, 201, 201, 201, 201, 1],
    [30, 5, 3, 0, 0, 0, 0, 100], [0, 0, 1, 0, 0, 0, 0, 1], 4);
  assert.equal(chooseRescue(s), null);
});
test('预算、步数硬上限以及非法状态安全退出', () => {
  assert.equal(chooseRescue(large(), { rescueBudget: 0 }), null);
  assert.equal(chooseRescue(large(), { rescueMaxSources: 0 }), null);
  const s = board([1, 0, 0, 0, 0, 0, 0, 0, 1], [100, 0, 0, 0, 0, 0, 0, 0, 1000], [0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(chooseRescue(s, { rescueMaxSteps: 100 }), null);
  assert.equal(chooseRescue(null), null);
  assert.equal(chooseRescue({ ...large(), dead: true }), null);
});
test('输入数组和参数不被修改', () => {
  const s = large(), before = structuredClone(s);
  chooseRescue(s); assert.deepEqual(s, before);
});

test('短期重连可扛住单次反击且大团有下一步攻击时，不因合计反击否决',()=>{
 const s=board([201,2,201,201, 1,200,1,2, 201,2,201,201],
 [0,35,0,0, 60,0,1000,10, 0,35,0,0], [0,0,0,0,0,0,1,0,0,0,0,0],4);
 const a=chooseRescue(s);assert.ok(a);assert.equal(a.rescueWindow?.temporary,true);
 s.army[1]=80;assert.equal(chooseRescue(s),null);
});
