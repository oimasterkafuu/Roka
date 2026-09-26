'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {chooseAction}=require('../bot/policy.cjs');
function s(turn){const grid=Array(25).fill(1),army=Array(25).fill(1);grid[0]=101;grid[14]=200;army[12]=130;return {n:5,m:5,playerId:1,turn,grid,army,isolated:Array(25).fill(0),fog:Array(25).fill(0),teams:new Map([[1,1]])};}
test('开局及爆发阶段即使有建设资金也不建设',()=>{for(const turn of [0,25,26,35,49]){const a=chooseAction(s(turn));assert.notEqual(a?.kind,'build');}});
test('爆发直接扩张不能被运输经济覆盖',()=>{const b=s(30);b.army[13]=4;const a=chooseAction(b);assert.equal(a.kind,'attack');assert.equal(a.dx,2);assert.equal(a.dy,4);assert.match(a.reason,/爆发/);});
test('FFA统一出口不主动攻击其他目标，开局与中期一致',()=>{
 const {analyzeFFA,acceptFFAAction}=require('../bot/ffa.cjs');
 for(const turn of [20,30,80,140]){
  const s={n:3,m:3,playerId:1,turn,grid:[102,2,103,1,101,3,104,4,1],army:[5,2,5,20,30,2,5,2,20],isolated:Array(9).fill(0),fog:Array(9).fill(0),teams:new Map()};
  const analysis=analyzeFFA(s),a=chooseAction(s);if(a)assert.ok(acceptFFAAction(s,a,analysis));
 }
});
test('实际回执已将后方兵送到B时，完整策略不得立即B回A',()=>{
 const s={n:1,m:5,playerId:1,turn:80,grid:[101,1,1,200,102],army:[10,1,25,0,10],isolated:[0,0,0,0,0],fog:[0,0,0,0,0],teams:new Map([[1,1],[2,2]]),lastMove:{x:0,y:1,dx:0,dy:2,op:'m',turn:80}};
 const a=chooseAction(s);assert.ok(!a||a.kind!=='attack'||!(a.y===2&&a.dy===1));
});

test('保底：没有前线可打时，后方攒够 50 兵就直接建皇冠', () => {
  // 全图无敌情 → 补给/进攻都不成立，只剩保底建造
  const s = { n: 1, m: 5, turn: 900, playerId: 1, grid: [101, 1, 1, 1, 1],
    army: [5, 300, 1, 1, 1], isolated: Array(5).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const a = chooseAction(s);
  assert.ok(a, '不允许空动作');
  assert.equal(a.kind, 'build');
  assert.equal(a.op, 'b');
  assert.equal(a.y, 1);
});

test('保底：没有建造资金时也要把后方兵力向前线搬一步', () => {
  const s = { n: 1, m: 6, turn: 900, playerId: 1, grid: [101, 1, 1, 1, 1, 2],
    army: [5, 40, 1, 1, 1, 5000], isolated: Array(6).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const a = chooseAction(s);
  assert.ok(a, '不允许空动作');
  assert.equal(a.kind, 'attack');
  assert.equal(a.y, 1);
  assert.ok(a.dy > a.y, '必须朝前线方向');
});

test('保底：前线巨堆打不动时横向汇兵，不后退也不空转', () => {
  const s = { n: 2, m: 4, turn: 900, playerId: 1,
    grid: [101, 1, 1, 2, 1, 1, 1, 2], army: [5, 3000, 1, 90000, 1, 1, 1, 90000],
    isolated: Array(8).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const a = chooseAction(s);
  assert.ok(a, '不允许空动作');
  assert.equal(a.kind, 'attack');
  const from = a.x * 4 + a.y, to = a.dx * 4 + a.dy;
  assert.equal(s.grid[from] % 50, 1, '只能从己方格出发');
  assert.equal(s.grid[to] % 50, 1, '保底不越界进攻');
});

test('保底不会用来白送主城：源点留守规则仍然生效', () => {
  const s = { n: 1, m: 4, turn: 900, playerId: 1, grid: [101, 2, 2, 2],
    army: [1, 900, 900, 900], isolated: Array(4).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const a = chooseAction(s);
  assert.ok(!a || a.kind !== 'attack' || a.y !== 0, '主城 1 兵不打仗');
});
