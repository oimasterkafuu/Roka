'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseMove } = require('../bot/planner.cjs');
function state(grid, army, m = grid.length, extra = {}) {
  return { n: grid.length / m, m, playerId: 1, grid, army,
    isolated: grid.map(() => false), fog: grid.map(() => false),
    teams: new Map([[1, 1], [2, 2]]), turn: 1, ...extra };
}
function target(move) { return move && [move.dx, move.dy]; }

test('无可动兵力及非法输入返回 null', () => {
  assert.equal(chooseMove(state([101, 200], [1, 0])), null);
  assert.equal(chooseMove(null), null);
  assert.equal(chooseMove({ n: 2, m: 3, playerId: 1, grid: [], army: [] }), null);
});
test('行优先坐标，返回的是目标坐标且智能分兵 mode 0', () => {
  const move = chooseMove(state([201, 201, 1, 200], [0, 0, 8, 0], 2));
  assert.deepEqual(move, { x: 1, y: 0, dx: 1, dy: 1, half: false, mode: 0, reason: '拓地' });
});
test('同队非零不攻击；零队号不是盟友', () => {
  assert.equal(chooseMove(state([1, 102], [20, 1], 2, { teams: new Map([[1, 4], [2, 4]]) })), null);
  assert.equal(chooseMove(state([1, 102], [20, 1], 2, { teams: new Map([[1, 0], [2, 0]]) })).reason, '斩首');
});
test('山与雾障碍不可穿越', () => {
  for (const obstacle of [201, 203])
    assert.equal(chooseMove(state([1, obstacle, 102], [20, 0, 1])), null);
});
test('等兵攻击不能获胜，不能发出消耗式攻击', () => {
  assert.equal(chooseMove(state([1, 0], [6, 5])), null);
  assert.deepEqual(target(chooseMove(state([1, 0], [7, 5]))), [0, 1]);
});
test('mode 0 自动保留其他方向防守兵，不能按全冲误判', () => {
  assert.equal(chooseMove(state([2, 1, 100], [8, 12, 5])), null);
});
test('可获胜斩首优先普通拓地', () => {
  const move = chooseMove(state([200, 1, 102], [0, 20, 3]));
  assert.equal(move.reason, '斩首');
  assert.deepEqual(target(move), [0, 2]);
});
test('可负担的多步斩首通过 BFS 给出第一步', () => {
  const move = chooseMove(state([1, 200, 102], [12, 0, 3]));
  assert.equal(move.reason, '斩首');
  assert.deepEqual(target(move), [0, 1]);
});
test('濒危主城优先接收援军', () => {
  const move = chooseMove(state([1, 101, 2], [20, 2, 8]));
  assert.equal(move.reason, '守主城');
  assert.deepEqual(target(move), [0, 1]);
});
test('主城不为占城而放空防守', () => {
  const s = state([2, 101, 100], [5, 6, 0]);
  const move = chooseMove(s);
  assert.deepEqual(target(move), [0, 2]);
  const enemyPush = s.army[0] - 1;
  const actualPush = Math.min(s.army[1] - 1, s.army[1] - enemyPush - 1);
  assert.ok(s.army[1] - actualPush > enemyPush);
});
test('主城斩首、指挥所破坏与沼泽区别评分', () => {
  assert.equal(chooseMove(state([200, 1, 102], [0,20,2])).reason, '斩首');
  assert.equal(chooseMove(state([200, 1, 52], [0,20,2])).reason, '切断指挥所');
  assert.equal(chooseMove(state([200, 1, 204], [0,20,2])).reason, '拓地');
});
test('境内汇兵到前线，不向内陆倒兵', () => {
  const s = state([1, 1, 1, 2], [20, 1, 1, 50]);
  const move = chooseMove(s);
  assert.equal(move.reason, '前线汇兵');
  assert.deepEqual(target(move), [0, 1]);
  s.army = [1, 20, 1, 50];
  assert.deepEqual(target(chooseMove(s)), [0, 2]);
  s.army = [1, 1, 20, 50];
  assert.equal(chooseMove(s), null);
});
test('孤军不能主动出兵，通过占领连接地回收', () => {
  assert.equal(chooseMove(state([1, 200], [30, 0], 2, { isolated: [true, false] })), null);
  const move = chooseMove(state([1, 200, 1], [20, 0, 30], 3, { isolated: [false, false, true] }));
  assert.equal(move.reason, '打通孤军');
  assert.equal(move.y, 0);
});
test('雾平地可以保守探路，但不能透雾规划斩首', () => {
  const move = chooseMove(state([1, 202, 102], [20, 0, 1]));
  assert.equal(move.reason, '探路');
  assert.deepEqual(target(move), [0, 1]);
  assert.equal(chooseMove(state([1, 202], [3, 0])), null);
});
test('不修改输入，相同局面决策确定', () => {
  const s = state([1, 200, 102], [20, 0, 2]);
  const snapshot = structuredClone(s);
  assert.deepEqual(chooseMove(s), chooseMove(s));
  assert.deepEqual(s, snapshot);
});
test('探索权重可改变拓地与探路选择',()=>{
  const s=state([200,1,202],[0,20,0]);
  assert.equal(chooseMove(s).reason,'拓地');
  assert.equal(chooseMove(s,{explorationWeight:3,expansionWeight:0.3}).reason,'探路');
});
test('极端训练参数不能降低斩首与守城优先级',()=>{
  const p={moveDepthCost:180,explorationWeight:3,expansionWeight:2};
  assert.equal(chooseMove(state([200,1,102],[0,20,3]),p).reason,'斩首');
  assert.equal(chooseMove(state([1,101,2],[20,2,8]),p).reason,'守主城');
});
test('结束或死亡状态不能出兵',()=>{
  for(const extra of [{ended:true},{dead:true}]) assert.equal(chooseMove(state([1,200],[20,0],2,extra)),null);
});
test('无效和未知训练参数不污染默认决策',()=>{
  const s=state([200,1,202],[0,20,0]);
  assert.deepEqual(chooseMove(s,{moveDepthCost:NaN,expansionWeight:Infinity,unknown:100}),chooseMove(s));
});
test('长程斩首计入主城抵达前增长，避免静态足够实际不足',()=>{
 const s=state([1,200,102],[7,0,4],3,{turn:70});
 assert.notEqual(chooseMove(s)?.reason,'斩首');
});
test('邻接敌主城下一tick增长后同兵不占领',()=>{
 const s=state([1,102],[6,4],2,{turn:70});
 assert.notEqual(chooseMove(s)?.reason,'斩首');
});
