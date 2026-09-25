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
